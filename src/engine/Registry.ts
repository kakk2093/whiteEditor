import * as THREE from "three";
import type { EnvironmentData } from "./environment";
import type { Input } from "./input";
import { builtinEffects, isEffectDef } from "./look";
import type { EffectDef, LookData } from "./look";
import { applyMaterialData, createSharedMaterial } from "./materials";
import type { MaterialData } from "./materials";
import type { ParticleHandle } from "./particles";
import type { BodyHandle } from "./physics";
import { defaultSettings, layersCollide } from "./settings";
import type { SoundHandle, SoundOptions } from "./sound";
import type { ProjectSettings } from "./settings";
import { builtinSurfaces, isSurfaceDef } from "./surface";
import type { SurfaceDef } from "./surface";
import type { EntityData, Params, ParamValue, Vec3 } from "./types";
import { loadFont } from "./ui";
import type { UiElement } from "./ui";

// What a param of type "asset" can refer to
// "font" is a font file of assets/, named with its extension: "pixel.ttf"
export type AssetKind = "material" | "look" | "prefab" | "texture" | "layer" | "scene" | "sound" | "font";

export type ParamDef = (
    | { type: "number"; default: number; min?: number; max?: number; step?: number }
    | { type: "color"; default: string }
    // A list of colors, e.g. a palette: ["#1a1c2c", "#5d275d"]; at most MAX_COLORS (shaderParams.ts)
    | { type: "colors"; default: string[] }
    | { type: "boolean"; default: boolean }
    | { type: "string"; default: string }
    | { type: "select"; default: string; options: string[] }
    // A reference to a project asset by name, "" = none
    // "texture" is an image file of the project's assets/ folder, named with its extension: "bricks.png"
    // "layer" is a collision layer of the project settings (project.json); "" is the default layer
    // "scene" is a scene of the project, e.g. the one a door leads to (self.loadScene)
    // "sound" is an audio file of assets/, named with its extension: "coin.wav"
    | { type: "asset"; kind: AssetKind; default: string }
) & {
    // The field matters only while other fields of the same object have one of these values, e.g.
    // { kind: ["spot"] }; otherwise the Inspector does not show it. The value is kept either way.
    when?: Record<string, ParamValue[]>;
};

// true if the field has a meaning with these values of the other fields (see `when`)
export function fieldApplies(def: ParamDef, defs: Record<string, ParamDef>, values: Record<string, unknown>) {
    return Object.entries(def.when ?? {}).every(([key, allowed]) => allowed.includes((values[key] ?? defs[key]?.default) as ParamValue));
}

type ParamType<D extends ParamDef> = D extends { type: "number" }
    ? number
    : D extends { type: "boolean" }
        ? boolean
        : D extends { type: "colors" }
            ? string[]
            : string;

export function paramDefaults(defs: Record<string, ParamDef>): Params {
    return Object.fromEntries(Object.entries(defs).map(([key, def]) => [key, def.default]));
}

export interface ModelDef {
    kind: "model";
    name: string;
    label?: string;
    params?: Record<string, ParamDef>;
    // Builds the object in code; called again whenever a param changes
    create: (params: Params) => THREE.Object3D;
}

// Used by project scripts: export const stairs = defineModel({ name: "stairs", params: {...}, create: (p) => ... })
export function defineModel<P extends Record<string, ParamDef>>(def: {
    name: string;
    label?: string;
    params?: P;
    create: (params: { [K in keyof P]: ParamType<P[K]> }) => THREE.Object3D;
}): ModelDef {
    return { kind: "model", ...def } as ModelDef;
}

export function isModelDef(value: unknown): value is ModelDef {
    return typeof value === "object" && value !== null && (value as ModelDef).kind === "model";
}

// A point or a direction: a three.js vector or [x, y, z]
export type VectorLike = THREE.Vector3 | Vec3;

// What a ray has hit: the entity object whose collider it is, where, and which way the surface faces there
export interface RayHit {
    object: THREE.Object3D;
    point: THREE.Vector3;
    normal: THREE.Vector3;
    // Meters from the start of the ray
    distance: number;
}

