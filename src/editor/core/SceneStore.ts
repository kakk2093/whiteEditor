import * as THREE from "three";
import {
    applyEnvironment,
    createComponentObject,
    createDefaultScene,
    createEntity,
    createEntityObject,
    defaultEnvironment,
    generateId,
    Registry,
    Runtime
} from "../../engine";
import type { ComponentData, EntityData, EnvironmentData, ParamValue, Params, PrefabData, SceneData } from "../../engine";

type Listener = () => void;

export type TransformProperty = "position" | "rotation" | "scale";

export type GizmoMode = "translate" | "rotate" | "scale";

export interface AssetRef {
    kind: "material" | "model" | "scene" | "prefab";
    name: string;
}

const AXES = ["x", "y", "z"] as const;

// Keeps gizmo results free of float noise, so scene files stay readable and diff well
const round = (value: number) => Math.round(value * 10000) / 10000;

function disposeObject(obj: THREE.Object3D) {
    obj.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.geometry) return;
        mesh.geometry.dispose();
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        // Material assets are shared between meshes and owned by the registry
        materials.forEach((m) => {
            if (!m.userData.shared) m.dispose();
        });
    });
}

function findEntity(
    list: EntityData[],
    id: string,
    parent: EntityData | null = null
): { entity: EntityData; parent: EntityData | null; siblings: EntityData[] } | null {
    for (const entity of list) {
        if (entity.id === id) return { entity, parent, siblings: list };
        const found = findEntity(entity.children, id, entity);
        if (found) return found;
    }
    return null;
}

// A deep copy in which every entity gets a new id
function cloneWithNewIds(entity: EntityData): EntityData {
    return {
        ...structuredClone({ ...entity, children: [] }),
        id: generateId(),
        children: entity.children.map(cloneWithNewIds),
    };
}

export function getComponent(entity: EntityData, type: string) {
    return entity.components.find((c) => c.type === type) ?? null;
}

// An entity can have several script components, one per behavior
export function getScript(entity: EntityData, script: string) {
    return entity.components.find((c) => c.type === "script" && c.script === script) ?? null;
}

// Lights and cameras draw nothing, so the editor gives them a clickable marker
function createHelper(entity: EntityData): THREE.Object3D | null {
    const light = getComponent(entity, "light");
    const camera = getComponent(entity, "camera");
    if (!light && !camera) return null;

    const helper = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({ color: light ? 0xffd54a : 0x9ecbff, wireframe: true, fog: false });

    if (light) {
        helper.add(new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6), material));
    } else {
        // A pyramid opening towards -Z, like a camera frustum
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.35, 4), material);
        cone.rotation.set(Math.PI / 2, Math.PI / 4, 0);
        helper.add(cone);
    }

    // Shows where a directional or spot light points
    if (light && light.kind !== "point") {
        const points = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)];
        helper.add(new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(points),
            new THREE.LineBasicMaterial({ color: 0xffd54a, fog: false })
        ));
    }

    helper.userData.editorHelper = true;
    return helper;
}

class SceneStore {
    // Models, materials and prefabs of the open project
    registry = new Registry();

    scene: THREE.Scene;

    // Holds the entity objects; the gizmo and other editor helpers live outside of it
    root = new THREE.Group();

    // Source of truth (a tree); three.js objects are built from it
    entities: EntityData[] = [];

    environment: EnvironmentData = { ...defaultEnvironment };

    selectedId: string | null = null;

    // An asset picked in the Project panel; shown in the Inspector instead of an entity
    selectedAsset: AssetRef | null = null;

    gizmoMode: GizmoMode = "translate";

    // The open project and scene; changed through actions.ts
    project = "";

    projects: string[] = [];

    sceneName = "main";

    scenes: string[] = [];

    status = "";

    // Name of the prefab being edited: its root is then the only entity, and the scene waits in `stash`
    editingPrefab: string | null = null;

    private stash: { entities: EntityData[]; environment: EnvironmentData; savedSnapshot: string } | null = null;

    // A prefab has no lights of its own, so it gets one while it is being edited
    private prefabLight = new THREE.DirectionalLight(0xffffff, 2.5);

    // What is on disk, to tell whether there are unsaved changes
    private savedSnapshot = "";

