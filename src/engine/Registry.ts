import * as THREE from "three";
import type { Input } from "./input";
import { applyMaterialData, createSharedMaterial } from "./materials";
import type { MaterialData } from "./materials";
import type { EntityData, Params } from "./types";

export type ParamDef =
    | { type: "number"; default: number; min?: number; max?: number; step?: number }
    | { type: "color"; default: string }
    | { type: "boolean"; default: boolean }
    | { type: "string"; default: string }
    | { type: "select"; default: string; options: string[] }
    // A reference to a project asset by name, "" = none
    | { type: "asset"; kind: "material"; default: string };

type ParamType<D extends ParamDef> = D extends { type: "number" }
    ? number
    : D extends { type: "boolean" }
        ? boolean
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
}

// Used by project scripts:
// export const spin = defineBehavior({ name: "spin", params: {...}, update: (self, dt) => { self.object.rotation.y += dt; } })
export function defineBehavior<P extends Record<string, ParamDef> = Record<string, never>, S = undefined>(def: {
    name: string;
    label?: string;
    params?: P;
    start?: (self: BehaviorSelf<{ [K in keyof P]: ParamType<P[K]> }, undefined>) => S;
    update?: (self: BehaviorSelf<{ [K in keyof P]: ParamType<P[K]> }, S>, dt: number) => void;
}): BehaviorDef {
    return { kind: "behavior", ...def } as BehaviorDef;
}

export function isBehaviorDef(value: unknown): value is BehaviorDef {
    return typeof value === "object" && value !== null && (value as BehaviorDef).kind === "behavior";
}

// Everything a scene can refer to by name: code models and behaviors from scripts, material and prefab assets
export class Registry {
    private modelDefs = new Map<string, ModelDef>();

    private behaviorDefs = new Map<string, BehaviorDef>();

    private materialData = new Map<string, Partial<MaterialData>>();

    private materialObjects = new Map<string, THREE.MeshStandardMaterial>();

    // Root entities of the prefab assets
    private prefabRoots = new Map<string, EntityData>();

    // Used by meshes that have no material assigned
    private defaultMaterial = createSharedMaterial();

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

    // Registers every defineModel() and defineBehavior() exported from a script module
    registerExports(module: object) {
        for (const value of Object.values(module)) {
            if (isModelDef(value)) this.registerModel(value);
            if (isBehaviorDef(value)) this.registerBehavior(value);
        }
        return this;
    }

    // Adds the material or updates it in place, so meshes already using it change at once
    setMaterial(name: string, data: Partial<MaterialData>) {
        this.materialData.set(name, data);
        const material = this.materialObjects.get(name);
        if (material) applyMaterialData(material, data);
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
            material = createSharedMaterial(data);
            this.materialObjects.set(name, material);
        }
        return material;
    }
}