export interface RayOptions {
    // How far the ray reaches, meters; without it, as far as it takes
    distance?: number;
    // Only the colliders of these layers; without it, of all
    layers?: string[];
    // true: colliders that are not solid (triggers) are hit too
    triggers?: boolean;
    // An object whose colliders (its own and those under it) the ray goes through. A behavior's own object by
    // default; null to hit that one as well.
    ignore?: THREE.Object3D | null;
}

// Which entities to find: all the given things must fit
export interface FindQuery {
    tag?: string;
    name?: string;
    // The name of a behavior the entity has
    behavior?: string;
}

// How a tween goes from the start to the end: evenly, starting slowly, ending slowly, or both
export type Ease = "linear" | "in" | "out" | "inOut";

export interface TweenOptions {
    ease?: Ease;
    // "repeat" starts over from the beginning, "yoyo" goes there and back, both without end
    loop?: "none" | "repeat" | "yoyo";
    // Seconds before it starts
    delay?: number;
    // Called when it has arrived (never, with a loop)
    done?: () => void;
}

// A tween or a timer that was started
export interface Running {
    stop: () => void;
    // false once it has finished or was stopped
    readonly running: boolean;
}

// What a behavior gets about the entity it is attached to
export interface BehaviorSelf<P = Params, S = unknown> {
    // The three.js group of the entity: move, rotate and scale it here
    object: THREE.Object3D;
    params: P;
    // Whatever start() returned
    state: S;
    // The root of the running scene, e.g. for root.getObjectByName("Door")
    root: THREE.Object3D;
    registry: Registry;
    // Keyboard and mouse: self.input.key("KeyW"), self.input.keyPressed("Space"), self.input.mouseButton()
    input: Input;
    // Seconds since Play started
    time: number;
    // Puts a new instance of the prefab into the running scene and returns its object; its behaviors start in
    // this same frame. `position` is relative to `parent`, which is the scene itself if not given.
    spawn: (prefab: string, position?: Vec3, parent?: THREE.Object3D) => THREE.Object3D;
    // Removes an object with everything under it, this one if none is given. It goes at the end of the frame;
    // the behaviors on it get their destroy().
    destroy: (object?: THREE.Object3D) => void;
    // Another behavior, by its name: of this object, or of the one given. What comes back is that behavior's
    // own `self`, so its params and its state can be read and changed. null if the object has no such behavior.
    get: <T = unknown>(behavior: string, object?: THREE.Object3D) => BehaviorSelf<Params, T> | null;
    // Moves the object by this much (meters, along the axes of its parent: for an object of the scene root
    // those of the world). If the object has a solid collider, it stops at other solid colliders, sliding
    // along them; false if something was in the way. `step` (meters, 0 by default): a ledge up to this high
    // does not stop an object that stands on the ground, it walks up onto it: stairs, curbs.
    move: (x: number, y: number, z: number, step?: number) => boolean;
    // The objects whose colliders this object's collider touches right now
    touching: () => THREE.Object3D[];
    // The nearest collider a ray meets, null if none: self.raycast(self.object.position, [0, -1, 0], { distance: 2 }).
    // The start and the direction are in the world. A collider the ray starts inside of is not hit.
    raycast: (origin: VectorLike, direction: VectorLike, options?: RayOptions) => RayHit | null;
    // The ray from the camera of the scene through a point of the screen, for raycast(): where the mouse is,
    // or at x, y (from -1 to 1, left to right and bottom to top). null if the scene has no camera.
    screenRay: (x?: number, y?: number) => { origin: THREE.Vector3; direction: THREE.Vector3 } | null;
    // The active entities of the running scene that fit: self.findAll({ tag: "enemy" }), self.find({ behavior: "drive" })
    findAll: (query: FindQuery) => THREE.Object3D[];
    find: (query: FindQuery) => THREE.Object3D | null;
    // Gravity for an object moved with move(): call it every frame. The object gains speed downwards
    // (`gravity` is meters per second squared, 20 by default) and stops on a solid collider. true while it stands on one.
    fall: (dt: number, gravity?: number) => boolean;
    // Sets the vertical speed fall() goes on from, meters per second: self.jump(7) throws the object up
    jump: (speed: number) => void;
    // true if the object stands on a solid collider
    grounded: () => boolean;
    // Replaces the running scene with another scene of the project, once this frame is over: everything of
    // this scene is destroyed (the behaviors get their destroy()), the other one starts from its file.
    loadScene: (name: string) => void;
    // Plays an audio file of assets/: self.playSound("coin.wav"), self.playSound("hum.ogg", { loop: true, at: self.object }).
    // With `at` (a point or an object) it gets quieter with the distance from the camera, up to `range` meters.
    // What comes back can stop it and change its volume. It does not end with the object of the behavior.
    playSound: (name: string, options?: SoundOptions) => SoundHandle;
    // Makes the file the music: it loops and, unlike every other sound, goes on when the scene changes
    // (self.loadScene). One at a time: another file takes its place, the same file just plays on.
    playMusic: (name: string, options?: Omit<SoundOptions, "at" | "range">) => SoundHandle;
    stopMusic: () => void;
    // The Sound component of this object, or of the one given: play() starts it from the beginning, stop()
    // ends it. null if the object has no Sound component.
    sound: (object?: THREE.Object3D) => SoundSource | null;
    // Moves numbers of `target` to the values of `to` in `seconds`, a little every frame:
    // self.tween(self.object.position, { y: 3 }, 0.5, { ease: "out" }). `target` is anything with numbers in
    // it: a position, a scale, the fields from self.ui(). It ends with the object of the behavior.
    tween: (target: object, to: Record<string, number>, seconds: number, options?: TweenOptions) => Running;
    // Calls the function once, `seconds` from now; it is forgotten if the object of the behavior goes first
    after: (seconds: number, call: () => void) => Running;
    // Calls the function every `seconds`, until it is stopped or the object of the behavior goes
    every: (seconds: number, call: () => void) => Running;
    // The environment of the scene (background, sky, ambient light, fog, look) as it is now, and a way to
    // change it while the game runs: self.setEnvironment({ ambientIntensity: 0.2, fogColor: "#101830" }).
    // What is not named stays. A zone the camera is in still has its say over what it changes.
    environment: EnvironmentData | null;
    setEnvironment: (change: Partial<EnvironmentData>) => void;
    // The Particles component of this object, or of the one given: emit(20) throws out a burst,
    // `playing` switches its steady stream. null if the object has no Particles component.
    particles: (object?: THREE.Object3D) => ParticleHandle | null;
    // The body of this object in the physics, or of the one given: its velocity, and pushing it.
    // self.body()?.push(0, 5, 0) throws it up. null if the object has no Body component.
    body: (object?: THREE.Object3D) => BodyHandle | null;
    // The interface components of this object, or of the one given: { rect, text, image, button }, each the
    // fields of that component. Changing one shows at once: self.ui()!.text!.text = "Score: 3". null if the
    // object has no UI Element component.
    ui: (object?: THREE.Object3D) => UiElement | null;
    // Sets what the Text component of this object (or of the one given) says; a Label in the world, too
    setText: (text: string | number, object?: THREE.Object3D) => void;
    // A page element over the picture of the game, for interface made with HTML and CSS: add elements to it
    // (they need "pointer-events: auto" to be clicked), it is emptied with the scene. var(--unit) inside it is
    // one unit of the interface. null where there is no page to show it on.
    overlay: HTMLElement | null;
    // What lives on from scene to scene, for as long as the game runs: the score, what was collected.
    // Any behavior of any scene reads and writes the same object: self.globals.coins = 3.
    globals: Record<string, unknown>;
}