    // Play mode: the behaviors of the scene are running
    private runtime: Runtime | null = null;

    // The scene as it was when Play was pressed; stop() brings it back
    private playSnapshot: { json: string; selectedId: string | null } | null = null;

    // Bumped on every change, lets React treat the store as an external store
    version = 0;

    private objects = new Map<string, THREE.Object3D>();

    private listeners: Listener[] = [];

    // true while the right mouse button is held in the viewport: W/A/S/D then fly the camera
    // instead of switching tools. Not part of the rendered state, so changing it notifies nobody.
    flying = false;

    // Set by the Viewport: moves the editor camera to look at an object
    focusHandler: ((obj: THREE.Object3D) => void) | null = null;

    constructor() {
        this.scene = new THREE.Scene();
        this.scene.add(this.root);
        this.prefabLight.position.set(3, 6, 4);
        applyEnvironment(this.scene, this.environment);
    }

    subscribe = (fn: Listener) => {
        this.listeners.push(fn);
        return () => {
            this.listeners = this.listeners.filter(l => l !== fn);
        };
    };

    getVersion = () => this.version;

    private notify() {
        this.version++;
        this.listeners.forEach((fn) => fn());
    }

    get selected() {
        return this.selectedId ? findEntity(this.entities, this.selectedId)?.entity ?? null : null;
    }

    findEntity(id: string) {
        return findEntity(this.entities, id)?.entity ?? null;
    }

    get selectedObject() {
        return this.selectedId ? this.objects.get(this.selectedId) ?? null : null;
    }

    // Registers the objects of the entity and its children and gives them editor helpers
    private adopt(entity: EntityData, obj: THREE.Object3D) {
        const byId = new Map<string, THREE.Object3D>();
        obj.traverse((child) => {
            if (child.userData.entityId) byId.set(child.userData.entityId, child);
        });

        const visit = (e: EntityData) => {
            const o = byId.get(e.id);
            if (o) {
                this.objects.set(e.id, o);
                this.updateHelper(e);
            }
            e.children.forEach(visit);
        };
        visit(entity);
    }

    private unindexObjects(obj: THREE.Object3D) {
        obj.traverse((child) => {
            if (child.userData.entityId) this.objects.delete(child.userData.entityId);
        });
    }

    private updateHelper(entity: EntityData) {
        const obj = this.objects.get(entity.id);
        if (!obj) return;

        const old = obj.children.find((c) => c.userData.editorHelper);
        if (old) {
            obj.remove(old);
            disposeObject(old);
        }
        const helper = createHelper(entity);
        if (helper) obj.add(helper);
    }

    // Rebuilds every three.js object from the entity data
    private rebuild() {
        [...this.root.children].forEach((obj) => {
            this.root.remove(obj);
            disposeObject(obj);
        });
        this.objects.clear();

        for (const entity of this.entities) {
            const obj = createEntityObject(this.registry, entity);
            this.root.add(obj);
            this.adopt(entity, obj);
        }

        // The running behaviors held the old objects, e.g. after a script was edited during Play
        if (this.playing) this.startRuntime();
    }

    get playing() {
        return this.playSnapshot !== null;
    }

    private startRuntime() {
        const runtime = new Runtime(this.registry, this.root);
        runtime.onError = (message) => this.update({ status: message });
        this.runtime = runtime;
        runtime.start();
    }

    // Starts the behaviors. Whatever happens to the scene until stop(), by scripts or by hand, is not kept.
    play() {
        if (this.playing) return;
        this.playSnapshot = { json: JSON.stringify(this.toJSON()), selectedId: this.selectedId };
        this.status = "";
        this.startRuntime();
        const count = this.runtime?.count ?? 0;
        // A script that failed in start() has already written its own message
        if (!this.status) {
            this.status = count > 0
                ? `Playing: ${count} script${count === 1 ? "" : "s"} running. Changes made now are dropped on Stop.`
                : "Playing, but no object has a script. Add one with Add Component in the Inspector.";
        }
        this.notify();
    }

