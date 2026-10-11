import * as THREE from "three";
import {
    applyEnvironment,
    componentDefs,
    componentKey,
    createDefaultScene,
    createEntity,
    createEntityObject,
    defaultEnvironment,
    diffOverride,
    disposeObject,
    expandInstance,
    expandPristine,
    findComponent,
    findInExpanded,
    Game,
    generateId,
    paramDefaults,
    parseScene,
    rebuildComponentObject,
    Registry,
    ROOT_PATH
} from "../../engine";
import type {
    ComponentData, EntityData, EntityOverride, EnvironmentData, ParamValue, Params, PrefabData, SceneData
} from "../../engine";

type Listener = () => void;

export type TransformProperty = "position" | "rotation" | "scale";

export type GizmoMode = "translate" | "rotate" | "scale";

export interface AssetRef {
    // The last three are not files: what the scripts of the project (and the engine) define
    // "texture" is an image file of assets/, named with its extension
    kind: "material" | "model" | "scene" | "prefab" | "look" | "texture" | "behavior" | "effect" | "surface";
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

// What an id stands for. `entity` is the real entity of the scene, or, for what comes from a prefab, a copy
// of it with the overrides applied; `instance` is then the real instance it belongs to and `path` its
// place in the prefab. Editing the copy changes nothing until commit() turns it into an override.
interface Target {
    entity: EntityData;
    instance: EntityData | null;
    path: string;
}

// A change of a material or a look, as a step of undo: what the asset was and what it became.
// null means there was (or is) no such asset: the step created or deleted it.
export interface AssetStep {
    section: "materials" | "looks";
    name: string;
    before: unknown | null;
    after: unknown | null;
}

// One step of undo: the scene as it was before a change of it, or a change of an asset
type Step = { scene: string } | { asset: AssetStep };

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

// How many steps back undo remembers
const UNDO_LIMIT = 100;

// Changes closer in time than this are undone as one step
const UNDO_MERGE_MS = 400;

// The three.js layer of what only the editor shows inside the scene: the grid, the markers of lights and
// cameras. The viewport draws this layer after the look of the scene, sharp and untouched by its effects.
export const EDITOR_LAYER = 1;

// Lights and cameras draw nothing, so the editor gives them a clickable marker; a collider gets its outline
function createHelper(entity: EntityData): THREE.Object3D | null {
    const light = getComponent(entity, "light");
    const camera = getComponent(entity, "camera");
    const collider = getComponent(entity, "collider");
    if (!light && !camera && !collider) return null;

    const helper = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({ color: light ? 0xffd54a : 0x9ecbff, wireframe: true, fog: false });

    if (collider) {
        // The outline of the collider: green if things stop at it, yellow for a trigger. It is not for
        // clicking: a big trigger zone must not cover what stands inside it.
        const f = { ...paramDefaults(componentDefs.collider.fields), ...collider } as Record<string, number | string | boolean>;
        const radius = f.radius as number;
        const geometry = f.shape === "sphere"
            ? new THREE.SphereGeometry(radius, 12, 8)
            : f.shape === "capsule"
                ? new THREE.CapsuleGeometry(radius, Math.max(0, (f.height as number) - radius * 2), 4, 12)
                : new THREE.BoxGeometry(f.sizeX as number, f.sizeY as number, f.sizeZ as number);
        const outline = new THREE.LineSegments(
            new THREE.EdgesGeometry(geometry, f.shape === "box" ? 1 : 20),
            new THREE.LineBasicMaterial({ color: collider.solid === false ? 0xffd54a : 0x66dd88, fog: false })
        );
        geometry.dispose();
        outline.raycast = () => {};
        outline.position.set(
            (collider.centerX as number | undefined) ?? 0,
            (collider.centerY as number | undefined) ?? 0,
            (collider.centerZ as number | undefined) ?? 0
        );
        helper.add(outline);
    }

    if (light) {
        helper.add(new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6), material));
    } else if (camera) {
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

    // Every selected entity, in the order they were picked. The last one is the main one: the Inspector
    // shows it and the gizmo holds it; `selectedId` is its id.
    selectedIds: string[] = [];

    get selectedId(): string | null {
        return this.selectedIds[this.selectedIds.length - 1] ?? null;
    }

    // Selecting by this means one entity (or none)
    set selectedId(id: string | null) {
        this.selectedIds = id ? [id] : [];
    }

    // What Copy has taken: the entities as JSON text (the same text goes to the system clipboard)
    clipboard: string | null = null;

    // Gizmo snapping: moves by whole steps of `snapStep` meters, turns by 15 degrees, scales by 0.25
    snap = false;

    snapStep = 0.5;

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

    private stash: {
        entities: EntityData[];
        environment: EnvironmentData;
        savedSnapshot: string;
        undoStack: Step[];
        redoStack: Step[];
    } | null = null;

    // Undo / redo, oldest step first. A step of the scene (or of the prefab being edited) is its JSON before
    // the change: every change of the scene data ends in notify(), which is where it is recorded. A change
    // of a material or a look is recorded by the action that makes it (recordAsset). Both are in one list,
    // so they are undone in the order they were made.
    private undoStack: Step[] = [];

    private redoStack: Step[] = [];

    // What the last recorded step changed: "scene" or "<section>/<name>" of an asset; only changes of the
    // same thing merge into one step
    private lastStep = "";

    // Set by actions.ts: makes an asset what it was (null: removes it), in the registry and on disk
    assetHandler: ((section: AssetStep["section"], name: string, data: unknown | null) => void) | null = null;

    // The scene data as of the last notify(), to see that it changed and what it was before
    private current = "";

    // When the last change was recorded; changes that follow each other closely are one step
    private lastChange = 0;

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

    // "Edit Collider": the viewport shows handles on the collider of the selected entity instead of the gizmo
    // (see colliderHandles.ts). Stays on from one collider to the next; without a collider it shows nothing.
    colliderEdit = false;

    // false draws the viewport without the look of the scene: arranging objects in a pixelated picture is hard.
    // The game itself always has its look.
    lookEnabled = true;

    // Counts how often the scene data was put back (stop(), undo, redo); a field being typed in must then forget its text
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
        this.record();
        this.version++;
        this.listeners.forEach((fn) => fn());
    }

    // Puts the scene data as it was before the change that just happened onto the undo stack
    private record() {
        const now = JSON.stringify(this.toJSON());
        if (now === this.current) return;
        // Nothing was shown yet, so there is nothing to go back to
        if (!this.current) {
            this.current = now;
            return;
        }
        const time = performance.now();
        // Dragging the gizmo or typing a number is many small changes: together they are one step
        if (this.lastStep !== "scene" || time - this.lastChange > UNDO_MERGE_MS) {
            this.undoStack.push({ scene: this.current });
            if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
        }
        this.redoStack = [];
        this.lastChange = time;
        this.lastStep = "scene";
        this.current = now;
    }

    // An asset got another name: `change` puts the new name into a scene wherever the old one stood. It is
    // applied to the scene and to every remembered state of it, so that neither undo nor "unsaved changes"
    // see the old name again. Not for Play and not while a prefab is edited.
    renameReferences(change: (scene: SceneData) => void, section: AssetStep["section"] | "prefabs", from: string, to: string) {
        const inSnapshot = (snapshot: string) => {
            if (!snapshot) return snapshot;
            const scene = JSON.parse(snapshot) as SceneData;
            change(scene);
            return JSON.stringify(scene);
        };
        change(this.toJSON());
        this.savedSnapshot = inSnapshot(this.savedSnapshot);
        this.current = JSON.stringify(this.toJSON());
        for (const stack of [this.undoStack, this.redoStack]) {
            for (const step of stack) {
                if ("scene" in step) step.scene = inSnapshot(step.scene);
                else if (step.asset.section === section && step.asset.name === from) step.asset.name = to;
            }
        }
        applyEnvironment(this.scene, this.environment);
        this.notify();
    }

    // A material or a look was changed, created (before = null) or deleted (after = null)
    recordAsset(section: AssetStep["section"], name: string, before: unknown | null, after: unknown | null) {
        const key = `${section}/${name}`;
        const time = performance.now();
        const top = this.undoStack[this.undoStack.length - 1];
        // Dragging a slider or a color is many small changes: together they are one step
        if (top && "asset" in top && this.lastStep === key && time - this.lastChange <= UNDO_MERGE_MS) {
            top.asset.after = after;
        } else {
            this.undoStack.push({ asset: { section, name, before, after } });
            if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
        }
        this.redoStack = [];
        this.lastChange = time;
        this.lastStep = key;
    }

    // Forgets the steps: what is shown now is another scene (or prefab)
    private resetHistory(undoStack: Step[] = [], redoStack: Step[] = []) {
        this.undoStack = undoStack;
        this.redoStack = redoStack;
        this.lastStep = "";
        this.current = JSON.stringify(this.toJSON());
        this.lastChange = 0;
    }

    get canUndo() {
        return this.undoStack.length > 0;
    }

    get canRedo() {
        return this.redoStack.length > 0;
    }

    undo() {
        this.travel(this.undoStack, this.redoStack, "Undo");
    }

    redo() {
        this.travel(this.redoStack, this.undoStack, "Redo");
    }

    // Takes the step on top of `from` back (or makes it again) and puts into `to` what leads the other way
    private travel(from: Step[], to: Step[], what: "Undo" | "Redo") {
        const step = from.pop();
        if (!step) return;
        let subject = "";
        if ("asset" in step) {
            const { section, name, before, after } = step.asset;
            to.push(step);
            this.assetHandler?.(section, name, what === "Undo" ? before : after);
            // A field of the asset being typed in must forget its text
            this.restores++;
            subject = ` ${section}/${name}`;
        } else {
            to.push({ scene: this.current });
            this.restore(JSON.parse(step.scene) as SceneData);
            this.restartGame();
            this.current = JSON.stringify(this.toJSON());
        }
        // The next change is a step of its own, however soon it comes
        this.lastChange = 0;
        this.lastStep = "";
        this.status = `${what}${subject} (${this.undoStack.length} to undo, ${this.redoStack.length} to redo)`;
        this.notify();
    }

    // Replaces the scene data with an earlier state of the same scene
    private restore(data: SceneData) {
        this.entities = data.entities;
        this.environment = { ...defaultEnvironment, ...data.environment };
        applyEnvironment(this.scene, this.environment);
        this.rebuild();
        this.pruneSelection();
        // A field being typed in must forget its text
        this.restores++;
    }

    get selected() {
        return this.selectedId ? this.findEntity(this.selectedId) : null;
    }

    // An entity of the scene, or, by an id like "<instance id>/<path>", what a prefab instance has at that
    // path: a copy with the overrides of the instance applied
    findEntity(id: string) {
        return this.locate(id)?.entity ?? null;
    }

    // `content` asks for what a prefab instance is made of instead of the instance itself: its components
    // come from the prefab, so changing them is an override too
    private locate(id: string, content = false): Target | null {
        const slash = id.indexOf("/");
        const real = findEntity(this.entities, slash < 0 ? id : id.slice(0, slash))?.entity;
        if (!real) return null;
        if (slash < 0 && !(content && real.prefab)) return { entity: real, instance: null, path: "" };

        const expanded = expandInstance(this.registry, real);
        if (!expanded) return null;
        if (slash < 0) return { entity: expanded, instance: real, path: ROOT_PATH };
        const entity = findInExpanded(expanded, id);
        return entity ? { entity, instance: real, path: id.slice(slash + 1) } : null;
    }

    // After an edit: what now differs from the prefab becomes the override of the instance at that path
    private commit(target: Target) {
        const { instance, path, entity } = target;
        if (!instance) return;
        const pristine = expandPristine(this.registry, instance);
        const before = pristine && findInExpanded(pristine, entity.id);
        if (!before) return;

        const override = diffOverride(this.registry, before, entity, path === ROOT_PATH);
        const overrides = { ...instance.overrides };
        if (override) overrides[path] = override;
        else delete overrides[path];
        if (Object.keys(overrides).length > 0) instance.overrides = overrides;
        else delete instance.overrides;
    }

    // The content of a prefab instance, for the Hierarchy and the Inspector; null if it cannot be shown
    expand(entity: EntityData) {
        return entity.prefab ? expandInstance(this.registry, entity) : null;
    }

    // true if the id is of something inside a prefab instance
    isInner(id: string) {
        return id.includes("/");
    }

    // The instance the id belongs to: itself, or the one it is inside of
    instanceOf(id: string) {
        const entity = findEntity(this.entities, id.split("/")[0])?.entity;
        return entity?.prefab ? entity : null;
    }

    // true if the instance changes what the prefab gives it (for an inner id: at that very place)
    hasOverrides(id: string) {
        const overrides = this.instanceOf(id)?.overrides;
        if (!overrides) return false;
        return this.isInner(id) ? id.slice(id.indexOf("/") + 1) in overrides : true;
    }

    // What the instance changes at the place the id names (for the instance itself: in its root), if anything.
    // The Inspector marks these fields.
    overrideOf(id: string): EntityOverride | null {
        const overrides = this.instanceOf(id)?.overrides;
        return overrides?.[this.isInner(id) ? id.slice(id.indexOf("/") + 1) : ROOT_PATH] ?? null;
    }

    // Back to what the prefab gives, for one thing the instance changes: `field` is where it is in the
    // override, e.g. ["position"], ["components", "mesh", "shape"], ["components", "model", "params", "steps"]
    revertOverrideField(id: string, field: string[]) {
        const instance = this.instanceOf(id);
        const path = this.isInner(id) ? id.slice(id.indexOf("/") + 1) : ROOT_PATH;
        const override = instance?.overrides?.[path];
        if (!instance?.overrides || !override) return;

        // Removes the field, then every object that it leaves empty
        const remove = (object: Record<string, unknown>, keys: string[]) => {
            const [key, ...rest] = keys;
            const inside = object[key];
            if (rest.length === 0) delete object[key];
            else if (typeof inside === "object" && inside !== null) {
                remove(inside as Record<string, unknown>, rest);
                if (Object.keys(inside).length === 0) delete object[key];
            }
        };
        const changed = structuredClone(override) as Record<string, unknown>;
        remove(changed, field);
        if (Object.keys(changed).length > 0) instance.overrides = { ...instance.overrides, [path]: changed as EntityOverride };
        else delete instance.overrides[path];
        if (Object.keys(instance.overrides).length === 0) delete instance.overrides;

        this.rebuildEntity(instance);
        this.restores++;
        this.restartGame();
        this.notify();
    }

    // Back to what the prefab gives: for an instance all of its overrides, for an inner id the one at that place
    revertOverrides(id: string) {
        const instance = this.instanceOf(id);
        if (!instance?.overrides) return;
        if (this.isInner(id)) {
            delete instance.overrides[id.slice(id.indexOf("/") + 1)];
            if (Object.keys(instance.overrides).length === 0) delete instance.overrides;
        } else {
            delete instance.overrides;
        }
        this.rebuildEntity(instance);
        this.restores++;
        this.restartGame();
        this.notify();
    }

    // Builds the three.js object of one entity (with all that is under it) again
    private rebuildEntity(entity: EntityData) {
        const old = this.objects.get(entity.id);
        const parent = old?.parent;
        if (!old || !parent) return;
        parent.remove(old);
        this.unindexObjects(old);
        disposeObject(old);
        const obj = createEntityObject(this.registry, entity);
        parent.add(obj);
        this.adopt(entity, obj);
    }

    // The camera component of the selected entity: the viewport shows its view in a corner.
    // Not during Play, which has the Game view for that.
    get previewCamera() {
        if (this.playing) return null;
        const camera = this.selectedObject?.children.find((child) => child.userData.component === "camera");
        return camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera ? camera : null;
    }

    // The three.js object of an entity of the scene being edited
    objectOf(id: string) {
        return this.objects.get(id) ?? null;
    }

    get selectedObject() {
        return this.selectedId ? this.objects.get(this.selectedId) ?? null : null;
    }

    // Registers the objects of the entity and its children and gives them editor helpers
    private adopt(entity: EntityData, obj: THREE.Object3D) {
        const byId = new Map<string, THREE.Object3D>();
        obj.traverse((child) => {
            const id = child.userData.entityId ?? child.userData.innerId;
            if (id) byId.set(id, child);
        });

        const visit = (e: EntityData) => {
            // What is inside a prefab instance is registered too, under its "<instance id>/<path>"
            const shown = this.expand(e) ?? e;
            const o = byId.get(shown.id);
            if (o) {
                this.objects.set(shown.id, o);
                this.updateHelper(shown);
            }
            shown.children.forEach(visit);
        };
        visit(entity);
    }

    private unindexObjects(obj: THREE.Object3D) {
        obj.traverse((child) => {
            const id = child.userData.entityId ?? child.userData.innerId;
            if (id) this.objects.delete(id);
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

        if (changed && !keep && snapshot) this.restore(JSON.parse(snapshot) as SceneData);
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
        this.pruneSelection();
        this.restartGame();
        this.notify();
    }

    // Forgets the selected entities that are no longer there
    private pruneSelection() {
        this.selectedIds = this.selectedIds.filter((id) => this.objects.has(id));
    }

    // The selected entities of the scene that are not inside another selected one: what Delete, Duplicate,
    // Copy and Group act on. What is inside a prefab instance is not among them.
    get selectedRoots(): EntityData[] {
        const ids = new Set(this.selectedIds);
        const roots: EntityData[] = [];
        const visit = (list: EntityData[]) => {
            for (const entity of list) {
                if (ids.has(entity.id)) roots.push(entity);
                else visit(entity.children);
            }
        };
        visit(this.entities);
        return roots;
    }

    // Selects exactly these entities; the last one becomes the main one
    selectMany(ids: string[]) {
        this.selectedIds = ids.filter((id) => this.objects.has(id));
        this.selectedAsset = null;
        this.notify();
    }

    removeSelected() {
        for (const entity of this.selectedRoots) this.removeEntity(entity.id);
    }

    // Copies of the selected entities next to the originals; the copies become the selection
    duplicateSelected() {
        const copies = this.selectedRoots.map((entity) => this.duplicate(entity.id)).filter((copy) => copy !== null);
        if (copies.length > 0) this.selectMany(copies.map((copy) => copy.id));
        return copies;
    }

    // Puts the selected entities under a new empty one, placed in the middle of them
    groupSelected() {
        const roots = this.selectedRoots;
        if (roots.length === 0 || this.editingPrefab && roots.some((entity) => entity === this.entities[0])) return;
        const center = new THREE.Vector3();
        for (const entity of roots) center.add(this.objects.get(entity.id)!.getWorldPosition(new THREE.Vector3()));
        center.divideScalar(roots.length);

        const group = createEntity("Group");
        group.position = [round(center.x), round(center.y), round(center.z)];
        this.insertEntity(group);
        for (const entity of roots) this.reparent(entity.id, group.id);
        this.select(group.id);
    }

    // Copy: the selected entities as JSON text, the way they are written in a scene file. null if nothing is selected.
    copySelected() {
        const picked = this.selectedRoots.length > 0
            ? this.selectedRoots
            // Something inside a prefab instance: it is copied as an ordinary entity
            : this.selectedIds.map((id) => this.findEntity(id)).filter((entity) => entity !== null);
        if (picked.length === 0) return null;
        this.clipboard = JSON.stringify(picked, null, 2);
        this.status = `Copied ${picked.length === 1 ? picked[0].name : `${picked.length} objects`}`;
        this.notify();
        return this.clipboard;
    }

    // Paste: `text` is what Copy made, or any JSON of one entity or a list of them, also hand-written.
    // The new entities go next to the selected one. false if the text is not entities.
    paste(text: string | null = this.clipboard) {
        let entities: EntityData[];
        try {
            const data: unknown = JSON.parse(text ?? "");
            const list = Array.isArray(data) ? data : [data];
            if (list.length === 0 || list.some((item) => typeof item !== "object" || item === null || Array.isArray(item))) return false;
            // The same reading as for a scene file: everything that has a default may be missing
            entities = parseScene({ version: 3, entities: list }).entities;
        } catch {
            return false;
        }
        const parentId = this.selectedId ? findEntity(this.entities, this.selectedId.split("/")[0])?.parent?.id ?? null : null;
        const pasted = entities.map((entity) => this.insertEntity(cloneWithNewIds(entity), parentId));
        this.selectMany(pasted.map((entity) => entity.id));
        this.update({ status: `Pasted ${pasted.length === 1 ? pasted[0].name : `${pasted.length} objects`}` });
        return true;
    }

    setSnap(on: boolean, step = this.snapStep) {
        this.snap = on;
        this.snapStep = step;
        this.notify();
    }

    // Moves the entity under another parent (null = scene root), keeping its place in the world
    reparent(id: string, parentId: string | null) {
        const found = findEntity(this.entities, id);
        const obj = this.objects.get(id);
        if (!found || !obj || id === parentId) return;
        if (this.editingPrefab && !found.parent) return;
        // What is inside a prefab instance takes no children
        if (parentId && this.isInner(parentId)) return;
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

    // `add` (Ctrl or Shift held) keeps what is selected and adds this entity, or takes it out if it is in
    select(id: string | null, add = false) {
        if (add) {
            if (!id) return;
            this.selectedIds = this.selectedIds.includes(id) ? this.selectedIds.filter((other) => other !== id) : [...this.selectedIds, id];
        } else {
            this.selectedId = id;
        }
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

    // true if the selected entity has a collider to edit
    get hasCollider() {
        const entity = this.selected;
        return !!entity && !!getComponent(this.expand(entity) ?? entity, "collider");
    }

    setColliderEdit(on: boolean) {
        this.colliderEdit = on;
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
        const target = this.locate(id);
        const obj = this.objects.get(id);
        if (!target || !obj) return;
        const { entity } = target;
        entity[property][axis] = value;
        // The data keeps rotation in degrees
        obj[property][AXES[axis]] = property === "rotation" ? THREE.MathUtils.degToRad(value) : value;
        this.game?.syncEntity(entity, property);
        this.commit(target);
        this.notify();
    }

    // Copies the transform of the entity's three.js object back into the entity data
    syncFromObject(id: string) {
        const target = this.locate(id);
        const obj = this.objects.get(id);
        if (!target || !obj) return;
        const { entity } = target;
        entity.position = [round(obj.position.x), round(obj.position.y), round(obj.position.z)];
        entity.rotation = [
            round(THREE.MathUtils.radToDeg(obj.rotation.x)),
            round(THREE.MathUtils.radToDeg(obj.rotation.y)),
            round(THREE.MathUtils.radToDeg(obj.rotation.z))
        ];
        entity.scale = [round(obj.scale.x), round(obj.scale.y), round(obj.scale.z)];
        this.commit(target);
        this.notify();
    }

    // The gizmo moved the selected object. During Play it holds the object of the running copy: only what the
    // gizmo changes is taken from it, so moving an object does not save the rotation its script has given it.
    syncFromGizmo() {
        const id = this.selectedId;
        const source = id ? this.game?.getObject(id) : null;
        const obj = id ? this.objects.get(id) : null;
        if (!id || !source || !obj) {
            if (id && obj) this.moveOthers(id, obj);
            if (id) this.syncFromObject(id);
            return;
        }
        if (this.gizmoMode === "translate") obj.position.copy(source.position);
        else if (this.gizmoMode === "rotate") obj.rotation.copy(source.rotation);
        else obj.scale.copy(source.scale);
        this.syncFromObject(id);
    }

    // Several entities are selected and the gizmo has changed the main one: the others get the same change.
    // They move by the same distance in the world; a turn or a scale each one makes about its own middle.
    private moveOthers(id: string, obj: THREE.Object3D) {
        const main = findEntity(this.entities, id)?.entity;
        const others = this.selectedRoots.filter((entity) => entity.id !== id);
        if (!main || others.length === 0 || !this.selectedRoots.includes(main)) return;

        // The data still has what the main one was before the gizmo moved it
        const before = new THREE.Vector3(...main.position);
        if (obj.parent) obj.parent.localToWorld(before);
        const shift = obj.getWorldPosition(new THREE.Vector3()).sub(before);
        const turn = AXES.map((axis, i) => obj.rotation[axis] - THREE.MathUtils.degToRad(main.rotation[i]));
        const grow = AXES.map((axis, i) => (main.scale[i] !== 0 ? obj.scale[axis] / main.scale[i] : 1));

        for (const entity of others) {
            const other = this.objects.get(entity.id);
            if (!other) continue;
            if (this.gizmoMode === "translate") {
                const world = other.getWorldPosition(new THREE.Vector3()).add(shift);
                other.position.copy(other.parent ? other.parent.worldToLocal(world) : world);
            } else if (this.gizmoMode === "rotate") {
                AXES.forEach((axis, i) => { other.rotation[axis] += turn[i]; });
            } else {
                AXES.forEach((axis, i) => { other.scale[axis] *= grow[i]; });
            }
            this.syncFromObject(entity.id);
        }
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
        const target = this.locate(id);
        const obj = this.objects.get(id);
        if (!target || !obj) return;
        const { entity } = target;
        if (active) delete entity.active;
        else entity.active = false;
        obj.visible = active;
        this.game?.syncEntity(entity);
        this.commit(target);
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
        if (!entity || entity.prefab) return;
        entity.components = entity.components.filter((c) => componentKey(c) !== key);
        this.rebuildComponent(entity, key);
        this.notify();
    }

    // For an instance or what is inside one the change becomes an override
    setComponentField(id: string, key: string, field: string, value: ParamValue) {
        const target = this.locate(id, true);
        const component = target && getComponent(target.entity, key);
        if (!target || !component) return;
        component[field] = value;
        // Another model or behavior has other params
        if (field === componentDefs[component.type]?.source?.key) component.params = {};
        this.rebuildComponent(target.entity, key);
        this.commit(target);
        this.notify();
    }

    // A param of the model or behavior the component takes from scripts/.
    // A behavior reads its params when Play starts, so for it the change shows on the next Play.
    setComponentParam(id: string, key: string, param: string, value: ParamValue) {
        const target = this.locate(id, true);
        const component = target && getComponent(target.entity, key);
        if (!target || !component) return;
        component.params = { ...(component.params as Params | undefined), [param]: value };
        this.rebuildComponent(target.entity, key);
        this.commit(target);
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
        delete entity.overrides;
        entity.components = [];
        entity.children = [];
        this.rebuild();
        this.restartGame();
        this.notify();
    }

    // The opposite: the instance becomes an ordinary entity with its own copy of the prefab content
    unpack(id: string) {
        const entity = findEntity(this.entities, id)?.entity;
        // With its overrides; instances of other prefabs inside stay instances
        const content = entity && expandInstance(this.registry, entity, [], false);
        if (!entity || !content) return;
        const copy = cloneWithNewIds(content);
        delete entity.prefab;
        delete entity.overrides;
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
        this.resetHistory();
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
            // The steps of the scene wait together with it
            this.stash = {
                entities: this.entities,
                environment: this.environment,
                savedSnapshot: this.savedSnapshot,
                undoStack: this.undoStack,
                redoStack: this.redoStack,
            };
        }
        this.show([{ ...structuredClone(root), position: [0, 0, 0] }], { ...defaultEnvironment });
        this.scene.add(this.prefabLight);
        this.editingPrefab = name;
        this.selectedId = this.entities[0].id;
        this.resetHistory();
        this.savedSnapshot = JSON.stringify(this.toJSON());
        this.notify();
    }

    closePrefab() {
        if (!this.editingPrefab || !this.stash) return;
        this.stop();
        this.scene.remove(this.prefabLight);
        this.editingPrefab = null;
        this.show(this.stash.entities, this.stash.environment);
        this.resetHistory(this.stash.undoStack, this.stash.redoStack);
        this.savedSnapshot = this.stash.savedSnapshot;
        this.stash = null;
        this.notify();
    }
}

export const sceneStore = new SceneStore();