// The Sound component of an entity, as a behavior sees it
export interface SoundSource {
    // Starts the sound of the component from its beginning
    play: () => void;
    stop: () => void;
    readonly playing: boolean;
}

export interface BehaviorDef {
    kind: "behavior";
    name: string;
    label?: string;
    params?: Record<string, ParamDef>;
    // Called once when the game starts; the returned value becomes self.state
    start?: (self: BehaviorSelf) => unknown;
    // Called every frame, dt is in seconds
    update?: (self: BehaviorSelf, dt: number) => void;
    // Called once when the object is removed (self.destroy()) or the game stops; only if start() has run
    destroy?: (self: BehaviorSelf) => void;
    // The collider of the object began / stopped touching the collider of `other`
    enter?: (self: BehaviorSelf, other: THREE.Object3D) => void;
    exit?: (self: BehaviorSelf, other: THREE.Object3D) => void;
    // The Button of the object was clicked: the mouse (or a finger) went down and up on it
    click?: (self: BehaviorSelf) => void;
    // The Slider of the object was dragged to another value, or the text of its Input Field was typed in
    change?: (self: BehaviorSelf, value: number | string) => void;
    // Enter was pressed in the Input Field of the object
    submit?: (self: BehaviorSelf, value: string) => void;
}

// Used by project scripts:
// export const spin = defineBehavior({ name: "spin", params: {...}, update: (self, dt) => { self.object.rotation.y += dt; } })
export function defineBehavior<P extends Record<string, ParamDef> = Record<string, never>, S = undefined>(def: {
    name: string;
    label?: string;
    params?: P;
    start?: (self: BehaviorSelf<{ [K in keyof P]: ParamType<P[K]> }, undefined>) => S;
    update?: (self: BehaviorSelf<{ [K in keyof P]: ParamType<P[K]> }, S>, dt: number) => void;
    destroy?: (self: BehaviorSelf<{ [K in keyof P]: ParamType<P[K]> }, S>) => void;
    enter?: (self: BehaviorSelf<{ [K in keyof P]: ParamType<P[K]> }, S>, other: THREE.Object3D) => void;
    exit?: (self: BehaviorSelf<{ [K in keyof P]: ParamType<P[K]> }, S>, other: THREE.Object3D) => void;
    click?: (self: BehaviorSelf<{ [K in keyof P]: ParamType<P[K]> }, S>) => void;
    change?: (self: BehaviorSelf<{ [K in keyof P]: ParamType<P[K]> }, S>, value: number | string) => void;
    submit?: (self: BehaviorSelf<{ [K in keyof P]: ParamType<P[K]> }, S>, value: string) => void;
}): BehaviorDef {
    return { kind: "behavior", ...def } as BehaviorDef;
}

