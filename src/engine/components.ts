import * as THREE from "three";
import { paramDefaults } from "./Registry";
import type { ParamDef, Registry } from "./Registry";
import type { ComponentData, EntityData, Params } from "./types";

// What a component can take from the project's scripts/: a code model, a behavior
export interface SourceDef {
    name: string;
    label?: string;
    params?: Record<string, ParamDef>;
}

// For components whose content is defined in scripts/ and picked by name
export interface ComponentSource {
    // The component field that holds the name; the params of the picked definition live in component.params
    key: string;
    // What it is called in messages: "model", "behavior"
    what: string;
    get: (registry: Registry, name: string) => SourceDef | undefined;
    list: (registry: Registry) => SourceDef[];
}

export interface ComponentDef {
    label: string;
    fields: Record<string, ParamDef>;
    // Builds the three.js object from the fields (defaults filled in); missing if the component draws nothing
    create?: (fields: Params, registry: Registry, component: ComponentData) => THREE.Object3D;
    source?: ComponentSource;
    // An entity may have several, one per source name; every other type is allowed once
    multiple?: boolean;
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
            range: { type: "number", default: 0, min: 0, step: 1, when: { kind: ["point", "spot"] } },
            // spot: cone half-angle, degrees
            angle: { type: "number", default: 30, min: 1, max: 89, step: 1, when: { kind: ["spot"] } },
            // directional: half-size of the area that gets shadows
            shadowSize: { type: "number", default: 10, min: 1, step: 1, when: { kind: ["directional"], castShadow: [true] } },
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
    // A model built by a project script (defineModel)
    model: {
        label: "Model",
        fields: {},
        create: (_fields, registry, component) => createModelObject(registry, component),
        source: {
            key: "model",
            what: "model",
            get: (registry, name) => registry.getModel(name),
            list: (registry) => registry.models(),
        },
    },
    // A behavior from a project script (defineBehavior); it draws nothing and runs in Play, see runtime.ts
    script: {
        label: "Script",
        fields: {},
        source: {
            key: "script",
            what: "behavior",
            get: (registry, name) => registry.getBehavior(name),
            list: (registry) => registry.behaviors(),
        },
        multiple: true,
    },
};

// Tells the components of one entity apart: "mesh", "light", "script:spin"
export function componentKey(component: ComponentData) {
    const def = componentDefs[component.type];
    return def?.multiple && def.source ? `${component.type}:${component[def.source.key]}` : component.type;
}

export function findComponent(entity: EntityData, key: string) {
    return entity.components.find((c) => componentKey(c) === key) ?? null;
}

// Behaviors have no three.js object of their own; the Runtime starts them from the group of their entity
export function setScripts(group: THREE.Object3D, components: ComponentData[]) {
    const scripts = components.filter((c) => c.type === "script");
    if (scripts.length > 0) group.userData.scripts = scripts;
    else delete group.userData.scripts;
}

// Frees the GPU resources of an object that was removed from the scene
export function disposeObject(obj: THREE.Object3D) {
    obj.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.geometry) return;
        mesh.geometry.dispose();
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        // Material assets are shared between meshes and owned by the registry
        materials.forEach((m) => {
            if (!m.userData.shared) m.dispose();
        });
    });
}

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
    if (!def.create) return null;

    const obj = def.create({ ...paramDefaults(def.fields), ...component } as Params, registry, component);
    obj.userData.component = componentKey(component);
    return obj;
}

// Replaces the three.js object of one component of the entity after the component was added, removed or changed.
// `group` is the object of the entity, `key` is the componentKey() of the component.
export function rebuildComponentObject(registry: Registry, group: THREE.Object3D, entity: EntityData, key: string) {
    const old = group.children.find((c) => c.userData.component === key);
    if (old) {
        group.remove(old);
        disposeObject(old);
    }
    setScripts(group, entity.components);
    const component = findComponent(entity, key);
    const created = component && createComponentObject(registry, component);
    if (created) group.add(created);
}
