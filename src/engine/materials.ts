import * as THREE from "three";
import type { ParamDef } from "./Registry";

// A material asset: materials/<name>.json in the project
export interface MaterialData {
    color: string;
    roughness: number;
    metalness: number;
    emissive: string;
    emissiveIntensity: number;
    opacity: number;
}

export const materialFields: Record<keyof MaterialData, ParamDef> = {
    color: { type: "color", default: "#cccccc" },
    roughness: { type: "number", default: 0.8, min: 0, max: 1, step: 0.05 },
    metalness: { type: "number", default: 0, min: 0, max: 1, step: 0.05 },
    emissive: { type: "color", default: "#000000" },
    emissiveIntensity: { type: "number", default: 1, min: 0, step: 0.1 },
    opacity: { type: "number", default: 1, min: 0, max: 1, step: 0.05 },
};

export const defaultMaterialData = Object.fromEntries(
    Object.entries(materialFields).map(([key, def]) => [key, def.default])
) as unknown as MaterialData;

export function applyMaterialData(material: THREE.MeshStandardMaterial, data: Partial<MaterialData>) {
    const m = { ...defaultMaterialData, ...data };
    material.color.set(m.color);
    material.roughness = m.roughness;
    material.metalness = m.metalness;
    material.emissive.set(m.emissive);
    material.emissiveIntensity = m.emissiveIntensity;
    material.opacity = m.opacity;
    material.transparent = m.opacity < 1;
    material.needsUpdate = true;
}

// One three.js material per asset, shared by every mesh that uses it
export function createSharedMaterial(data: Partial<MaterialData> = {}) {
    const material = new THREE.MeshStandardMaterial();
    // Whoever removes a mesh must not dispose a material other meshes still use
    material.userData.shared = true;
    applyMaterialData(material, data);
    return material;
}