    stop() {
        if (!this.playSnapshot) return;
        const { json, selectedId } = this.playSnapshot;
        this.playSnapshot = null;
        this.runtime = null;

        const data = JSON.parse(json) as SceneData;
        this.entities = data.entities;
        this.environment = { ...defaultEnvironment, ...data.environment };
        applyEnvironment(this.scene, this.environment);
        this.rebuild();
        this.selectedId = selectedId && this.objects.has(selectedId) ? selectedId : null;
        this.status = "Stopped";
        this.notify();
    }

    // Called by the Viewport every frame
    tick(dt: number) {
        this.runtime?.update(dt);
    }

    private syncScripts(entity: EntityData) {
        const obj = this.objects.get(entity.id);
        if (!obj) return;
        const scripts = entity.components.filter((c) => c.type === "script");
        if (scripts.length > 0) obj.userData.scripts = scripts;
        else delete obj.userData.scripts;
    }

    // Replaces the three.js object of one component after its data changed
    private rebuildComponent(entity: EntityData, type: string) {
        const obj = this.objects.get(entity.id);
        if (!obj) return;

        const old = obj.children.find((c) => c.userData.component === type);
        if (old) {
            obj.remove(old);
            disposeObject(old);
        }
        const component = getComponent(entity, type);
        const created = component && createComponentObject(this.registry, component);
        if (created) obj.add(created);
        this.updateHelper(entity);
    }

    private uniqueName(base: string) {
        const names = new Set<string>();
        const collect = (list: EntityData[]) => list.forEach((e) => {
            names.add(e.name);
            collect(e.children);
        });
        collect(this.entities);

        if (!names.has(base)) return base;
        const stem = base.replace(/ \(\d+\)$/, "");
        let n = 1;
        while (names.has(`${stem} (${n})`)) n++;
        return `${stem} (${n})`;
    }

    // Where a new entity may go: a prefab keeps a single root, and an instance has no children of its own
    private resolveParent(parentId: string | null) {
        let parent = parentId ? findEntity(this.entities, parentId)?.entity ?? null : null;
        if (parent?.prefab) parent = findEntity(this.entities, parent.id)?.parent ?? null;
        if (!parent && this.editingPrefab) parent = this.entities[0] ?? null;
        return parent;
    }

    // Puts a ready entity (with its children) into the scene
    insertEntity(entity: EntityData, parentId: string | null = null) {
        entity.name = this.uniqueName(entity.name);
        const parent = this.resolveParent(parentId);
        (parent ? parent.children : this.entities).push(entity);

        const obj = createEntityObject(this.registry, entity);
        (parent ? this.objects.get(parent.id)! : this.root).add(obj);
        this.adopt(entity, obj);
        this.notify();
        return entity;
    }

    addEntity(name: string, components: ComponentData[] = [], parentId: string | null = null) {
        return this.insertEntity(createEntity(name, components), parentId);
    }

    duplicate(id: string) {
        const found = findEntity(this.entities, id);
        // The root of a prefab stays the only root
        if (!found || (this.editingPrefab && !found.parent)) return null;
        return this.insertEntity(cloneWithNewIds(found.entity), found.parent?.id ?? null);
    }

    removeEntity(id: string) {
        const found = findEntity(this.entities, id);
        const obj = this.objects.get(id);
        if (!found || !obj) return;
        if (this.editingPrefab && !found.parent) return;

        found.siblings.splice(found.siblings.indexOf(found.entity), 1);
        obj.removeFromParent();
        this.unindexObjects(obj);
        disposeObject(obj);
        if (this.selectedId && !this.objects.has(this.selectedId)) {
            this.selectedId = null;
        }
        this.notify();
    }

    // Moves the entity under another parent (null = scene root), keeping its place in the world
    reparent(id: string, parentId: string | null) {
        const found = findEntity(this.entities, id);
        const obj = this.objects.get(id);
        if (!found || !obj || id === parentId) return;
        if (this.editingPrefab && !found.parent) return;
        // An entity cannot become a child of its own descendant
        if (parentId && findEntity(found.entity.children, parentId)) return;

        const parent = this.resolveParent(parentId);
        if (parent === found.entity || parent === found.parent) return;

        found.siblings.splice(found.siblings.indexOf(found.entity), 1);
        (parent ? parent.children : this.entities).push(found.entity);

        (parent ? this.objects.get(parent.id)! : this.root).attach(obj);
        this.syncFromObject(id);
    }

