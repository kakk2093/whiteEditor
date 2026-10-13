import * as THREE from "three";
import { actionDone, startAction } from "./clipAction";
import type { ClipLoop, PlayOptions } from "./clipAction";
import { modelClipsOf } from "./gltf";
import { paramDefaults } from "./Registry";
import type { Ease, ParamDef, ParamType, Registry } from "./Registry";
import type { Params, ParamValue, Vec3 } from "./types";

// Animation of the objects of a scene.
//
// A clip is keys over time for the place, turn, size and active flag of an object and of what is under it.
// It is written in a script of the project (defineClip) and played by the component "animation", or by a
// behavior: self.animation()?.play("Open"). The clips a model file brings (the component "gltf") are played
// the same way, by their names in the file.
//
// An animator (defineAnimator, the component "animator") is the states an object can be in, each with its
// clip, and what takes it from one to another: the usual way to switch between Idle, Walk and Jump.

export interface KeyDef {
    // Seconds from the start of the clip
    time: number;
    // [x, y, z] for "position", "rotation" (degrees) and "scale"; a number for one axis ("position.y") and for
    // an even "scale"; true or false for "active"
    value: Vec3 | number | boolean;
    // How the value gets here from the key before: evenly, starting slowly, ending slowly, both, or "step":
    // it stays as it was and jumps here at this moment
    ease?: Ease | "step";
}

export const CLIP_PROPERTIES = [
    "position", "rotation", "scale", "active",
    "position.x", "position.y", "position.z", "rotation.x", "rotation.y", "rotation.z", "scale.x", "scale.y", "scale.z",
] as const;

export interface TrackDef {
    // The object the keys move: a path of names from the object that plays the clip ("Arm/Hand"); missing or
    // "" is that object itself
    object?: string;
    property: (typeof CLIP_PROPERTIES)[number];
    keys: KeyDef[];
}

export interface ClipDef {
    kind: "clip";
    name: string;
    label?: string;
    // Seconds; without it the clip ends at its last key
    length?: number;
    // true: the values are counted from where the object was when the clip started, not from zero: the same
    // "Open" then turns any door by 90 degrees, wherever it stands and however it is turned
    relative?: boolean;
    tracks: TrackDef[];
}

// Used by project scripts:
// export const open = defineClip({ name: "Open", relative: true, tracks: [{ property: "rotation.y", keys: [{ time: 0, value: 0 }, { time: 1, value: 90, ease: "out" }] }] })
export function defineClip(def: Omit<ClipDef, "kind">): ClipDef {
    return { kind: "clip", ...def };
}

export function isClipDef(value: unknown): value is ClipDef {
    return typeof value === "object" && value !== null && (value as ClipDef).kind === "clip";
}

// What a behavior gets from self.animation(): the clips an object can play, and playing them
export interface AnimationHandle {
    // The clips of the model file of the object (empty until it is loaded), then the clips of the scripts
    readonly clips: string[];
    // The clip that was played last and has not been stopped, null if none
    readonly playing: string | null;
    // true once a clip that plays once has come to its end
    readonly done: boolean;
    // false if there is no clip of that name
    play: (name: string, options?: PlayOptions) => boolean;
    // Ends the clip; what it moved goes back to where it was before the clip
    stop: () => void;
}

