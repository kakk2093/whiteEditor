import * as THREE from "three";
import type { Input } from "./input";
import { builtinEffects, isEffectDef } from "./look";
import type { EffectDef, LookData } from "./look";
import { applyMaterialData, createSharedMaterial } from "./materials";
import type { MaterialData } from "./materials";
import { builtinSurfaces, isSurfaceDef } from "./surface";
import type { SurfaceDef } from "./surface";
import type { EntityData, Params, ParamValue, Vec3 } from "./types";

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
    | { type: "asset"; kind: "material" | "look" | "prefab" | "texture"; default: string }
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
    // along them; false if something was in the way.
    move: (x: number, y: number, z: number) => boolean;
    // The objects whose colliders this object's collider touches right now
    touching: () => THREE.Object3D[];
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
}): BehaviorDef {
    return { kind: "behavior", ...def } as BehaviorDef;
}

export function isBehaviorDef(value: unknown): value is BehaviorDef {
    return typeof value === "object" && value !== null && (value as BehaviorDef).kind === "behavior";
}

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

    removeLook(name: string) {
        this.lookData.delete(name);
    }

    getLookData(name: string) {
        return this.lookData.get(name);
    }

    lookNames() {
        return [...this.lookData.keys()].sort();
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

    // Resolves once the textures of every material are loaded (or have failed): for drawing a single picture,
    // where there is no next frame for a late image to show up in
    async preloadTextures() {
        await Promise.allSettled([...this.materialData.values()].map((data) => this.loadImage(data.texture ?? "")));
    }

    assetNames(kind: "material" | "look" | "prefab" | "texture") {
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
