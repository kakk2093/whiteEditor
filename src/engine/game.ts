import * as THREE from "three";
import { disposeObject, rebuildComponentObject } from "./components";
import { applyEnvironment } from "./environment";
import { Input } from "./input";
import type { EnvironmentData } from "./environment";
import { applyTransform, loadScene } from "./loadScene";
import type { Registry } from "./Registry";
import { Runtime } from "./runtime";
import { SoundPlayer } from "./sound";
import type { EntityData, SceneData } from "./types";

// What a camera component makes
export type SceneCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

// Fits the camera to a picture of this shape (width / height)
export function setCameraAspect(camera: SceneCamera, aspect: number) {
    if (camera instanceof THREE.PerspectiveCamera) {
        if (camera.aspect === aspect) return;
        camera.aspect = aspect;
    } else {
        // The height is the size of the camera, the width follows
        const half = camera.top * aspect;
        if (camera.right === half) return;
        camera.left = -half;
        camera.right = half;
    }
    camera.updateProjectionMatrix();
}

// The first camera component of an active entity
function findCamera(obj: THREE.Object3D): SceneCamera | null {
    if (!obj.visible) return null;
    if (obj.userData.component === "camera" && (obj instanceof THREE.PerspectiveCamera || obj instanceof THREE.OrthographicCamera)) return obj;
    for (const child of obj.children) {
        const found = findCamera(child);
        if (found) return found;
    }
    return null;
}

// The first Sound Listener component of an active entity: its marker object
function findListener(obj: THREE.Object3D): THREE.Object3D | null {
    if (!obj.visible) return null;
    if (obj.userData.listener) return obj;
    for (const child of obj.children) {
        const found = findListener(child);
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

    // What the sounds of the scene are played with; they are heard from where the camera is
    readonly sound: SoundPlayer;

    // The camera of the scene, null if no active entity has a camera component
    camera: SceneCamera | null;

    private registry: Registry;

    // The objects of the scene entities by entity id; of what is inside prefab instances by "<instance id>/<path>"
    private objects = new Map<string, THREE.Object3D>();

    // Builds its own objects; `data` is only read. `globals` is what the behaviors keep from scene to scene:
    // a game of several scenes gives each of them the same object.
    constructor(registry: Registry, data: SceneData, globals: Record<string, unknown> = {}) {
        this.registry = registry;
        applyEnvironment(this.scene, data.environment);
        this.root = loadScene(registry, data);
        this.scene.add(this.root);
        this.root.traverse((obj) => {
            const id = obj.userData.entityId ?? obj.userData.innerId;
            if (id) this.objects.set(id, obj);
        });
        this.camera = findCamera(this.root);
        this.sound = new SoundPlayer(registry);
        this.runtime = new Runtime(registry, this.root, this.input, this.sound);
        this.runtime.camera = this.camera;
        this.runtime.globals = globals;
    }

    start() {
        this.sound.preload();
        this.runtime.start();
        this.hear();
    }

    // dt is in seconds
    update(dt: number) {
        this.runtime.update(dt);
        this.input.endFrame();
        // A behavior may have spawned, destroyed or switched off the camera
        this.camera = findCamera(this.root);
        this.runtime.camera = this.camera;
        this.hear();
    }

    // The sounds are heard by the entity with a Sound Listener, by the camera if there is none
    private hear() {
        this.sound.update(this.camera, findListener(this.root) ?? this.camera);
    }

    // Call when the size of the canvas changes
    resize(width: number, height: number) {
        if (this.camera && height > 0) setCameraAspect(this.camera, width / height);
    }

    // The scene a behavior has asked for with self.loadScene() in the last update, null if none. Whoever
    // runs the game then disposes of it and starts a Game of that scene, with the same globals.
    get requestedScene() {
        return this.runtime.requestedScene;
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
        if (entity.tag) obj.userData.tag = entity.tag;
        else delete obj.userData.tag;
        if (transform) applyTransform(obj, entity, transform);
        this.camera = findCamera(this.root);
        this.runtime.camera = this.camera;
    }

    // A component of the entity was added, removed or changed; `key` is its componentKey()
    syncComponent(entity: EntityData, key: string) {
        const obj = this.objects.get(entity.id);
        if (!obj) return;
        rebuildComponentObject(this.registry, obj, entity, key);
        this.runtime.refresh(obj);
        this.camera = findCamera(this.root);
        this.runtime.camera = this.camera;
    }

    setEnvironment(data: Partial<EnvironmentData>) {
        applyEnvironment(this.scene, data);
    }

    dispose() {
        this.runtime.dispose();
        this.sound.dispose();
        disposeObject(this.root);
    }
}
