import * as THREE from "three";
import { paramDefaults } from "./Registry";
import type { ParamDef, Registry } from "./Registry";
import type { ComponentData, Params } from "./types";

export interface ComponentDef {
    label: string;
    fields: Record<string, ParamDef>;
    create: (fields: Params, registry: Registry) => THREE.Object3D;
}

function createGeometry(shape: string): THREE.BufferGeometry {
    switch (shape) {
        case "sphere":
            return new THREE.SphereGeometry(0.5, 32, 16);
        case "cylinder":
            return new THREE.CylinderGeometry(0.5, 0.5, 1, 32);
        case "capsule":
            return new THREE.CapsuleGeometry(0.5, 1, 8, 16);
        case "plane":
            // Lies on the ground, facing up
            return new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
        default:
            return new THREE.BoxGeometry(1, 1, 1);
    }
}

// Lights and cameras look down their local -Z, so the entity rotation aims them
function createLight(f: Params): THREE.Light {
    const color = f.color as string;
    const intensity = f.intensity as number;
    const range = f.range as number;

    if (f.kind === "point") {
        const light = new THREE.PointLight(color, intensity, range);
        light.castShadow = f.castShadow as boolean;
        return light;
    }

    const light = f.kind === "spot"
        ? new THREE.SpotLight(color, intensity, range, THREE.MathUtils.degToRad(f.angle as number), 0.3)
        : new THREE.DirectionalLight(color, intensity);
    light.target.position.set(0, 0, -1);
    light.add(light.target);
    light.castShadow = f.castShadow as boolean;
    light.shadow.mapSize.set(1024, 1024);

    if (light instanceof THREE.DirectionalLight) {
        const size = f.shadowSize as number;
        const camera = light.shadow.camera;
        camera.left = camera.bottom = -size;
        camera.right = camera.top = size;
        camera.far = 100;
    }
    return light;
}

// The built-in component types; the Inspector is generated from `fields`
export const componentDefs: Record<string, ComponentDef> = {
    mesh: {
        label: "Mesh",
        fields: {
            shape: { type: "select", default: "box", options: ["box", "sphere", "cylinder", "capsule", "plane"] },
            material: { type: "asset", kind: "material", default: "" },
            castShadow: { type: "boolean", default: true },
            receiveShadow: { type: "boolean", default: true },
        },
        create: (f, registry) => {
            const mesh = new THREE.Mesh(createGeometry(f.shape as string), registry.getMaterial(f.material as string));
            mesh.castShadow = f.castShadow as boolean;
            mesh.receiveShadow = f.receiveShadow as boolean;
            return mesh;
        },
    },
    light: {
        label: "Light",
        fields: {
            kind: { type: "select", default: "directional", options: ["directional", "point", "spot"] },
            color: { type: "color", default: "#ffffff" },
            intensity: { type: "number", default: 3, min: 0, step: 0.5 },
            castShadow: { type: "boolean", default: false },
            // point and spot: how far the light reaches, 0 = no limit
            range: { type: "number", default: 0, min: 0, step: 1 },
            // spot: cone half-angle, degrees
            angle: { type: "number", default: 30, min: 1, max: 89, step: 1 },
            // directional: half-size of the area that gets shadows
            shadowSize: { type: "number", default: 10, min: 1, step: 1 },
        },
        create: createLight,
    },
    camera: {
        label: "Camera",
        fields: {
            fov: { type: "number", default: 60, min: 1, max: 179, step: 1 },
            near: { type: "number", default: 0.1, min: 0.001, step: 0.1 },
            far: { type: "number", default: 1000, min: 1, step: 10 },
        },
        create: (f) => new THREE.PerspectiveCamera(f.fov as number, 1, f.near as number, f.far as number),
    },
    // A model built by a project script (defineModel); its own params live in component.params
    model: {
        label: "Model",
        fields: {},
        create: () => new THREE.Group(),
    },
    // A behavior from a project script (defineBehavior); it draws nothing and runs in Play, see runtime.ts.
    // The only type an entity may have several of, one per behavior.
    script: {
        label: "Script",
        fields: {},
        create: () => new THREE.Group(),
    },
};

// Shown instead of a model or prefab that does not exist, so the scene still loads
export function createPlaceholder() {
    return new THREE.Mesh(
        new THREE.BoxGeometry(),
        new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true })
    );
}

function createModelObject(registry: Registry, component: ComponentData) {
    const name = component.model as string;
    const def = registry.getModel(name);
    if (!def) {
        console.warn(`Unknown model "${name}"`);
        return createPlaceholder();
    }
    return def.create({ ...registry.modelDefaults(name), ...(component.params as Params | undefined) });
}

// The three.js object of one component; it becomes a child of the entity's group
export function createComponentObject(registry: Registry, component: ComponentData): THREE.Object3D | null {
    const def = componentDefs[component.type];
    if (!def) {
        console.warn(`Unknown component "${component.type}"`);
        return null;
    }
    if (component.type === "script") return null;

    const obj = component.type === "model"
        ? createModelObject(registry, component)
        : def.create({ ...paramDefaults(def.fields), ...component } as Params, registry);

    obj.userData.component = component.type;
    return obj;
}
