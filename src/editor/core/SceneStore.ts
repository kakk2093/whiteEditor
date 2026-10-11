import * as THREE from "three";
import {
    applyEnvironment,
    componentDefs,
    componentKey,
    createDefaultScene,
    createEntity,
    createEntityObject,
    defaultEnvironment,
    disposeObject,
    findComponent,
    Game,
    generateId,
    rebuildComponentObject,
    Registry
} from "../../engine";
import type { ComponentData, EntityData, EnvironmentData, ParamValue, Params, PrefabData, SceneData } from "../../engine";

type Listener = () => void;

export type TransformProperty = "position" | "rotation" | "scale";

export type GizmoMode = "translate" | "rotate" | "scale";

export interface AssetRef {
    kind: "material" | "model" | "scene" | "prefab" | "look";
    name: string;
}

const AXES = ["x", "y", "z"] as const;

// Keeps gizmo results free of float noise, so scene files stay readable and diff well
const round = (value: number) => Math.round(value * 10000) / 10000;

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

// `key` is what componentKey() gives: the type, or "script:<behavior>" for the types an entity can have several of
export const getComponent = findComponent;

// The three.js layer of what only the editor shows inside the scene: the grid, the markers of lights and
// cameras. The viewport draws this layer after the look of the scene, sharp and untouched by its effects.
export const EDITOR_LAYER = 1;

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
    helper.traverse((part) => part.layers.set(EDITOR_LAYER));
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

    // Play mode: a running copy of the scene, built by the same engine code as the game.
    // Edits made during Play go both to the scene data and to that copy.
    private game: Game | null = null;

    // The scene as it was when Play was pressed: tells whether it was edited since, and brings it back
    private playSnapshot: string | null = null;

    // true while Stop is asking whether to keep the edits made during Play
    confirmingStop = false;

    // The two views of a running scene, like Unity's tabs. "game": through the camera of the scene, the
    // keyboard and the mouse go to the scripts, it looks and plays as the built game. "editor" (Scene):
    // the editor's free camera with selection and the gizmo. The scene runs in both, and the Hierarchy and
    // the Inspector edit it in both.
    playCamera: "editor" | "game" = "game";

    // Play is on, but time stands still; step() moves it by one frame
    paused = false;

    // false draws the viewport without the look of the scene: arranging objects in a pixelated picture is hard.
    // The game itself always has its look.
    lookEnabled = true;

    // Counts how often the scene data was put back by stop(); a field being typed in must then forget its text
    restores = 0;

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
    }

    get playing() {
        return this.game !== null;
    }

    // What the viewport draws: the running game during Play, otherwise the scene being edited
    get viewScene() {
        return this.game?.scene ?? this.scene;
    }

    setLookEnabled(enabled: boolean) {
        this.lookEnabled = enabled;
        this.notify();
    }

    setPlayCamera(camera: "editor" | "game") {
        this.playCamera = camera;
        this.notify();
    }

    // true if the running scene has a camera to look through
    get hasGameCamera() {
        return !!this.game?.camera;
    }

    // true while the viewport shows the game exactly as its own camera sees it and the keyboard and the mouse
    // go to its scripts; the editor camera, selection by click and the gizmo are then off.
    // Pause leaves it: the viewport is the full editor again (orbit, fly, select, gizmo) until the game resumes.
    get gameView() {
        return this.playCamera === "game" && this.hasGameCamera && !this.paused;
    }

    // The input of the running scene while it is to hear the keyboard and the mouse
    get gameInput() {
        return this.game && this.gameView ? this.game.input : null;
    }

    // The camera of the running scene fitted to a viewport of this size, or null if the editor camera is in use
    gameCamera(width: number, height: number) {
        if (!this.game || !this.gameView) return null;
        this.game.resize(width, height);
        return this.game.camera;
    }

    // The entity objects the viewport picks from
    get viewRoot() {
        return this.game?.root ?? this.root;
    }

    // The game reads the scene data without copying it, so script params edited during Play apply at once
    private startGame() {
        this.game?.dispose();
        const game = new Game(this.registry, this.toJSON());
        game.runtime.onError = (message) => this.update({ status: message });
        this.game = game;
        game.start();
    }

    // Objects were added, removed or moved in the tree during Play: the running copy is built again
    private restartGame() {
        if (this.game) this.startGame();
    }

    // Runs a copy of the scene with its behaviors. The scene can still be edited; stop() decides what
    // happens to those edits.
    play() {
        if (this.playing || this.editingPrefab) return;
        this.playSnapshot = JSON.stringify(this.toJSON());
        this.status = "";
        this.paused = false;
        // Play starts the way the game does; the Scene view is one click away
        this.playCamera = "game";
        this.startGame();
        // A script that failed in start() has already written its own message
        if (!this.status) {
            this.status = this.hasGameCamera
                ? "Playing in the Game view: keys and mouse go to the game. Switch to Scene to select and move objects."
                : "Playing in the Scene view: the scene has no active Camera, so there is no Game view.";
        }
        this.notify();
    }

    // true if the scene was edited since Play was pressed
    get playChanged() {
        return this.playSnapshot !== null && JSON.stringify(this.toJSON()) !== this.playSnapshot;
    }

    // The Stop button: asks first if there are edits made during Play
    requestStop() {
        if (!this.playing) return;
        if (this.playChanged) {
            this.confirmingStop = true;
            this.notify();
        } else {
            this.stop();
        }
    }

    cancelStop() {
        this.confirmingStop = false;
        this.notify();
    }

    // keep = true leaves the edits made during Play in the scene, otherwise it goes back to what it was
    stop(keep = false) {
        if (!this.game) return;
        const changed = this.playChanged;
        const snapshot = this.playSnapshot;
        this.game.dispose();
        this.game = null;
        this.playSnapshot = null;
        this.confirmingStop = false;
        this.paused = false;

        if (changed && !keep && snapshot) {
            const data = JSON.parse(snapshot) as SceneData;
            this.entities = data.entities;
            this.environment = { ...defaultEnvironment, ...data.environment };
            applyEnvironment(this.scene, this.environment);
            this.rebuild();
            if (this.selectedId && !this.objects.has(this.selectedId)) this.selectedId = null;
            this.restores++;
        }
        this.status = !changed ? "Stopped" : keep ? "Stopped, the changes made during Play are kept" : "Stopped, the changes made during Play are dropped";
        this.notify();
    }

    // Called by the Viewport every frame
    tick(dt: number) {
        if (!this.paused) this.game?.update(dt);
    }

    togglePause() {
        if (!this.game) return;
        this.paused = !this.paused;
        this.status = this.paused ? "Paused: the viewport is the editor again, look around and edit; resume continues the game" : "Playing";
        this.notify();
    }

    // Pauses and moves the scene by one frame
    step() {
        if (!this.game) return;
        this.paused = true;
        this.game.update(1 / 60);
        this.status = "Paused, moved by one frame";
        this.notify();
    }

    // Replaces the three.js object of one component after its data changed, here and in the running game
    private rebuildComponent(entity: EntityData, key: string) {
        const obj = this.objects.get(entity.id);
        if (!obj) return;
        rebuildComponentObject(this.registry, obj, entity, key);
        this.updateHelper(entity);
        this.game?.syncComponent(entity, key);
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
        this.restartGame();
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
        this.restartGame();
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
        this.restartGame();
    }

    // Selects the entity (the selected one by default) and brings the editor camera to it
    focus(id: string | null = this.selectedId) {
        const obj = id ? this.objects.get(id) : null;
        if (!id || !obj) return;
        if (id !== this.selectedId) this.select(id);
        this.focusHandler?.(this.game?.getObject(id) ?? obj);
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
        this.game?.syncEntity(entity, property);
        this.notify();
    }

    // Copies the transform of the entity's three.js object back into the entity data
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

    // The gizmo moved the selected object. During Play it holds the object of the running copy: only what the
    // gizmo changes is taken from it, so moving an object does not save the rotation its script has given it.
    syncFromGizmo() {
        const id = this.selectedId;
        const source = id ? this.game?.getObject(id) : null;
        const obj = id ? this.objects.get(id) : null;
        if (!id || !source || !obj) {
            if (id) this.syncFromObject(id);
            return;
        }
        if (this.gizmoMode === "translate") obj.position.copy(source.position);
        else if (this.gizmoMode === "rotate") obj.rotation.copy(source.rotation);
        else obj.scale.copy(source.scale);
        this.syncFromObject(id);
    }

    // What the gizmo holds and the camera focuses on: during Play the object of the running copy
    get selectedViewObject() {
        const id = this.selectedId;
        if (!id) return null;
        return this.game ? this.game.getObject(id) : this.objects.get(id) ?? null;
    }

    rename(id: string, name: string) {
        const entity = findEntity(this.entities, id)?.entity;
        const obj = this.objects.get(id);
        if (!entity || !obj) return;
        entity.name = name;
        obj.name = name;
        this.game?.syncEntity(entity);
        this.notify();
    }

    setActive(id: string, active: boolean) {
        const entity = findEntity(this.entities, id)?.entity;
        const obj = this.objects.get(id);
        if (!entity || !obj) return;
        if (active) delete entity.active;
        else entity.active = false;
        obj.visible = active;
        this.game?.syncEntity(entity);
        this.notify();
    }

    // `source` names the model or behavior, for the components that take one from scripts/
    addComponent(id: string, type: string, source?: string) {
        const def = componentDefs[type];
        const entity = findEntity(this.entities, id)?.entity;
        if (!def || !entity || entity.prefab) return;

        const component: ComponentData = { type, ...(def.source && source ? { [def.source.key]: source } : {}) };
        const key = componentKey(component);
        if (getComponent(entity, key)) return;
        entity.components.push(component);
        this.rebuildComponent(entity, key);
        this.notify();
    }

    removeComponent(id: string, key: string) {
        const entity = findEntity(this.entities, id)?.entity;
        if (!entity) return;
        entity.components = entity.components.filter((c) => componentKey(c) !== key);
        this.rebuildComponent(entity, key);
        this.notify();
    }

    setComponentField(id: string, key: string, field: string, value: ParamValue) {
        const entity = findEntity(this.entities, id)?.entity;
        const component = entity && getComponent(entity, key);
        if (!entity || !component) return;
        component[field] = value;
        // Another model or behavior has other params
        if (field === componentDefs[component.type]?.source?.key) component.params = {};
        this.rebuildComponent(entity, key);
        this.notify();
    }

    // A param of the model or behavior the component takes from scripts/.
    // A behavior reads its params when Play starts, so for it the change shows on the next Play.
    setComponentParam(id: string, key: string, param: string, value: ParamValue) {
        const entity = findEntity(this.entities, id)?.entity;
        const component = entity && getComponent(entity, key);
        if (!entity || !component) return;
        component.params = { ...(component.params as Params | undefined), [param]: value };
        this.rebuildComponent(entity, key);
        this.notify();
    }

    setEnvironment<K extends keyof EnvironmentData>(key: K, value: EnvironmentData[K]) {
        this.environment[key] = value;
        applyEnvironment(this.scene, this.environment);
        this.game?.setEnvironment(this.environment);
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
        this.restartGame();
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
        this.restartGame();
        this.notify();
    }

    // Called when the project scripts or assets were (re)loaded
    setRegistry(registry: Registry) {
        this.registry = registry;
        this.rebuild();
        // A script, material or prefab changed during Play: run the scene again with it
        this.restartGame();
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
        return JSON.stringify(this.toJSON()) !== this.savedSnapshot;
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
