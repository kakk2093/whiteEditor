import * as THREE from "three";
import type { ParamDef } from "./Registry";

// Scene-wide rendering settings (Unity keeps these in the Lighting window)
export interface EnvironmentData {
    background: string;
    ambientColor: string;
    ambientIntensity: number;
    fog: boolean;
    fogColor: string;
    fogNear: number;
    fogFar: number;
    // Name of a look asset: the render style of the scene, "" = none (see look.ts)
    look: string;
}

export const environmentFields: Record<keyof EnvironmentData, ParamDef> = {
    background: { type: "color", default: "#222222" },
    ambientColor: { type: "color", default: "#ffffff" },
    ambientIntensity: { type: "number", default: 1, min: 0, step: 0.1 },
    fog: { type: "boolean", default: false },
    fogColor: { type: "color", default: "#222222" },
    fogNear: { type: "number", default: 5, min: 0, step: 1 },
    fogFar: { type: "number", default: 50, min: 0, step: 1 },
    look: { type: "asset", kind: "look", default: "" },
};

export const defaultEnvironment = Object.fromEntries(
    Object.entries(environmentFields).map(([key, def]) => [key, def.default])
) as unknown as EnvironmentData;

const AMBIENT_NAME = "__ambient";

// The editor viewport and the game both call this, so they look the same
export function applyEnvironment(scene: THREE.Scene, data: Partial<EnvironmentData> = {}) {
    const env = { ...defaultEnvironment, ...data };

    scene.background = new THREE.Color(env.background);
    scene.fog = env.fog ? new THREE.Fog(env.fogColor, env.fogNear, env.fogFar) : null;

    let ambient = scene.children.find((c) => c.name === AMBIENT_NAME) as THREE.AmbientLight | undefined;
    if (!ambient) {
        ambient = new THREE.AmbientLight();
        ambient.name = AMBIENT_NAME;
        scene.add(ambient);
    }
    ambient.color.set(env.ambientColor);
    ambient.intensity = env.ambientIntensity;
}