    // Selects the entity (the selected one by default) and brings the editor camera to it
    focus(id: string | null = this.selectedId) {
        const obj = id ? this.objects.get(id) : null;
        if (!id || !obj) return;
        if (id !== this.selectedId) this.select(id);
        this.focusHandler?.(obj);
    }

    select(id: string | null) {
        this.selectedId = id;
        this.selectedAsset = null;
        this.notify();
    }

    selectAsset(asset: AssetRef | null) {
        this.selectedAsset = asset;
        this.selectedId = null;
        this.notify();
    }

    setGizmoMode(mode: GizmoMode) {
        this.gizmoMode = mode;
        this.notify();
    }

    // Changes editor state (project, scene name, status...) and re-renders the panels
    update(patch: Partial<Pick<SceneStore, "project" | "projects" | "sceneName" | "scenes" | "status">>) {
        Object.assign(this, patch);
        this.notify();
    }

    // For changes made directly in the registry, e.g. a material edit
    changed() {
        this.notify();
    }

    setTransform(id: string, property: TransformProperty, axis: 0 | 1 | 2, value: number) {
        const entity = findEntity(this.entities, id)?.entity;
        const obj = this.objects.get(id);
        if (!entity || !obj) return;
        entity[property][axis] = value;
        // The data keeps rotation in degrees
        obj[property][AXES[axis]] = property === "rotation" ? THREE.MathUtils.degToRad(value) : value;
        this.notify();
    }

    // Copies the transform changed by the gizmo back into the entity data
    syncFromObject(id: string) {
        const entity = findEntity(this.entities, id)?.entity;
        const obj = this.objects.get(id);
        if (!entity || !obj) return;
        entity.position = [round(obj.position.x), round(obj.position.y), round(obj.position.z)];
        entity.rotation = [
            round(THREE.MathUtils.radToDeg(obj.rotation.x)),
            round(THREE.MathUtils.radToDeg(obj.rotation.y)),
            round(THREE.MathUtils.radToDeg(obj.rotation.z))
        ];
        entity.scale = [round(obj.scale.x), round(obj.scale.y), round(obj.scale.z)];
        this.notify();
    }

    rename(id: string, name: string) {
        const entity = findEntity(this.entities, id)?.entity;
        const obj = this.objects.get(id);
        if (!entity || !obj) return;
        entity.name = name;
        obj.name = name;
        this.notify();
    }

    setActive(id: string, active: boolean) {
        const entity = findEntity(this.entities, id)?.entity;
        const obj = this.objects.get(id);
        if (!entity || !obj) return;
        if (active) delete entity.active;
        else entity.active = false;
        obj.visible = active;
        this.notify();
    }

    addComponent(id: string, type: string) {
        const entity = findEntity(this.entities, id)?.entity;
        if (!entity || entity.prefab || getComponent(entity, type)) return;
        entity.components.push({ type });
        this.rebuildComponent(entity, type);
        this.notify();
    }

    removeComponent(id: string, type: string) {
        const entity = findEntity(this.entities, id)?.entity;
        if (!entity) return;
        entity.components = entity.components.filter((c) => c.type !== type);
        this.rebuildComponent(entity, type);
        this.notify();
    }

    setComponentField(id: string, type: string, key: string, value: ParamValue) {
        const entity = findEntity(this.entities, id)?.entity;
        const component = entity && getComponent(entity, type);
        if (!entity || !component) return;
        component[key] = value;
        // Another code model has other params
        if (type === "model" && key === "model") component.params = {};
        this.rebuildComponent(entity, type);
        this.notify();
    }

    setModelParam(id: string, key: string, value: ParamValue) {
        const entity = findEntity(this.entities, id)?.entity;
        const component = entity && getComponent(entity, "model");
        if (!entity || !component) return;
        component.params = { ...(component.params as Params | undefined), [key]: value };
        this.rebuildComponent(entity, "model");
        this.notify();
    }

    addScript(id: string, script: string) {
        const entity = findEntity(this.entities, id)?.entity;
        if (!entity || entity.prefab || getScript(entity, script)) return;
        entity.components.push({ type: "script", script });
        this.syncScripts(entity);
        this.notify();
    }