export function isBehaviorDef(value: unknown): value is BehaviorDef {
    return typeof value === "object" && value !== null && (value as BehaviorDef).kind === "behavior";
}

// The project whose looks and scripts (effects, surfaces, behaviors, models) every other project has as
// well: what many games need is kept there once. Whatever a project defines under the same name wins.
export const SHARED_PROJECT = "shared";

// Everything a scene can refer to by name: code models, behaviors, effects and surfaces from scripts,
// material, prefab and look assets
export class Registry {
    private modelDefs = new Map<string, ModelDef>();

    private behaviorDefs = new Map<string, BehaviorDef>();

    // Screen effects: the built-in ones, plus (or replaced by) those of the project scripts
    private effectDefs = new Map<string, EffectDef>(builtinEffects.map((def) => [def.name, def]));

    // Additions to the materials: built-in and from the project scripts, like the effects
    private surfaceDefs = new Map<string, SurfaceDef>(builtinSurfaces.map((def) => [def.name, def]));

    private lookData = new Map<string, LookData>();

    private sharedLooks = new Map<string, LookData>();

    // project.json: the collision layers, the tags, the start scene, the shape of the picture
    settings: ProjectSettings = defaultSettings;

    // The names of the scenes of the project: what self.loadScene() and a param of kind "scene" can name
    private scenes: string[] = [];

    private materialData = new Map<string, Partial<MaterialData>>();

    private materialObjects = new Map<string, THREE.MeshStandardMaterial>();

    // Root entities of the prefab assets
    private prefabRoots = new Map<string, EntityData>();

    // Used by meshes that have no material assigned
    private defaultMaterial = createSharedMaterial();

    // The image files of the project's assets/ folder, and where they are loaded from
    private textureFiles: string[] = [];

    private textureBase = "";

    private textureQuery = "";

    // The font files of assets/, and where they are loaded from
    private fontFiles: string[] = [];

    private fontBase = "";

    private fontQuery = "";

    // The audio files of assets/, and where they are loaded from
    private soundFiles: string[] = [];

    private soundBase = "";

    private soundQuery = "";

