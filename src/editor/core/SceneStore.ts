import * as THREE from "three";
import type { Folders } from "./folders";
import { editorLog } from "./log";
import {
    addedLists,
    applyEnvironment,
    assignAddedIds,
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
    entityNames,
    fitAspect,
    Game,
    generateId,
    innerId,
    paramDefaults,
    parseScene,
    rebuildComponentObject,
    Registry,
    ROOT_PATH,
    SoundPlayer,
    UI_PARTS
} from "../../engine";
import type {
    ComponentData, EntityData, EntityOverride, EnvironmentData, ParamValue, Params, PrefabData, SceneData
} from "../../engine";
import { renameInEntities } from "./references";

type Listener = () => void;

export type TransformProperty = "position" | "rotation" | "scale";

export type GizmoMode = "translate" | "rotate" | "scale";

// The pages of the Settings window
export type SettingsPage = "project" | "scene" | "editor" | "controls";

export interface AssetRef {
    // The last four are not files: what the scripts of the project (and the engine) define
    // "texture" is an image file of assets/, named with its extension; "sound" an audio file of it
    kind: "material" | "model" | "scene" | "prefab" | "look" | "texture" | "sound" | "behavior" | "effect" | "surface" | "sky" | "clip" | "animator";
    name: string;
}

const AXES = ["x", "y", "z"] as const;

// Keeps gizmo results free of float noise, so scene files stay readable and diff well
const round = (value: number) => Math.round(value * 10000) / 10000;

// A real entity of the scene: one of its own, or one a prefab instance adds to its prefab (those live in the
// overrides of the instance). `parentId` is the id of what it is under: for an added one that is the instance
// or something inside it, which is not a real entity, so `parent` is null there.
interface Found {
    entity: EntityData;
    parent: EntityData | null;
    parentId: string | null;
    siblings: EntityData[];
}

// How many entities of the tree have this name
function countNamed(list: EntityData[], name: string): number {
    return list.reduce((sum, entity) => sum + Number(entity.name === name) + countNamed(entity.children ?? [], name), 0);
}

function findEntity(list: EntityData[], id: string, parent: EntityData | null = null, parentId: string | null = null): Found | null {
    for (const entity of list) {
        if (entity.id === id) return { entity, parent, parentId, siblings: list };
        const found = findEntity(entity.children, id, entity, entity.id) ?? findAdded(entity, id);
        if (found) return found;
    }
    return null;
}

function findAdded(instance: EntityData, id: string): Found | null {
    for (const [path, override] of Object.entries(instance.overrides ?? {})) {
        const found = override.addChildren && findEntity(override.addChildren, id, null, innerId(instance, path));
        if (found) return found;
    }
    return null;
}

// Every list of real entities right under this one
const ownLists = (entity: EntityData) => [entity.children, ...addedLists(entity)];

// Drops what an edit has left empty in the overrides of the instances
function tidyOverrides(entities: EntityData[]) {
    for (const entity of entities) {
        for (const [path, override] of Object.entries(entity.overrides ?? {})) {
            for (const key of ["addChildren", "addComponents", "removeComponents"] as const) {
                if (override[key]?.length === 0) delete override[key];
            }
            if (Object.keys(override).length === 0) delete entity.overrides![path];
        }
        if (entity.overrides && Object.keys(entity.overrides).length === 0) delete entity.overrides;
        for (const list of ownLists(entity)) tidyOverrides(list);
    }
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
    // "folders" and "settings" are one file each (folders.json, project.json): their name is the same word
    section: "materials" | "looks" | "scenes" | "prefabs" | "folders" | "settings";
    name: string;
    before: unknown | null;
    after: unknown | null;
}

// One step of undo: the scene as it was before a change of it, a change of an asset, or something that
// touches many files at once and is undone by doing the opposite (a rename, a file added to assets/)
type Step = { scene: string } | { asset: AssetStep } | { action: { name: string; undo: () => unknown; redo: () => unknown } };

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

// The color of the markers of sounds and of the sound listener
const SOUND_COLOR = 0x5fe0c8;

// ...of the outline of a collider that belongs to a body of the physics, of zones, of particle sources
const BODY_COLOR = 0xff9a3c;

const ZONE_COLOR = 0x7aa8ff;

const PARTICLES_COLOR = 0xffb84a;

