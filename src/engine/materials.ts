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
    // An image from the project's assets/ folder, drawn over the color (multiplied by it); "" for none
    texture: string;
    // How many times the image repeats across a face
    tilingX: number;
    tilingY: number;
    // nearest keeps the pixels of the image sharp (pixel art), linear blends them
    filter: string;
    // An image that tells which way each point of the surface faces (the usual bluish normal map): relief
    // under the light without more geometry. Tiled and filtered like the texture.
    normalMap: string;
    // How deep that relief looks; below zero turns it inside out
    normalScale: number;
    // An image of where the surface is rough (light) and where it shines (dark); multiplied by `roughness`
    roughnessMap: string;
}

export const materialFields: Record<keyof MaterialData, ParamDef> = {
    color: { type: "color", default: "#cccccc" },
    roughness: { type: "number", default: 0.8, min: 0, max: 1, step: 0.05 },
    metalness: { type: "number", default: 0, min: 0, max: 1, step: 0.05 },
    emissive: { type: "color", default: "#000000" },
    emissiveIntensity: { type: "number", default: 1, min: 0, step: 0.1 },
    opacity: { type: "number", default: 1, min: 0, max: 1, step: 0.05 },
    texture: { type: "asset", kind: "texture", default: "" },
    tilingX: { type: "number", default: 1, min: 0.01, step: 0.5 },
    tilingY: { type: "number", default: 1, min: 0.01, step: 0.5 },
    filter: { type: "select", default: "nearest", options: ["nearest", "linear"] },
    normalMap: { type: "asset", kind: "texture", default: "" },
    normalScale: { type: "number", default: 1, step: 0.1 },
    roughnessMap: { type: "asset", kind: "texture", default: "" },
};

export const defaultMaterialData = Object.fromEntries(
    Object.entries(materialFields).map(([key, def]) => [key, def.default])
) as unknown as MaterialData;

// Gives the image of a texture by its name in assets/: the image itself if it is already loaded, otherwise
// a promise of it; null where images cannot be loaded
export type ImageSource = (name: string) => HTMLImageElement | Promise<HTMLImageElement> | null;

function configureMap(map: THREE.Texture, m: MaterialData) {
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(m.tilingX, m.tilingY);
    const nearest = m.filter !== "linear";
    map.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
    map.minFilter = nearest ? THREE.NearestFilter : THREE.LinearMipmapLinearFilter;
    map.generateMipmaps = !nearest;
    map.needsUpdate = true;
}

// `images` loads the texture of the material; without it the material stays plain
export function applyMaterialData(material: THREE.MeshStandardMaterial, data: Partial<MaterialData>, images?: ImageSource) {
    const m = { ...defaultMaterialData, ...data };

    // An image arrives later: until then, and if it fails, the material is as it is without it
    material.userData.mapSettings = m;
    // The images of the material: the field that names the file, where three.js keeps the map, and whether
    // it is a picture of colors (the others are pictures of numbers)
    for (const [field, slot, colors] of [["texture", "map", true], ["normalMap", "normalMap", false], ["roughnessMap", "roughnessMap", false]] as const) {
        const name = m[field];
        const key = `image:${slot}`;
        if (material.userData[key] !== name) {
            material.userData[key] = name;
            material[slot]?.dispose();
            material[slot] = null;
            const setMap = (image: HTMLImageElement) => {
                // The material may have got another image, or none, in the meantime
                if (material.userData[key] !== name) return;
                const map = new THREE.Texture(image);
                if (colors) map.colorSpace = THREE.SRGBColorSpace;
                configureMap(map, material.userData.mapSettings as MaterialData);
                material[slot] = map;
                material.needsUpdate = true;
            };
            const image = images?.(name);
            if (image instanceof Promise) image.then(setMap).catch(() => console.warn(`Texture "${name}" could not be loaded`));
            else if (image) setMap(image);
        } else if (material[slot]) {
            configureMap(material[slot], m);
        }
    }
    material.normalScale.set(m.normalScale, m.normalScale);

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
export function createSharedMaterial(data: Partial<MaterialData> = {}, images?: ImageSource) {
    const material = new THREE.MeshStandardMaterial();
    // Whoever removes a mesh must not dispose a material other meshes still use
    material.userData.shared = true;
    applyMaterialData(material, data, images);
    return material;
}