    // Loaded images, and promises of those still on the way
    private images = new Map<string, HTMLImageElement | Promise<HTMLImageElement>>();

    registerModel(def: ModelDef) {
        this.modelDefs.set(def.name, def);
        return this;
    }

    getModel(name: string) {
        return this.modelDefs.get(name);
    }

    models() {
        return [...this.modelDefs.values()];
    }

    modelDefaults(name: string): Params {
        return paramDefaults(this.modelDefs.get(name)?.params ?? {});
    }

    registerBehavior(def: BehaviorDef) {
        this.behaviorDefs.set(def.name, def);
        return this;
    }

    getBehavior(name: string) {
        return this.behaviorDefs.get(name);
    }

    behaviors() {
        return [...this.behaviorDefs.values()];
    }

    registerEffect(def: EffectDef) {
        this.effectDefs.set(def.name, def);
        return this;
    }

    getEffect(name: string) {
        return this.effectDefs.get(name);
    }

    effects() {
        return [...this.effectDefs.values()];
    }

    registerSurface(def: SurfaceDef) {
        this.surfaceDefs.set(def.name, def);
        return this;
    }

    getSurface(name: string) {
        return this.surfaceDefs.get(name);
    }

    surfaces() {
        return [...this.surfaceDefs.values()];
    }

    setLook(name: string, data: LookData) {
        this.lookData.set(name, data);
        return this;
    }

    // A look of the project "shared": every project has it, until it has a look of its own with that name
    setSharedLook(name: string, data: LookData) {
        this.sharedLooks.set(name, data);
        return this;
    }

    // true if the look comes from the project "shared" and this project has not put its own in its place
    isSharedLook(name: string) {
        return this.sharedLooks.has(name) && !this.lookData.has(name);
    }

    // Removes the look of the project itself; a shared one with that name shows again
    removeLook(name: string) {
        this.lookData.delete(name);
    }

    getLookData(name: string) {
        return this.lookData.get(name) ?? this.sharedLooks.get(name);
    }

    lookNames() {
        return [...new Set([...this.lookData.keys(), ...this.sharedLooks.keys()])].sort();
    }

    // The names of the assets a field of this kind can refer to
    // `files` are the images of assets/ ("bricks.png", "walls/stone.png"), `base` the address of that folder
    // ("./assets/" in a built game); `query` is added to every address, the editor uses it to get a changed
    // file past the cache of the browser
    setTextures(base: string, files: string[], query = "") {
        this.textureBase = base;
        this.textureFiles = [...files].sort();
        this.textureQuery = query;
        this.images.clear();
        return this;
    }

    textureNames() {
        return this.textureFiles;
    }

    // Where the image of a texture is loaded from
    textureUrl(name: string) {
        return this.textureBase + name.split("/").map(encodeURIComponent).join("/") + this.textureQuery;
    }

    // `files` are the audio files of assets/ ("coin.wav", "music/theme.ogg"); the rest is as in setTextures()
    setSounds(base: string, files: string[], query = "") {
        this.soundBase = base;
        this.soundFiles = [...files].sort();
        this.soundQuery = query;
        return this;
    }

    soundNames() {
        return this.soundFiles;
    }

    // Where the file of a sound is loaded from
    soundUrl(name: string) {
        return this.soundBase + name.split("/").map(encodeURIComponent).join("/") + this.soundQuery;
    }

    // `files` are the font files of assets/ ("pixel.ttf"); the rest is as in setTextures()
    setFonts(base: string, files: string[], query = "") {
        this.fontBase = base;
        this.fontFiles = [...files].sort();
        this.fontQuery = query;
        return this;
    }

    fontNames() {
        return this.fontFiles;
    }

    private fontUrl(name: string) {
        return this.fontBase + name.split("/").map(encodeURIComponent).join("/") + this.fontQuery;
    }

    // The CSS family a font of assets/ is drawn with, once its file is loaded; null until then, and for a
    // file the project does not have
    fontFamily(name: string) {
        if (!this.fontFiles.includes(name)) return null;
        const font = loadFont(this.fontUrl(name));
        return font?.ready ? font.family : null;
    }