    removeScript(id: string, script: string) {
        const entity = findEntity(this.entities, id)?.entity;
        if (!entity) return;
        entity.components = entity.components.filter((c) => !(c.type === "script" && c.script === script));
        this.syncScripts(entity);
        this.notify();
    }

    // Takes effect the next time Play is pressed
    setScriptParam(id: string, script: string, key: string, value: ParamValue) {
        const entity = findEntity(this.entities, id)?.entity;
        const component = entity && getScript(entity, script);
        if (!component) return;
        component.params = { ...(component.params as Params | undefined), [key]: value };
        this.notify();
    }

    setEnvironment<K extends keyof EnvironmentData>(key: K, value: EnvironmentData[K]) {
        this.environment[key] = value;
        applyEnvironment(this.scene, this.environment);
        this.notify();
    }

    // Turns the entity into an instance of the prefab (which was just made out of it)
    convertToInstance(id: string, prefab: string) {
        const entity = findEntity(this.entities, id)?.entity;
        if (!entity) return;
        entity.prefab = prefab;
        entity.components = [];
        entity.children = [];
        this.rebuild();
        this.notify();
    }

    // The opposite: the instance becomes an ordinary entity with its own copy of the prefab content
    unpack(id: string) {
        const entity = findEntity(this.entities, id)?.entity;
        const root = entity?.prefab ? this.registry.getPrefab(entity.prefab) : null;
        if (!entity || !root) return;
        const copy = cloneWithNewIds(root);
        delete entity.prefab;
        entity.components = copy.components;
        entity.children = copy.children;
        this.rebuild();
        this.notify();
    }

    // Called when the project scripts or assets were (re)loaded
    setRegistry(registry: Registry) {
        this.registry = registry;
        this.rebuild();
        this.notify();
    }

    toJSON(): SceneData {
        return { version: 3, environment: this.environment, entities: this.entities };
    }

    // What is saved to prefabs/<name>.json while a prefab is being edited
    prefabJSON(): PrefabData {
        return { version: 3, root: { ...this.entities[0], position: [0, 0, 0] } };
    }

    get dirty() {
        // What changes during Play is not going to be kept
        return (this.playSnapshot?.json ?? JSON.stringify(this.toJSON())) !== this.savedSnapshot;
    }

    // Call after the scene (or the prefab being edited) was written to disk
    markSaved() {
        this.savedSnapshot = JSON.stringify(this.toJSON());
        this.notify();
    }

    private show(entities: EntityData[], environment: EnvironmentData) {
        this.selectedId = null;
        this.selectedAsset = null;
        this.entities = entities;
        this.environment = environment;
        applyEnvironment(this.scene, this.environment);
        this.rebuild();
    }

    load(data: SceneData) {
        this.stop();
        this.show(structuredClone(data.entities), { ...defaultEnvironment, ...data.environment });
        this.savedSnapshot = JSON.stringify(this.toJSON());
        this.notify();
    }

    newScene() {
        this.load(createDefaultScene());
    }

    // Shows the prefab alone, as a small scene; the real scene is kept aside until closePrefab()
    openPrefab(name: string) {
        const root = this.registry.getPrefab(name);
        if (!root) return;
        this.stop();
        if (!this.editingPrefab) {
            this.stash = { entities: this.entities, environment: this.environment, savedSnapshot: this.savedSnapshot };
        }
        this.show([{ ...structuredClone(root), position: [0, 0, 0] }], { ...defaultEnvironment });
        this.scene.add(this.prefabLight);
        this.editingPrefab = name;
        this.selectedId = this.entities[0].id;
        this.savedSnapshot = JSON.stringify(this.toJSON());
        this.notify();
    }

    closePrefab() {
        if (!this.editingPrefab || !this.stash) return;
        this.stop();
        this.scene.remove(this.prefabLight);
        this.editingPrefab = null;
        this.show(this.stash.entities, this.stash.environment);
        this.savedSnapshot = this.stash.savedSnapshot;
        this.stash = null;
        this.notify();
    }
}

export const sceneStore = new SceneStore();
