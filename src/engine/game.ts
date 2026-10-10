import * as THREE from "three";
import { disposeObject, rebuildComponentObject } from "./components";
import { applyEnvironment } from "./environment";
import { Input } from "./input";
import type { EnvironmentData } from "./environment";
import { applyTransform, loadScene } from "./loadScene";
import type { Registry } from "./Registry";
import { Runtime } from "./runtime";
import type { EntityData, SceneData } from "./types";

// The first camera component of an active entity
function findCamera(obj: THREE.Object3D): THREE.PerspectiveCamera | null {
    if (!obj.visible) return null;
    if (obj.userData.component === "camera" && obj instanceof THREE.PerspectiveCamera) return obj;
    for (const child of obj.children) {
        const found = findCamera(child);
        if (found) return found;
    }
    return null;
}

// A running scene: its three.js objects, environment, camera and behaviors.
// Play in the editor and the built game both go through this class, so they cannot drift apart.
//   const game = new Game(registry, parseScene(json));
//   game.input.attach(canvas); game.resize(width, height); game.start();
//   every frame: game.update(dt); if (game.camera) renderer.render(game.scene, game.camera);
export class Game {
    readonly scene = new THREE.Scene();

    // Holds the entity objects
    readonly root: THREE.Group;

    readonly runtime: Runtime;

    // Keyboard and mouse for the behaviors; it hears nothing until input.attach(canvas) is called
    readonly input = new Input();

    // The camera of the scene, null if no active entity has a camera component
    camera: THREE.PerspectiveCamera | null;

    private registry: Registry;

    // The objects of the scene entities by entity id (not of what is inside prefab instances)
    private objects = new Map<string, THREE.Object3D>();

    // Builds its own objects; `data` is only read
    constructor(registry: Registry, data: SceneData) {
        this.registry = registry;
        applyEnvironment(this.scene, data.environment);
        this.root = loadScene(registry, data);
        this.scene.add(this.root);
        this.root.traverse((obj) => {
            if (obj.userData.entityId) this.objects.set(obj.userData.entityId, obj);
        });
        this.camera = findCamera(this.root);
        this.runtime = new Runtime(registry, this.root, this.input);
    }

    start() {
        this.runtime.start();
    }

    // dt is in seconds
    update(dt: number) {
        this.runtime.update(dt);
        this.input.endFrame();
    }

    // Call when the size of the canvas changes
    resize(width: number, height: number) {
        if (!this.camera || height === 0 || this.camera.aspect === width / height) return;
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
    }

    // The object of a scene entity, by entity id
    getObject(entityId: string) {
        return this.objects.get(entityId) ?? null;
    }

    // The three methods below let the editor change a scene while it runs (edits made during Play).

    // The name or the active flag of the entity changed, and its position, rotation or scale if `transform` is given.
    // Only that one is copied, so e.g. moving an object keeps the rotation its script has given it.
    syncEntity(entity: EntityData, transform?: "position" | "rotation" | "scale") {
        const obj = this.objects.get(entity.id);
        if (!obj) return;
        obj.name = entity.name;
        obj.visible = entity.active ?? true;
        if (transform) applyTransform(obj, entity, transform);
        this.camera = findCamera(this.root);
    }

    // A component of the entity was added, removed or changed; `key` is its componentKey()
    syncComponent(entity: EntityData, key: string) {
        const obj = this.objects.get(entity.id);
        if (!obj) return;
        rebuildComponentObject(this.registry, obj, entity, key);
        this.runtime.refresh(obj);
        this.camera = findCamera(this.root);
    }

    setEnvironment(data: Partial<EnvironmentData>) {
        applyEnvironment(this.scene, data);
    }

    dispose() {
        disposeObject(this.root);
    }
}