// Lights, cameras, sounds and the sound listener draw nothing, so the editor gives them a clickable marker;
// a collider gets its outline
function createHelper(entity: EntityData): THREE.Object3D | null {
    const light = getComponent(entity, "light");
    const camera = getComponent(entity, "camera");
    const collider = getComponent(entity, "collider");
    const sound = getComponent(entity, "sound");
    const listener = getComponent(entity, "listener");
    const zone = getComponent(entity, "zone");
    const particles = getComponent(entity, "particles");
    // Nothing of its own to see or to click: a group that only holds its children, an object with behaviors
    // only. Not the elements of the interface (they are not in the world) and not what a prefab fills.
    const drawn = ["mesh", "model", "gltf", "sprite", "label", "light", "camera", "sound", "listener", "zone", "particles", "canvas", "ui"];
    const empty = !entity.prefab && !entity.components.some((component) => drawn.includes(component.type));
    if (!light && !camera && !collider && !sound && !listener && !zone && !particles && !empty) return null;

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
            // Orange: a body, which the physics moves
            new THREE.LineBasicMaterial({ color: collider.solid === false ? 0xffd54a : getComponent(entity, "body") ? BODY_COLOR : 0x66dd88, fog: false })
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

    // A sound on an entity that already has a marker of its own gets none: the marker is there to be clicked
    if (sound && !light && !camera) {
        // A loudspeaker: a small box with a horn opening upwards
        const tone = new THREE.MeshBasicMaterial({ color: SOUND_COLOR, wireframe: true, fog: false });
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 0.14), tone);
        const horn = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.07, 0.16, 8, 1, true), tone);
        horn.position.y = 0.14;
        helper.add(box, horn);
    } else if (listener && !light && !camera) {
        helper.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.16), new THREE.MeshBasicMaterial({ color: SOUND_COLOR, wireframe: true, fog: false })));
    }
    if (sound?.spatial) {
        // How far a spatial sound is heard: a circle on the ground and one upright. Not for clicking.
        // The range is in meters of the world whatever the scale of the entity, so the circles take only
        // their place from it: not its scale, nor its rotation.
        const range = (sound.range as number | undefined) ?? (componentDefs.sound.fields.range.default as number);
        const points = Array.from({ length: 49 }, (_, i) => {
            const angle = (i / 48) * Math.PI * 2;
            return new THREE.Vector3(Math.cos(angle) * range, 0, Math.sin(angle) * range);
        });
        const circle = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(points),
            new THREE.LineBasicMaterial({ color: SOUND_COLOR, fog: false, transparent: true, opacity: 0.5 })
        );
        circle.raycast = () => {};
        const upright = circle.clone();
        upright.rotation.x = Math.PI / 2;
        upright.raycast = () => {};
        const reach = new THREE.Group();
        reach.add(circle, upright);
        reach.updateMatrixWorld = () => {
            if (reach.parent) reach.matrixWorld.identity().copyPosition(reach.parent.matrixWorld);
            reach.children.forEach((child) => child.updateMatrixWorld(true));
        };
        helper.add(reach);
    }

    const marked = light || camera || sound || listener;
    if (zone) {
        // The box of the zone, not for clicking (the camera flies inside it), and a small marker that is
        const f = { ...paramDefaults(componentDefs.zone.fields), ...zone } as Record<string, number>;
        const box = new THREE.BoxGeometry(f.sizeX, f.sizeY, f.sizeZ);
        const outline = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: ZONE_COLOR, fog: false, transparent: true, opacity: 0.7 }));
        box.dispose();
        outline.raycast = () => {};
        helper.add(outline);
        if (!marked) helper.add(new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 0.22), new THREE.MeshBasicMaterial({ color: ZONE_COLOR, wireframe: true, fog: false })));
    } else if (particles && !marked) {
        // A source of particles: a small cone opening the way they fly (up its own Y)
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.24, 6, 1, true), new THREE.MeshBasicMaterial({ color: PARTICLES_COLOR, wireframe: true, fog: false }));
        cone.rotation.x = Math.PI;
        cone.position.y = 0.12;
        helper.add(cone);
    } else if (empty && !collider) {
        // Something to click where there is nothing: three short sticks along the axes
        const tone = new THREE.MeshBasicMaterial({ color: 0x8a94a6, wireframe: true, fog: false });
        helper.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.09), tone));
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