const EASES: Record<Ease, (t: number) => number> = {
    linear: (t) => t,
    in: (t) => t * t,
    out: (t) => 1 - (1 - t) * (1 - t),
    inOut: (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
};

// How many straight pieces stand in for a curved stretch between two keys
const EASE_STEPS = 8;

// The keys of one number as the times and values of a three.js track, the easing drawn out into short
// straight pieces
function sample(keys: { time: number; value: number; ease?: KeyDef["ease"] }[]) {
    const times: number[] = [];
    const values: number[] = [];
    keys.forEach((key, i) => {
        const before = keys[i - 1];
        if (before && key.time > before.time) {
            if (key.ease === "step") {
                times.push(key.time - 1e-4);
                values.push(before.value);
            } else if (key.ease && key.ease !== "linear") {
                for (let n = 1; n < EASE_STEPS; n++) {
                    times.push(before.time + ((key.time - before.time) * n) / EASE_STEPS);
                    values.push(before.value + (key.value - before.value) * EASES[key.ease](n / EASE_STEPS));
                }
            }
        }
        times.push(key.time);
        values.push(key.value);
    });
    return { times, values };
}

// The object a track names, from the object that plays the clip. Each name is looked for among the
// children first, then deeper: so "Head" reaches a part of the model file of the object.
function resolve(root: THREE.Object3D, path = "") {
    let object: THREE.Object3D | undefined = root;
    for (const name of path.split("/").filter(Boolean)) {
        const from: THREE.Object3D | undefined = object;
        object = from?.children.find((child) => child.name === name) ?? from?.children.map((child) => child.getObjectByName(name)).find(Boolean);
    }
    return object ?? null;
}

// The clip as three.js plays it, for the objects under `root`; the tracks that name nothing there are told in `missing`
function buildClip(def: ClipDef, root: THREE.Object3D, missing: string[]) {
    const tracks: THREE.KeyframeTrack[] = [];
    let end = 0;
    for (const track of def.tracks) {
        const target = resolve(root, track.object);
        if (!target) {
            missing.push(track.object ?? "");
            continue;
        }
        const keys = [...track.keys].sort((a, b) => a.time - b.time);
        if (keys.length === 0) continue;
        end = Math.max(end, keys[keys.length - 1].time);
        const [property, axis] = track.property.split(".");
        if (property === "active") {
            tracks.push(new THREE.BooleanKeyframeTrack(`${target.uuid}.visible`, keys.map((key) => key.time), keys.map((key) => Boolean(key.value))));
            continue;
        }
        // Each axis is a number of its own: a turn can then go past 180 degrees, and "position.y" alone
        // leaves the other two to whoever else moves the object
        (axis ? [axis] : ["x", "y", "z"]).forEach((name, i) => {
            const numbers = keys.map((key) => {
                const value = Array.isArray(key.value) ? key.value[axis ? 0 : i] : Number(key.value);
                return { time: key.time, value: property === "rotation" ? THREE.MathUtils.degToRad(value) : value, ease: key.ease };
            });
            const { times, values } = sample(numbers);
            tracks.push(new THREE.NumberKeyframeTrack(`${target.uuid}.${property}[${name}]`, times, values));
        });
    }
    const clip = new THREE.AnimationClip(def.name, def.length ?? end, tracks);
    // Counted from the pose the object has, not from zero
    if (def.relative) clip.blendMode = THREE.AdditiveAnimationBlendMode;
    return clip;
}

// Plays the clips of scripts on one entity object
class ClipPlayer {
    private mixer: THREE.AnimationMixer;
    private root: THREE.Object3D;
    // The three.js clips made so far, each with the definition it was made from
    private built = new Map<string, { def: ClipDef; clip: THREE.AnimationClip }>();
    private action: THREE.AnimationAction | null = null;
    current: string | null = null;

    constructor(root: THREE.Object3D) {
        this.root = root;
        this.mixer = new THREE.AnimationMixer(root);
    }

    play(def: ClipDef, options: PlayOptions = {}) {
        let made = this.built.get(def.name);
        // A script that was edited gives another definition under the same name
        if (made?.def !== def) {
            if (made) this.mixer.uncacheClip(made.clip);
            const missing: string[] = [];
            made = { def, clip: buildClip(def, this.root, missing) };
            this.built.set(def.name, made);
            if (missing.length > 0) console.warn(`Clip "${def.name}" on "${this.root.name}": no object "${missing.join('", "')}" under it`);
        }
        this.action = startAction(this.mixer.clipAction(made.clip), this.action, options);
        this.current = def.name;
    }

    stop() {
        this.action?.stop();
        this.action = null;
        this.current = null;
    }

    get done() {
        return actionDone(this.action);
    }

    update(dt: number) {
        this.mixer.update(dt);
    }
}

function playerOf(object: THREE.Object3D, create: boolean) {
    let player = object.userData.clipPlayer as ClipPlayer | undefined;
    if (!player && create) object.userData.clipPlayer = player = new ClipPlayer(object);
    return player ?? null;
}

// The animations of an entity object: the clips of its model file, if it has one, and the clips of the scripts
export function animationOf(object: THREE.Object3D, registry: Registry): AnimationHandle {
    const file = () => modelClipsOf(object);
    // Which of the two played last: its clip is the one that is "playing"
    const last = () => (object.userData.lastClip as "file" | "script" | undefined) ?? null;
    return {
        get clips() {
            return [...new Set([...(file()?.clips ?? []), ...registry.clips().map((def) => def.name)])];
        },
        get playing() {
            return last() === "file" ? file()?.playing ?? null : playerOf(object, false)?.current ?? null;
        },
        get done() {
            return last() === "file" ? file()?.done ?? false : playerOf(object, false)?.done ?? false;
        },
        play: (name, options) => {
            // A clip of the model file wins: the file is what the object looks like
            if (file()?.play(name, options)) {
                object.userData.lastClip = "file";
                return true;
            }
            const def = registry.getClip(name);
            if (!def) return false;
            playerOf(object, true)!.play(def, options);
            object.userData.lastClip = "script";
            return true;
        },
        stop: () => {
            file()?.stop();
            playerOf(object, false)?.stop();
            delete object.userData.lastClip;
        },
    };
}

// ---------- the animator ----------

export interface AnimatorStateDef {
    // A clip of the scripts or of the model file of the object
    clip: string;
    // "repeat" by default
    loop?: boolean | ClipLoop;
    speed?: number;
}

export interface AnimatorTransition<P = Params> {
    // The state, or the states, it leads out of; without it, out of any state
    from?: string | string[];
    to: string;
    // Leads on while this is true. `time` is how long the object has been in its state, seconds.
    when?: (params: P, time: number) => boolean;
    // Leads on only after this many seconds in the state, or, with "end", once its clip has played to the end
    after?: number | "end";
    // Seconds over which the clips blend
    fade?: number;
}

export interface AnimatorDef {
    kind: "animator";
    name: string;
    label?: string;
    // What the transitions look at; a behavior sets them: self.animator()?.set("speed", 2)
    params?: Record<string, ParamDef>;
    // The state the object starts in
    start: string;
    states: Record<string, AnimatorStateDef>;
    transitions?: AnimatorTransition[];
}

// Used by project scripts:
// export const walker = defineAnimator({
//     name: "walker", params: { speed: { type: "number", default: 0 } }, start: "Idle",
//     states: { Idle: { clip: "Idle" }, Walk: { clip: "Walk" } },
//     transitions: [{ from: "Idle", to: "Walk", when: (p) => p.speed > 0.1, fade: 0.2 }, { from: "Walk", to: "Idle", when: (p) => p.speed <= 0.1, fade: 0.2 }],
// })
export function defineAnimator<P extends Record<string, ParamDef> = Record<string, never>>(def: {
    name: string;
    label?: string;
    params?: P;
    start: string;
    states: Record<string, AnimatorStateDef>;
    transitions?: AnimatorTransition<{ [K in keyof P]: ParamType<P[K]> }>[];
}): AnimatorDef {
    return { kind: "animator", ...def } as AnimatorDef;
}

export function isAnimatorDef(value: unknown): value is AnimatorDef {
    return typeof value === "object" && value !== null && (value as AnimatorDef).kind === "animator";
}

// What a behavior gets from self.animator()
export interface AnimatorHandle {
    // The state the object is in, and for how many seconds
    readonly state: string;
    readonly time: number;
    get: (param: string) => ParamValue | undefined;
    set: (param: string, value: ParamValue) => void;
    // Makes a param true until the next transition happens: for what is done once, a jump or a hit
    trigger: (param: string) => void;
    // Puts the object into the state at once, whatever the transitions say
    go: (state: string, fade?: number) => boolean;
}

// The fields the component "animator" leaves on its marker object
interface AnimatorFields {
    animator: string;
    params: Params;
}

class AnimatorRun implements AnimatorHandle {
    state = "";
    time = 0;
    private def: AnimatorDef;
    private params: Params;
    private triggers = new Set<string>();
    private animation: AnimationHandle;
    private warned = new Set<string>();

    constructor(def: AnimatorDef, params: Params, animation: AnimationHandle) {
        this.def = def;
        this.params = { ...paramDefaults(def.params ?? {}), ...params };
        this.animation = animation;
    }

    get(param: string) {
        return this.params[param];
    }

    set(param: string, value: ParamValue) {
        this.params[param] = value;
    }

    trigger(param: string) {
        this.params[param] = true;
        this.triggers.add(param);
    }

    go(state: string, fade = 0) {
        const def = this.def.states[state];
        if (!def) return false;
        this.state = state;
        this.time = 0;
        for (const param of this.triggers) this.params[param] = false;
        this.triggers.clear();
        const played = this.animation.play(def.clip, { loop: def.loop ?? "repeat", speed: def.speed, fade });
        // The clips of a model file are there only once the file is loaded: the state waits for them
        this.waiting = !played;
        return true;
    }

    // The clip of the state could not be started yet
    private waiting = false;

    update(dt: number) {
        if (!this.state) {
            if (!this.go(this.def.start) && !this.warned.has(this.def.start)) {
                this.warned.add(this.def.start);
                console.warn(`Animator "${this.def.name}": there is no start state "${this.def.start}"`);
            }
            return;
        }
        if (this.waiting) {
            const def = this.def.states[this.state];
            this.waiting = !this.animation.play(def.clip, { loop: def.loop ?? "repeat", speed: def.speed });
            if (this.waiting && this.time > 2 && !this.warned.has(def.clip)) {
                this.warned.add(def.clip);
                console.warn(`Animator "${this.def.name}", state "${this.state}": there is no clip "${def.clip}" (there are: ${this.animation.clips.join(", ") || "none"})`);
            }
        }
        this.time += dt;
        // A few in a row at most: states that lead into each other at once must not hang the game
        for (let n = 0; n < 4; n++) {
            const next = (this.def.transitions ?? []).find((transition) => {
                const from = transition.from === undefined ? null : Array.isArray(transition.from) ? transition.from : [transition.from];
                if (transition.to === this.state || (from && !from.includes(this.state) && !from.includes("*"))) return false;
                if (transition.after === "end" ? !this.animation.done : this.time < (transition.after ?? 0)) return false;
                return transition.when ? transition.when(this.params, this.time) : true;
            });
            if (!next) return;
            if (!this.go(next.to, next.fade) && !this.warned.has(next.to)) {
                this.warned.add(next.to);
                console.warn(`Animator "${this.def.name}": a transition leads to "${next.to}", and there is no such state`);
                return;
            }
        }
    }
}

// The animator of an entity object; null if it has no "animator" component, or nothing has run it yet
export function animatorOf(object: THREE.Object3D): AnimatorHandle | null {
    return (object.userData.animatorRun as AnimatorRun | undefined) ?? null;
}

// The fields of the component "animation", defaults filled in (see components.ts)
interface AnimationFields {
    clip: string;
    autoplay: boolean;
    loop: ClipLoop;
    speed: number;
}

// Moves the animations of the scripts under `root` by dt seconds: starts the "animation" components that
// have just appeared, runs the animators, then moves the clips. `active` tells whether an entity takes part.
export function updateAnimations(root: THREE.Object3D, dt: number, active: (object: THREE.Object3D) => boolean, registry: Registry) {
    root.traverse((object) => {
        const owner = object.parent;
        const fields = object.userData.animation as AnimationFields | undefined;
        if (fields && owner && !object.userData.started && active(owner)) {
            object.userData.started = true;
            if (fields.autoplay && fields.clip && !animationOf(owner, registry).play(fields.clip, { loop: fields.loop, speed: fields.speed })) {
                console.warn(`"${owner.name}": there is no clip "${fields.clip}"`);
            }
        }
        const animator = object.userData.animator as AnimatorFields | undefined;
        if (animator && owner && active(owner)) {
            let run = owner.userData.animatorRun as AnimatorRun | undefined;
            if (!run) {
                const def = registry.getAnimator(animator.animator);
                if (def) owner.userData.animatorRun = run = new AnimatorRun(def, animator.params, animationOf(owner, registry));
                else if (!object.userData.started) console.warn(`Unknown animator "${animator.animator}"`);
                object.userData.started = true;
            }
            try {
                run?.update(dt);
            } catch (e) {
                console.error(`The animator of "${owner.name}" stopped:`, e);
                delete object.userData.animator;
            }
        }
    });
    // After the animators, and for every object anew: a clip started in this frame moves in this frame
    root.traverse((object) => {
        const player = object.userData.clipPlayer as ClipPlayer | undefined;
        if (player && active(object)) player.update(dt);
    });
}
