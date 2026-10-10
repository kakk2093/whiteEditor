import * as THREE from "three";
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

// Everything a scene can refer to by name: code models from scripts, material and prefab assets
export class Registry {
    private modelDefs = new Map<string, ModelDef>();

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
