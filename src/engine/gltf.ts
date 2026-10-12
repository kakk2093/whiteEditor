import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";

// Models made elsewhere (Blender and the like) and kept as files of assets/: glTF, one file (.glb) or a
// .gltf with what it names lying next to it. The component "gltf" shows such a file as a part of an
// entity; its animations play in the running scene.

// The model files assets/ can hold
export const MODEL_FILE = /\.(glb|gltf)$/i;

// The fields of the component, defaults filled in (see components.ts)
export interface ModelFileFields {
    file: string;
    castShadow: boolean;
    receiveShadow: boolean;
    // The clip that plays from the start; "" for none
    animation: string;
    loop: boolean;
    speed: number;
}

export interface PlayOptions {
    loop?: boolean;
    speed?: number;
    // Seconds over which the clip that was playing gives way to this one
    fade?: number;
}

// What a behavior gets from self.animation(): the clips of the model of an object, and playing them
export interface AnimationHandle {
    // The names of the clips the file has; empty until it is loaded
    readonly clips: string[];
    // The clip that plays now, null if none
    readonly playing: string | null;
    // false if the file has no clip of that name (or is not loaded yet)
    play: (name: string, options?: PlayOptions) => boolean;
    stop: () => void;
}

interface ModelState extends AnimationHandle {
    fields: ModelFileFields;
    mixer: THREE.AnimationMixer | null;
}

// Files by address: loaded and read once for the page, however many entities show them
const files = new Map<string, GLTF | Promise<GLTF>>();

// The model of a file: at once if it is loaded already, otherwise a promise of it. null outside of a browser.
export function loadModelFile(url: string): GLTF | Promise<GLTF> | null {
    if (typeof document === "undefined") return null;
    let file = files.get(url);
    if (!file) {
        file = new GLTFLoader().loadAsync(url).then((loaded) => {
            // Every entity that shows the file gets a copy of its objects, but the same geometries and
            // materials: whoever removes one copy must leave them for the others (see disposeObject())
            loaded.scene.traverse((object) => {
                const mesh = object as THREE.Mesh;
                if (!mesh.geometry) return;
                mesh.geometry.userData.shared = true;
                for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.userData.shared = true;
            });
            if (files.get(url) === file) files.set(url, loaded);
            return loaded;
        });
        files.set(url, file);
    }
    return file;
}

// The object of a "gltf" component: empty until the file is there, then a copy of what the file holds
export function createModelFile(fields: ModelFileFields, source: GLTF | Promise<GLTF> | null): THREE.Group {
    const holder = new THREE.Group();
    let clips: THREE.AnimationClip[] = [];
    let action: THREE.AnimationAction | null = null;
    let current: string | null = null;
    const state: ModelState = {
        fields,
        mixer: null,
        get clips() {
            return clips.map((clip) => clip.name);
        },
        get playing() {
            return current;
        },
        play: (name, options = {}) => {
            const clip = clips.find((each) => each.name === name);
            if (!clip || !state.mixer) return false;
            const next = state.mixer.clipAction(clip);
            next.reset();
            next.setLoop(options.loop ?? true ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
            // The last pose of a clip played once stays
            next.clampWhenFinished = true;
            next.timeScale = options.speed ?? 1;
            if (action && action !== next && (options.fade ?? 0) > 0) next.crossFadeFrom(action, options.fade!, false);
            else if (action && action !== next) action.stop();
            next.play();
            action = next;
            current = name;
            return true;
        },
        stop: () => {
            action?.stop();
            action = null;
            current = null;
        },
    };
    holder.userData.gltf = state;

    const fill = (gltf: GLTF) => {
        const model = cloneSkinned(gltf.scene);
        model.traverse((object) => {
            const mesh = object as THREE.Mesh;
            if (!mesh.isMesh) return;
            mesh.castShadow = fields.castShadow;
            mesh.receiveShadow = fields.receiveShadow;
        });
        holder.add(model);
        clips = gltf.animations;
        if (clips.length > 0) {
            state.mixer = new THREE.AnimationMixer(model);
            if (fields.animation && !state.play(fields.animation, { loop: fields.loop, speed: fields.speed })) {
                console.warn(`Model "${fields.file}" has no animation "${fields.animation}" (it has: ${state.clips.join(", ")})`);
            }
        } else if (fields.animation) {
            console.warn(`Model "${fields.file}" has no animations, "${fields.animation}" cannot play`);
        }
    };
    if (source instanceof Promise) source.then(fill).catch(() => console.warn(`Model "${fields.file}" could not be loaded`));
    else if (source) fill(source);
    return holder;
}

// The model file of an entity object, to play its animations; null if it has no "gltf" component
export function animationOf(object: THREE.Object3D): AnimationHandle | null {
    return (object.children.find((child) => child.userData.gltf)?.userData.gltf as ModelState | undefined) ?? null;
}

// Moves the animations of every model under `root` by dt seconds. `active` tells whether an entity takes part.
export function updateModelFiles(root: THREE.Object3D, dt: number, active: (object: THREE.Object3D) => boolean) {
    root.traverse((object) => {
        const state = object.userData.gltf as ModelState | undefined;
        if (state?.mixer && object.parent && active(object.parent)) state.mixer.update(dt);
    });
}