// The options of the editor as they were left last time
const OPTIONS_KEY = "white:editor";
const savedOptions = (() => {
    try {
        return JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "{}") as Record<string, unknown>;
    } catch {
        return {};
    }
})();

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

    // The entity whose name is being typed in the Hierarchy
    renamingId: string | null = null;

    // What Copy has taken: the entities as JSON text (the same text goes to the system clipboard)
    clipboard: string | null = null;

    // The axes of the gizmo: "world" keeps them along the axes of the scene, "local" turns them with the
    // object (its own forward, up and side). Scaling is always along the object's own axes.
    gizmoSpace: "world" | "local" = savedOptions.gizmoSpace === "local" ? "local" : "world";

    // Gizmo snapping: moves by whole steps of `snapStep` meters, turns by 15 degrees, scales by 0.25
    snap = savedOptions.snap === true;

    snapStep = typeof savedOptions.snapStep === "number" ? savedOptions.snapStep : 0.5;

    // An asset picked in the Project panel; shown in the Inspector instead of an entity
    selectedAsset: AssetRef | null = null;

    gizmoMode: GizmoMode = "translate";

    // The open project and scene; changed through actions.ts
    project = "";

    projects: string[] = [];

    sceneName = "main";

    scenes: string[] = [];

    // Is the Console window open; remembered in the browser
    consoleOpen = localStorage.getItem("white:console") === "shown";

    // The page of the Settings window that is open, null while the window is closed
    settingsPage: SettingsPage | null = null;

    // The folders of the Project panel: folders.json of the project
    folders: Folders = {};

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
    // the Inspector edit it in both. "both" (the two side by side) is remembered between runs of the editor.
    playCamera: "editor" | "game" | "both" = savedOptions.playBoth === true ? "both" : "game";

    // With both views side by side: the one that was clicked last, which has the keyboard
    splitFocus: "scene" | "game" = "game";

    // Play is on, but time stands still; step() moves it by one frame
    paused = false;

    // "Edit Collider": the viewport shows handles on the collider of the selected entity instead of the gizmo
    // (see colliderHandles.ts). Stays on from one collider to the next; without a collider it shows nothing.
    colliderEdit = false;

    // false draws the viewport without the look of the scene: arranging objects in a pixelated picture is hard.
    // The game itself always has its look.
    lookEnabled = savedOptions.lookEnabled !== false;

    // true: the viewport shows the interface of the game (the UI elements of the scene) over the scene
    // while it is edited. The Game view of Play always shows it.
    uiVisible = savedOptions.uiVisible !== false;

    // true: Play makes no sound in the editor. The built game is not affected.
    muted = savedOptions.muted === true;

    // Counts how often the scene data was put back (stop(), undo, redo); a field being typed in must then forget its text
    restores = 0;

    // Bumped on every change, lets React treat the store as an external store
    version = 0;

    private objects = new Map<string, THREE.Object3D>();

    private listeners: Listener[] = [];

    // true while the right mouse button is held in the viewport: W/A/S/D then fly the camera
    // instead of switching tools. Not part of the rendered state, so changing it notifies nobody.
    flying = false;

    // Set by actions.ts: reads a scene of the project from its file, for self.loadScene() during Play
    sceneLoader: ((name: string) => Promise<SceneData>) | null = null;

    // The scene Play has gone on to by self.loadScene(), null while it runs the open one
    playScene: string | null = null;

    // What the behaviors keep from scene to scene during one Play (self.globals)
    private playGlobals: Record<string, unknown> = {};

    // The sounds of Play, one player for every scene it goes through, so that the music goes on
    private playSounds: SoundPlayer | null = null;

    // Set by the Viewport: moves the editor camera to look at an object
    focusHandler: ((obj: THREE.Object3D) => void) | null = null;

    constructor() {
        this.scene = new THREE.Scene();
        this.scene.add(this.root);
        this.prefabLight.position.set(3, 6, 4);
        applyEnvironment(this.scene, this.environment, this.registry);
    }

    subscribe = (fn: Listener) => {
        this.listeners.push(fn);
        return () => {
            this.listeners = this.listeners.filter(l => l !== fn);
        };
    };

    getVersion = () => this.version;

    // Inside batch() the changes are not announced one by one
    private batching = 0;
    private pending = false;

    // Several changes as one: the listeners hear of them once, and undo takes them back together
    batch(run: () => void) {
        this.batching++;
        try {
            run();
        } finally {
            this.batching--;
            if (this.batching === 0 && this.pending) {
                this.pending = false;
                this.notify();
            }
        }
    }

    private notify() {
        if (this.batching > 0) {
            this.pending = true;
            return;
        }
        this.record();
        // What the params of kind "object" can name: the objects of what is open
        this.registry.setObjects(entityNames(this.entities, this.registry));
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
                else if ("asset" in step && step.asset.section === section && step.asset.name === from) step.asset.name = to;
            }
        }
        applyEnvironment(this.scene, this.environment, this.registry);
        this.notify();
    }

    // An asset was changed, created (before = null) or deleted (after = null): a material, a look, a scene
    // file, a prefab file, the folders or the settings of the project
    recordAsset(section: AssetStep["section"], name: string, before: unknown | null, after: unknown | null) {
        if (!this.recording) return;
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

    // false while a step of undo is being carried out by the actions: what they change on the way is a
    // part of that step, not new steps
    recording = true;

    // Something that is undone by doing the opposite: `undo` and `redo` do the work (see actions.ts)
    recordAction(name: string, undo: () => unknown, redo: () => unknown) {
        if (!this.recording) return;
        this.undoStack.push({ action: { name, undo, redo } });
        if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
        this.redoStack = [];
        this.lastChange = 0;
        this.lastStep = "";
        this.notify();
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
        if ("action" in step) {
            to.push(step);
            (what === "Undo" ? step.action.undo : step.action.redo)();
            subject = `: ${step.action.name}`;
        } else if ("asset" in step) {
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
        applyEnvironment(this.scene, this.environment, this.registry);
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
        const real = findEntity(this.entities, id)?.entity;
        if (real && !(content && real.prefab)) return { entity: real, instance: null, path: "" };
        const place = real ? { instance: real, path: ROOT_PATH } : this.inside(id);
        if (!place) return null;

        const expanded = expandInstance(this.registry, place.instance);
        if (!expanded) return null;
        if (place.path === ROOT_PATH) return { entity: expanded, instance: place.instance, path: ROOT_PATH };
        const entity = findInExpanded(expanded, id);
        return entity ? { entity, ...place } : null;
    }

    // For an id of something that comes from a prefab: the instance that brings it and its path there.
    // The instance is the nearest real entity the id leads through; it may itself be one another instance adds.
    private inside(id: string): { instance: EntityData; path: string } | null {
        if (findEntity(this.entities, id)) return null;
        const parts = id.split("/");
        for (let n = parts.length - 1; n > 0; n--) {
            const real = findEntity(this.entities, parts.slice(0, n).join("/"))?.entity;
            if (real) return real.prefab ? { instance: real, path: parts.slice(n).join("/") } : null;
        }
        return null;
    }

    // The path of the id in the overrides of its instance; null if it is not something a prefab brings
    pathIn(id: string) {
        return this.inside(id)?.path ?? null;
    }

    // The real entity with this id (one of the scene, or one an instance adds); null for what a prefab brings
    realEntity(id: string) {
        return findEntity(this.entities, id)?.entity ?? null;
    }

    // The instance that adds this entity to its prefab, if it is such an entity (or is under one)
    addedIn(id: string) {
        if (!id.includes("/") || !findEntity(this.entities, id)) return null;
        const parts = id.split("/");
        for (let n = parts.length - 1; n > 0; n--) {
            const real = findEntity(this.entities, parts.slice(0, n).join("/"))?.entity;
            if (real?.prefab) return real;
        }
        return null;
    }

    // After an edit: what now differs from the prefab becomes the override of the instance at that path
    private commit(target: Target) {
        const { instance, path, entity } = target;
        if (!instance) return;
        const pristine = expandPristine(this.registry, instance);
        const before = pristine && findInExpanded(pristine, entity.id);
        if (!before) return;

        const diff = diffOverride(this.registry, before, entity, path === ROOT_PATH);
        // The entities added here are real ones and are changed as such, not through the copy
        const addChildren = instance.overrides?.[path]?.addChildren;
        const override = addChildren ? { ...diff, addChildren } : diff;
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
        return this.inside(id) !== null;
    }

    // The instance the id belongs to: itself, or the one it is inside of
    instanceOf(id: string) {
        const entity = findEntity(this.entities, id)?.entity;
        if (entity) return entity.prefab ? entity : null;
        return this.inside(id)?.instance ?? null;
    }

    // true if the instance changes what the prefab gives it (for an inner id: at that very place)
    hasOverrides(id: string) {
        const overrides = this.instanceOf(id)?.overrides;
        if (!overrides) return false;
        const path = this.pathIn(id);
        return path !== null ? path in overrides : true;
    }

    // What the instance changes at the place the id names (for the instance itself: in its root), if anything.
    // The Inspector marks these fields.
    overrideOf(id: string): EntityOverride | null {
        const overrides = this.instanceOf(id)?.overrides;
        return overrides?.[this.pathIn(id) ?? ROOT_PATH] ?? null;
    }

    // Back to what the prefab gives, for one thing the instance changes: `field` is where it is in the
    // override, e.g. ["position"], ["components", "mesh", "shape"], ["components", "model", "params", "steps"]
    revertOverrideField(id: string, field: string[]) {
        const instance = this.instanceOf(id);
        const path = this.pathIn(id) ?? ROOT_PATH;
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
        const path = this.pathIn(id);
        if (path !== null) {
            delete instance.overrides[path];
            if (Object.keys(instance.overrides).length === 0) delete instance.overrides;
        } else {
            delete instance.overrides;
        }
        // What the instance had added is gone with them
        this.restructure();
        this.restores++;
        this.restartGame();
        this.notify();
    }

    // The names of the entities of the prefab that the instance leaves out right under this id
    removedUnder(id: string): string[] {
        const real = findEntity(this.entities, id)?.entity;
        const place = real ? (real.prefab ? { instance: real, path: ROOT_PATH } : null) : this.inside(id);
        if (!place?.instance.overrides) return [];
        const prefix = place.path === ROOT_PATH ? "" : `${place.path}/`;
        return Object.entries(place.instance.overrides)
            .filter(([path, override]) => override.removed && path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
            .map(([path]) => path.slice(prefix.length));
    }

    // Brings back an entity of the prefab the instance had left out: `name` is its name, `id` what it was under
    restoreRemoved(id: string, name: string) {
        const real = findEntity(this.entities, id)?.entity;
        const place = real ? { instance: real, path: ROOT_PATH } : this.inside(id);
        const path = place ? (place.path === ROOT_PATH ? name : `${place.path}/${name}`) : "";
        const override = place?.instance.overrides?.[path];
        if (!place || !override) return;
        delete override.removed;
        this.restructure();
        this.restartGame();
        this.notify();
    }

    // Brings back a component of the prefab the instance had removed
    restoreComponent(id: string, key: string) {
        const override = this.overrideOf(id);
        const instance = this.instanceOf(id);
        if (!override?.removeComponents || !instance) return;
        override.removeComponents = override.removeComponents.filter((other) => other !== key);
        tidyOverrides(this.entities);
        this.rebuildEntity(instance);
        this.restores++;
        this.restartGame();
        this.notify();
    }

    // After a change of what an instance adds or leaves out: the ids of the added entities follow their
    // names and places, so everything is tidied and built again
    private restructure() {
        tidyOverrides(this.entities);
        this.rebuild();
        this.pruneSelection();
    }

    // Builds the three.js object of one entity (with all that is under it) again
    private rebuildEntity(entity: EntityData) {
        const old = this.objects.get(entity.id);
        const parent = old?.parent;
        if (!old || !parent) return;
        parent.remove(old);
        this.unindexObjects(old);
        disposeObject(old);
        // What an instance adds stays a part of it for a click in the viewport
        const obj = createEntityObject(this.registry, entity, [], old.userData.innerId !== undefined);
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
        // The entities instances add are known by their places; the selection follows them to their new ids
        const selected = this.selectedIds.map((id) => findEntity(this.entities, id)?.entity ?? null);
        assignAddedIds(this.entities);
        this.selectedIds = this.selectedIds.map((id, i) => selected[i]?.id ?? id);

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
        this.saveOptions();
        this.notify();
    }

    setUiVisible(visible: boolean) {
        this.uiVisible = visible;
        this.saveOptions();
        this.notify();
    }

    // The look the running game is to be drawn with now (a zone may have changed it); null if nothing runs
    get gameLook() {
        return this.game ? this.game.lookName : null;
    }

    // The interface of the running game, for the viewport to draw; null if nothing runs
    get gameUi() {
        return this.game?.ui ?? null;
    }

    // The running game, for the viewport to show its overlay (self.overlay); null if nothing runs
    get runningGame() {
        return this.game;
    }

    setMuted(muted: boolean) {
        this.muted = muted;
        if (this.game) this.game.sound.volume = muted ? 0 : 1;
        this.saveOptions();
        this.notify();
    }

    // The options of the editor itself (Settings, Editor page) are kept in the browser between runs
    private saveOptions() {
        const options = { gizmoSpace: this.gizmoSpace, snap: this.snap, snapStep: this.snapStep, lookEnabled: this.lookEnabled, muted: this.muted, uiVisible: this.uiVisible, playBoth: this.playCamera === "both" };
        localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
    }

    setPlayCamera(camera: "editor" | "game" | "both") {
        this.playCamera = camera;
        if (camera === "both") this.splitFocus = "game";
        this.saveOptions();
        this.notify();
    }

    setSplitFocus(focus: "scene" | "game") {
        if (this.splitFocus === focus) return;
        this.splitFocus = focus;
        this.notify();
    }

    // true while the viewport shows both views side by side: the Scene view on the left, with everything
    // the editor does there, and the picture of the game on the right
    get split() {
        return this.playCamera === "both" && this.hasGameCamera;
    }

    // true while, of the two views side by side, the game has the keyboard and its own mouse
    get gameFocused() {
        return this.split && this.splitFocus === "game" && !this.paused;
    }

    // true while the keys belong to the behaviors of the running scene, not to the editor
    get gameKeys() {
        return this.gameView || this.gameFocused;
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
        return this.game && this.gameKeys ? this.game.input : null;
    }

    // The camera of the running scene fitted to a viewport of this size, or null if the editor camera is in use
    gameCamera(width: number, height: number) {
        if (!this.game || !this.gameView) return null;
        this.game.resize(width, height);
        return this.game.camera;
    }

    // The camera of the running scene fitted to a picture of this size, for the game half of the two views
    // side by side; null if they are not shown
    splitCamera(width: number, height: number) {
        if (!this.game || !this.split) return null;
        this.game.resize(width, height);
        return this.game.camera;
    }

    // The entity objects the viewport picks from
    get viewRoot() {
        return this.game?.root ?? this.root;
    }

    // The game reads the scene data without copying it, so script params edited during Play apply at once
    // `scene`: another scene of the project a behavior has asked for (self.loadScene); without it the open one
    private startGame(scene?: { name: string; data: SceneData }) {
        this.game?.dispose();
        // The project was loaded again (a script was edited): its sounds are new files
        if (this.playSounds?.registry !== this.registry) {
            this.playSounds?.dispose();
            this.playSounds = new SoundPlayer(this.registry);
        }
        const game = new Game(this.registry, scene?.data ?? this.toJSON(), this.playGlobals, this.playSounds);
        game.runtime.onError = (message) => this.update({ status: message });
        game.sound.volume = this.muted ? 0 : 1;
        // A scene entered while Play is paused waits in silence too
        game.sound.setPaused(this.paused);
        this.game = game;
        this.playScene = scene?.name ?? null;
        game.start();
    }

    // A behavior has called self.loadScene(): Play goes on in that scene, read from its file. The editor
    // still shows and edits the open scene; an edit of its tree brings Play back to it.
    private async enterScene(name: string) {
        if (name === this.sceneName) {
            this.startGame();
            this.notify();
            return;
        }
        try {
            const data = await this.sceneLoader?.(name);
            // Play may have been stopped while the file was on its way
            if (!data || !this.game) return;
            this.startGame({ name, data });
            this.status = `Play went on to scene "${name}" (self.loadScene); the editor still shows "${this.sceneName}"`;
        } catch (e) {
            this.status = `loadScene: ${e instanceof Error ? e.message : String(e)}`;
        }
        this.notify();
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
        // A new run starts with a clean Console, like in Unity, and with nothing kept from scene to scene
        editorLog.clear();
        this.playGlobals = {};
        this.status = "";
        this.paused = false;
        // Play starts the way the game does; the Scene view is one click away. Both views side by side stay.
        if (this.playCamera !== "both") this.playCamera = "game";
        this.splitFocus = "game";
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
        this.playSounds?.dispose();
        this.playSounds = null;
        this.game = null;
        this.playScene = null;
        this.playSnapshot = null;
        this.confirmingStop = false;
        this.paused = false;

        if (changed && !keep && snapshot) this.restore(JSON.parse(snapshot) as SceneData);
        this.status = !changed ? "Stopped" : keep ? "Stopped, the changes made during Play are kept" : "Stopped, the changes made during Play are dropped";
        this.notify();
    }

    // Called by the Viewport every frame
    tick(dt: number) {
        if (this.paused || !this.game) return;
        this.game.update(dt);
        const next = this.game.requestedScene;
        if (next !== null) {
            this.game.runtime.requestedScene = null;
            this.enterScene(next);
        }
    }

    // Where the picture of the game goes in a view of this size: all of it, or, if the project gives the
    // picture a shape (Settings, Project), the biggest area of that shape in the middle
    gameArea(width: number, height: number) {
        return fitAspect(this.registry.settings, width, height);
    }

    togglePause() {
        if (!this.game) return;
        this.paused = !this.paused;
        this.game.sound.setPaused(this.paused);
        this.status = this.paused ? "Paused: the viewport is the editor again, look around and edit; resume continues the game" : "Playing";
        this.notify();
    }

    // Pauses and moves the scene by one frame
    step() {
        if (!this.game) return;
        this.paused = true;
        this.game.sound.setPaused(true);
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

    // `parentId`: where the entity is going; inside a prefab instance the names the prefab gives there count too
    private uniqueName(base: string, parentId: string | null = null, except: EntityData | null = null) {
        const names = new Set<string>();
        const collect = (list: EntityData[]) => list.forEach((e) => {
            if (e !== except) names.add(e.name);
            ownLists(e).forEach(collect);
        });
        collect(this.entities);
        if (parentId) {
            this.locate(parentId, true)?.entity.children.forEach((child) => child.id !== except?.id && names.add(child.name));
            // What a prefab brings there keeps its id by the name the prefab gives it, even if renamed here
            for (const id of this.objects.keys()) {
                if (id !== except?.id && id.startsWith(`${parentId}/`) && !id.slice(parentId.length + 1).includes("/")) names.add(id.slice(parentId.length + 1));
            }
        }
        // Paths go by names
        base = base.replace(/\//g, "-");

        if (!names.has(base)) return base;
        const stem = base.replace(/ \(\d+\)$/, "");
        let n = 1;
        while (names.has(`${stem} (${n})`)) n++;
        return `${stem} (${n})`;
    }

    // Where a new entity may go. `id` is what it will be under (null: the scene itself) and `list` gives the
    // list it joins. A prefab keeps a single root. Under a prefab instance, or under something a prefab brings,
    // the list is the "addChildren" of the override at that place: the entity becomes one the instance adds.
    private slot(parentId: string | null): { id: string | null; list: () => EntityData[]; added: boolean } {
        if (parentId) {
            const real = findEntity(this.entities, parentId)?.entity;
            if (real && !real.prefab) return { id: parentId, list: () => real.children, added: parentId.includes("/") };
            const place = real ? { instance: real, path: ROOT_PATH } : this.inside(parentId);
            if (place) {
                const { instance, path } = place;
                const list = () => {
                    const overrides = (instance.overrides ??= {});
                    const override = (overrides[path] ??= {});
                    return (override.addChildren ??= []);
                };
                return { id: parentId, list, added: true };
            }
        }
        const root = this.editingPrefab ? this.entities[0] : null;
        return root ? { id: root.id, list: () => root.children, added: false } : { id: null, list: () => this.entities, added: false };
    }

    // Puts a ready entity (with its children) into the scene
    insertEntity(entity: EntityData, parentId: string | null = null) {
        const slot = this.slot(parentId);
        entity.name = this.uniqueName(entity.name, slot.id);
        slot.list().push(entity);

        if (slot.added) {
            // Its id comes from its place
            this.restructure();
        } else {
            const obj = createEntityObject(this.registry, entity);
            (slot.id ? this.objects.get(slot.id)! : this.root).add(obj);
            this.adopt(entity, obj);
        }
        this.restartGame();
        this.notify();
        return entity;
    }

    addEntity(name: string, components: ComponentData[] = [], parentId: string | null = null) {
        return this.insertEntity(createEntity(name, components), parentId);
    }

    duplicate(id: string) {
        const found = findEntity(this.entities, id);
        if (!found) {
            // Something a prefab brings: its copy is an entity the instance adds next to it
            const copy = this.isInner(id) ? this.findEntity(id) : null;
            return copy ? this.insertEntity(cloneWithNewIds(copy), id.slice(0, id.lastIndexOf("/"))) : null;
        }
        // The root of a prefab stays the only root
        if (this.editingPrefab && found.parentId === null) return null;
        return this.insertEntity(cloneWithNewIds(found.entity), found.parentId);
    }

    removeEntity(id: string) {
        const found = findEntity(this.entities, id);
        const obj = this.objects.get(id);
        if (!obj) return;
        if (!found) {
            // Something a prefab brings: the instance leaves it out, and what it changed inside goes too
            const place = this.inside(id);
            if (!place) return;
            const overrides = { ...place.instance.overrides };
            for (const path of Object.keys(overrides)) if (path.startsWith(`${place.path}/`)) delete overrides[path];
            overrides[place.path] = { removed: true };
            place.instance.overrides = overrides;
            this.restructure();
        } else {
            if (this.editingPrefab && found.parentId === null) return;
            found.siblings.splice(found.siblings.indexOf(found.entity), 1);
            if (id.includes("/")) {
                this.restructure();
            } else {
                obj.removeFromParent();
                this.unindexObjects(obj);
                disposeObject(obj);
                this.pruneSelection();
            }
        }
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
                else ownLists(entity).forEach(visit);
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
        // What a prefab brings is not among the roots: its instance leaves it out
        const inner = this.selectedIds.filter((id) => this.isInner(id));
        for (const entity of this.selectedRoots) this.removeEntity(entity.id);
        for (const id of inner) this.removeEntity(id);
    }

    // Copies of the selected entities next to the originals; the copies become the selection
    duplicateSelected() {
        // What a prefab brings is copied too: as an entity its instance adds
        const ids = [...this.selectedRoots.map((entity) => entity.id), ...this.selectedIds.filter((id) => this.isInner(id))];
        const copies = ids.map((id) => this.duplicate(id)).filter((copy) => copy !== null);
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
        // Next to the selected entity; for something a prefab brings, next to its instance
        const beside = this.selectedId ? findEntity(this.entities, this.selectedId) ?? findEntity(this.entities, this.instanceOf(this.selectedId)?.id ?? "") : null;
        const parentId = beside?.parentId ?? null;
        const pasted = entities.map((entity) => this.insertEntity(cloneWithNewIds(entity), parentId));
        this.selectMany(pasted.map((entity) => entity.id));
        this.update({ status: `Pasted ${pasted.length === 1 ? pasted[0].name : `${pasted.length} objects`}` });
        return true;
    }

    setConsoleOpen(open: boolean) {
        this.consoleOpen = open;
        localStorage.setItem("white:console", open ? "shown" : "hidden");
        this.notify();
    }

    // Opens the Settings window on a page; null closes it
    openSettings(page: SettingsPage | null) {
        this.settingsPage = page;
        this.notify();
    }

    setGizmoSpace(space: "world" | "local") {
        this.gizmoSpace = space;
        this.saveOptions();
        this.notify();
    }

    setSnap(on: boolean, step = this.snapStep) {
        this.snap = on;
        this.snapStep = step;
        this.saveOptions();
        this.notify();
    }

    // Moves the entity under another parent (null = scene root), keeping its place in the world
    reparent(id: string, parentId: string | null) {
        const found = findEntity(this.entities, id);
        const obj = this.objects.get(id);
        if (!found || !obj || id === parentId) return;
        if (this.editingPrefab && found.parentId === null) return;
        // An entity cannot become a child of its own descendant, nor of what its own prefab brings
        if (parentId && (findEntity(ownLists(found.entity).flat(), parentId) || parentId.startsWith(`${id}/`))) return;

        const slot = this.slot(parentId);
        const target = slot.id ? this.objects.get(slot.id) : this.root;
        if (slot.id === id || slot.id === found.parentId || !target) return;

        // It stays where it is in the world
        target.attach(obj);
        const { entity } = found;
        this.readTransform(entity, obj);
        found.siblings.splice(found.siblings.indexOf(entity), 1);
        // Inside an instance paths go by names, so there it must not be a neighbor's
        if (slot.added) entity.name = this.uniqueName(entity.name, slot.id, entity);
        slot.list().push(entity);
        // Into an instance or out of one: the id changes with the place
        if (slot.added || id.includes("/")) this.restructure();
        else this.game?.syncEntity(entity);
        this.restartGame();
        this.notify();
    }

    private readTransform(entity: EntityData, obj: THREE.Object3D) {
        entity.position = [round(obj.position.x), round(obj.position.y), round(obj.position.z)];
        entity.rotation = [
            round(THREE.MathUtils.radToDeg(obj.rotation.x)),
            round(THREE.MathUtils.radToDeg(obj.rotation.y)),
            round(THREE.MathUtils.radToDeg(obj.rotation.z))
        ];
        entity.scale = [round(obj.scale.x), round(obj.scale.y), round(obj.scale.z)];
    }

    // The objects the behaviors have made in the running scene (self.spawn): they are in no file, so the
    // Hierarchy lists them apart, while Play goes on
    get spawned(): { id: string; name: string; object: THREE.Object3D }[] {
        const game = this.game;
        if (!game) return [];
        const list: { id: string; name: string; object: THREE.Object3D }[] = [];
        const visit = (obj: THREE.Object3D) => {
            const id = obj.userData.entityId ?? obj.userData.innerId;
            // What the scene started with is known to the game by its id
            if (id !== undefined && game.getObject(id) !== obj) list.push({ id, name: obj.name, object: obj });
            else obj.children.forEach(visit);
        };
        game.root.children.forEach(visit);
        return list;
    }

    // An object of the running game that is looked at in the Inspector instead of a selected entity: one
    // the behaviors have created, which the data of the scene knows nothing about
    private inspectedObject: THREE.Object3D | null = null;

    // null once the game is over or the object is gone from it
    get inspected() {
        const object = this.inspectedObject;
        if (!object || !this.game) return null;
        for (let o: THREE.Object3D | null = object; o; o = o.parent) if (o === this.game.root) return object;
        return null;
    }

    inspect(object: THREE.Object3D | null) {
        this.inspectedObject = object;
        if (object) {
            this.selectedId = null;
            this.selectedAsset = null;
        }
        this.notify();
    }

    // Brings the editor camera to any object of what the viewport shows
    focusObject(object: THREE.Object3D) {
        this.focusHandler?.(object);
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
        this.inspectedObject = null;
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
        if (asset) this.inspectedObject = null;
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
    update(patch: Partial<Pick<SceneStore, "project" | "projects" | "sceneName" | "scenes" | "folders" | "status">>) {
        Object.assign(this, patch);
        // What self.loadScene() and the params of kind "scene" can name
        if (patch.scenes) this.registry.setScenes(patch.scenes);
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
        this.readTransform(target.entity, obj);
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
    // They move by the same distance in the world; a turn or a scale goes around the main one, where the
    // gizmo stands, so the group turns and grows as one thing.
    private moveOthers(id: string, obj: THREE.Object3D) {
        const main = findEntity(this.entities, id)?.entity;
        const others = this.selectedRoots.filter((entity) => entity.id !== id);
        if (!main || others.length === 0 || !this.selectedRoots.includes(main)) return;

        // The data still has what the main one was before the gizmo changed it
        const parentTurn = obj.parent ? obj.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
        const before = new THREE.Vector3(...main.position);
        if (obj.parent) obj.parent.localToWorld(before);
        const pivot = obj.getWorldPosition(new THREE.Vector3());
        const shift = pivot.clone().sub(before);
        const turnedBefore = parentTurn.clone().multiply(
            new THREE.Quaternion().setFromEuler(new THREE.Euler(...(main.rotation.map(THREE.MathUtils.degToRad) as [number, number, number])))
        );
        // The turn that leads from how the main one stood to how it stands now
        const turn = obj.getWorldQuaternion(new THREE.Quaternion()).multiply(turnedBefore.invert());
        const grow = new THREE.Vector3(...AXES.map((axis, i) => (main.scale[i] !== 0 ? obj.scale[axis] / main.scale[i] : 1)));

        for (const entity of others) {
            const other = this.objects.get(entity.id);
            if (!other) continue;
            const world = other.getWorldPosition(new THREE.Vector3());
            if (this.gizmoMode === "translate") {
                world.add(shift);
            } else if (this.gizmoMode === "rotate") {
                world.sub(pivot).applyQuaternion(turn).add(pivot);
                const facing = turn.clone().multiply(other.getWorldQuaternion(new THREE.Quaternion()));
                const otherParent = other.parent ? other.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
                other.quaternion.copy(otherParent.invert().multiply(facing));
            } else {
                world.sub(pivot).multiply(grow).add(pivot);
                other.scale.multiply(grow);
            }
            other.position.copy(other.parent ? other.parent.worldToLocal(world) : world);
            this.syncFromObject(entity.id);
        }
    }

    // What the gizmo holds and the camera focuses on: during Play the object of the running copy
    get selectedViewObject() {
        const id = this.selectedId;
        // An object created in Play that is looked at in the Inspector: the gizmo moves the object itself
        if (!id) return this.inspected;
        return this.game ? this.game.getObject(id) : this.objects.get(id) ?? null;
    }

    // Puts the entity next to another one: right before it or right after it among its siblings. This is
    // how the order of the Hierarchy (and of the scene file) is changed. If the other one has another parent,
    // the entity moves there first, keeping its place in the world.
    moveBeside(id: string, targetId: string, after: boolean) {
        const target = findEntity(this.entities, targetId);
        const found = findEntity(this.entities, id);
        if (!found || !target || id === targetId) return;
        // The root of a prefab has no neighbors, and nothing goes inside itself
        if (this.editingPrefab && (found.parentId === null || target.parentId === null)) return;
        if (findEntity(ownLists(found.entity).flat(), targetId)) return;

        if (target.parentId !== found.parentId) this.reparent(id, target.parentId);
        // Its id may have followed it to the new place
        const now = findEntity(this.entities, found.entity.id);
        if (!now || now.siblings !== target.siblings) return;
        const list = now.siblings;
        list.splice(list.indexOf(now.entity), 1);
        list.splice(list.indexOf(target.entity) + (after ? 1 : 0), 0, now.entity);
        // The first camera of the scene is the one the game looks through, so the order can matter
        this.restartGame();
        this.notify();
    }

    // The Hierarchy shows a field instead of the name of this entity (F2)
    startRename(id: string | null = this.selectedId) {
        if (!id || !this.objects.has(id)) return;
        this.renamingId = id;
        this.notify();
    }

    // `name` is what was typed; null (Esc) or an empty name leaves the old one
    finishRename(name: string | null) {
        const id = this.renamingId;
        if (!id) return;
        this.renamingId = null;
        if (name?.trim()) this.rename(id, name.trim());
        else this.notify();
    }

    rename(id: string, name: string) {
        const found = findEntity(this.entities, id);
        const obj = this.objects.get(id);
        if (!found && obj) {
            // Something a prefab brings: the instance gives it another name, its id and its path stay
            const target = this.locate(id);
            if (!target) return;
            target.entity.name = name.replace(/\//g, "-");
            obj.name = target.entity.name;
            this.game?.syncEntity(target.entity);
            this.commit(target);
            this.notify();
            return;
        }
        if (!found || !obj) return;
        const { entity } = found;
        // What named this object by its name (params of kind "object") names it still, unless another
        // object has the same name
        const old = entity.name;
        const namesakes = entityNames(this.entities, this.registry).includes(old) ? countNamed(this.entities, old) : 0;
        if (old && old !== name && namesakes === 1) renameInEntities(this.registry, this.entities, "object", old, name);
        if (id.includes("/")) {
            // One a prefab instance adds: its name is a part of its id and must not be a neighbor's
            entity.name = this.uniqueName(name, found.parentId, entity);
            this.restructure();
            this.restartGame();
        } else {
            entity.name = name;
            obj.name = name;
            this.game?.syncEntity(entity);
        }
        this.notify();
    }

    // The tag of a real entity (what a prefab brings has the tag the prefab gives it)
    setTag(id: string, tag: string) {
        const entity = findEntity(this.entities, id)?.entity;
        const obj = this.objects.get(id);
        if (!entity || !obj) return;
        if (tag) entity.tag = tag;
        else delete entity.tag;
        // An instance without a tag of its own shows the one of its prefab
        const shown = this.expand(entity)?.tag ?? entity.tag;
        if (shown) obj.userData.tag = shown;
        else delete obj.userData.tag;
        this.game?.syncEntity(this.expand(entity) ?? entity);
        this.notify();
    }

    // The entities of the scene that use the asset: a material on their mesh, a sound, a behavior, a model, or, for a
    // prefab, its instances. What is inside prefab instances is not looked through.
    usersOf(kind: AssetRef["kind"], name: string): EntityData[] {
        const users: EntityData[] = [];
        const visit = (list: EntityData[]) => list.forEach((entity) => {
            const uses = kind === "prefab"
                ? entity.prefab === name
                : entity.components.some((c) => (kind === "material" && c.type === "mesh" && c.material === name)
                    || (kind === "sound" && c.type === "sound" && c.sound === name)
                    || (kind === "behavior" && c.type === "script" && c.script === name)
                    || (kind === "clip" && c.type === "animation" && c.clip === name)
                    || (kind === "animator" && c.type === "animator" && c.animator === name)
                    || (kind === "model" && ((c.type === "model" && c.model === name) || (c.type === "gltf" && c.file === name))));
            if (uses) users.push(entity);
            ownLists(entity).forEach(visit);
        });
        visit(this.entities);
        return users;
    }

    // Every tag the entities of the scene have, for the Inspector to offer
    get tags(): string[] {
        const tags = new Set<string>();
        const visit = (list: EntityData[]) => list.forEach((entity) => {
            if (entity.tag) tags.add(entity.tag);
            ownLists(entity).forEach(visit);
        });
        visit(this.entities);
        return [...tags].sort();
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

    // Gives the entity an Animation component that plays the clip, or points the one it has at it; one step of undo
    addClip(id: string, clip: string) {
        this.batch(() => {
            this.addComponent(id, "animation");
            this.setComponentField(id, "animation", "clip", clip);
        });
    }

    // `source` names the model or behavior, for the components that take one from scripts/
    addComponent(id: string, type: string, source?: string) {
        const def = componentDefs[type];
        const target = this.locate(id, true);
        if (!def || !target) return;
        const { entity } = target;

        const component: ComponentData = { type, ...(def.source && source ? { [def.source.key]: source } : {}) };
        const key = componentKey(component);
        if (getComponent(entity, key)) return;
        // A text, an image or a button is drawn in the place a UI Element gives it
        if (UI_PARTS.includes(type) && !getComponent(entity, "ui")) {
            entity.components.push({ type: "ui" });
            this.rebuildComponent(entity, "ui");
        }
        entity.components.push(component);
        this.rebuildComponent(entity, key);
        // For an instance or what is inside one: a component the instance adds
        this.commit(target);
        // A model does not have the size of the default collider: the new one is put around it
        if (type === "collider" && entity.components.some((c) => c.type === "gltf" || c.type === "model")) this.fitCollider(id);
        this.notify();
    }

    // Makes the collider of the entity a box around what the entity itself shows: its model file, its model
    // made by code, its mesh. false if there is nothing to measure (a model file that is still loading).
    fitCollider(id: string) {
        const obj = this.objects.get(id);
        if (!obj || !this.findEntity(id)?.components.some((c) => c.type === "collider")) return false;
        obj.updateWorldMatrix(true, true);
        const toLocal = obj.matrixWorld.clone().invert();
        const box = new THREE.Box3();
        const corner = new THREE.Vector3();
        for (const part of obj.children) {
            if (!["gltf", "model", "mesh"].includes(part.userData.component as string)) continue;
            part.traverse((child) => {
                const mesh = child as THREE.Mesh;
                if (!mesh.isMesh) return;
                if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
                const bounds = mesh.geometry.boundingBox!;
                const matrix = toLocal.clone().multiply(mesh.matrixWorld);
                for (let i = 0; i < 8; i++) {
                    corner.set(i & 1 ? bounds.max.x : bounds.min.x, i & 2 ? bounds.max.y : bounds.min.y, i & 4 ? bounds.max.z : bounds.min.z);
                    box.expandByPoint(corner.applyMatrix4(matrix));
                }
            });
        }
        if (box.isEmpty()) return false;
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        // To whole centimeters: the numbers are read in the Inspector
        const cm = (value: number) => Math.round(value * 100) / 100;
        const fields: Record<string, ParamValue> = {
            shape: "box",
            sizeX: Math.max(0.01, cm(size.x)), sizeY: Math.max(0.01, cm(size.y)), sizeZ: Math.max(0.01, cm(size.z)),
            centerX: cm(center.x), centerY: cm(center.y), centerZ: cm(center.z),
        };
        this.batch(() => {
            for (const [field, value] of Object.entries(fields)) this.setComponentField(id, "collider", field, value);
        });
        return true;
    }

    // For an instance or what is inside one, a component of the prefab is left out by the instance
    removeComponent(id: string, key: string) {
        const target = this.locate(id, true);
        if (!target) return;
        const { entity } = target;
        entity.components = entity.components.filter((c) => componentKey(c) !== key);
        this.rebuildComponent(entity, key);
        this.commit(target);
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
        applyEnvironment(this.scene, this.environment, this.registry);
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
        registry.setScenes(this.scenes);
        // The sky and its picture come from the registry
        applyEnvironment(this.scene, this.environment, this.registry);
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
        applyEnvironment(this.scene, this.environment, this.registry);
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