    // The image of a texture of assets/: the image itself if it is loaded already, otherwise a promise of
    // it; null for a file the project does not have, and outside of a browser
    loadTexture(name: string) {
        return this.textureFiles.includes(name) ? this.loadImage(name) : null;
    }

    // Resolves when the font is loaded (or has failed); null for a file the project does not have
    fontReady(name: string) {
        return this.fontFiles.includes(name) ? loadFont(this.fontUrl(name))?.done ?? null : null;
    }

    // The image of a texture if it is loaded; otherwise null, and the loading is started
    getImage(name: string) {
        if (!this.textureFiles.includes(name)) return null;
        const image = this.loadImage(name);
        if (image instanceof Promise) {
            image.catch(() => {});
            return null;
        }
        return image;
    }

    // The image of a texture; loaded once, however many materials use it. null outside of a browser.
    private loadImage = (name: string) => {
        if (!name || typeof document === "undefined") return null;
        let image = this.images.get(name);
        if (!image) {
            image = new THREE.ImageLoader().loadAsync(this.textureUrl(name)).then((loaded) => {
                // From now on the image is given at once: a material made later has its texture in its first frame
                if (this.images.get(name) === image) this.images.set(name, loaded);
                return loaded;
            });
            this.images.set(name, image);
        }
        return image;
    };

    // Resolves once every image and every font of the project is loaded (or has failed): for drawing a
    // single picture, where there is no next frame for a late one to show up in
    async preloadTextures() {
        await Promise.allSettled([
            ...this.textureFiles.map((name) => this.loadImage(name)),
            ...this.fontFiles.map((name) => loadFont(this.fontUrl(name))?.done),
        ]);
    }

    setSettings(settings: ProjectSettings) {
        this.settings = settings;
        return this;
    }

    // true if colliders of these two layers notice each other
    layersCollide(a: string, b: string) {
        return layersCollide(this.settings, a, b);
    }

    setScenes(names: string[]) {
        this.scenes = [...names].sort();
        return this;
    }

    sceneNames() {
        return this.scenes;
    }

    assetNames(kind: AssetKind) {
        if (kind === "layer") return this.settings.layers;
        if (kind === "sound") return this.soundNames();
        if (kind === "font") return this.fontNames();
        if (kind === "scene") return this.scenes;
        if (kind === "texture") return this.textureNames();
        if (kind === "prefab") return this.prefabNames();
        return kind === "look" ? this.lookNames() : this.materialNames();
    }

    // Registers every defineModel(), defineBehavior(), defineEffect() and defineSurface() exported from a script module
    registerExports(module: object) {
        for (const value of Object.values(module)) {
            if (isModelDef(value)) this.registerModel(value);
            if (isBehaviorDef(value)) this.registerBehavior(value);
            if (isEffectDef(value)) this.registerEffect(value);
            if (isSurfaceDef(value)) this.registerSurface(value);
        }
        return this;
    }

    // Adds the material or updates it in place, so meshes already using it change at once
    setMaterial(name: string, data: Partial<MaterialData>) {
        this.materialData.set(name, data);
        const material = this.materialObjects.get(name);
        if (material) applyMaterialData(material, data, this.loadImage);
        return this;
    }

    removeMaterial(name: string) {
        this.materialData.delete(name);
        this.materialObjects.get(name)?.dispose();
        this.materialObjects.delete(name);
    }

    setPrefab(name: string, root: EntityData) {
        this.prefabRoots.set(name, root);
        return this;
    }

    removePrefab(name: string) {
        this.prefabRoots.delete(name);
    }

    getPrefab(name: string) {
        return this.prefabRoots.get(name);
    }

    prefabNames() {
        return [...this.prefabRoots.keys()].sort();
    }

    materialNames() {
        return [...this.materialData.keys()].sort();
    }

    getMaterialData(name: string) {
        return this.materialData.get(name);
    }

    getMaterial(name: string): THREE.MeshStandardMaterial {
        const data = this.materialData.get(name);
        if (!data) return this.defaultMaterial;

        let material = this.materialObjects.get(name);
        if (!material) {
            material = createSharedMaterial(data, this.loadImage);
            this.materialObjects.set(name, material);
        }
        return material;
    }
}
