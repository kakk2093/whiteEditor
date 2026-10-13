import * as THREE from "three";

// Playing one clip on a three.js mixer: shared by the clips of the scripts (animation.ts) and those of
// the model files (gltf.ts).

// How a clip goes on after its end: again from the start, stops on its last pose, or there and back
export type ClipLoop = "repeat" | "once" | "yoyo";

export interface PlayOptions {
    // true and false are "repeat" and "once"
    loop?: boolean | ClipLoop;
    speed?: number;
    // Seconds over which the clip that was playing gives way to this one
    fade?: number;
}

const loopMode = (loop: PlayOptions["loop"]) => (loop === false || loop === "once" ? THREE.LoopOnce : loop === "yoyo" ? THREE.LoopPingPong : THREE.LoopRepeat);

// Starts `next` on its mixer in place of `previous`
export function startAction(next: THREE.AnimationAction, previous: THREE.AnimationAction | null, options: PlayOptions) {
    next.reset();
    next.setLoop(loopMode(options.loop), Infinity);
    // The last pose of a clip played once stays
    next.clampWhenFinished = true;
    next.timeScale = options.speed ?? 1;
    if (previous && previous !== next && (options.fade ?? 0) > 0) next.crossFadeFrom(previous, options.fade!, false);
    else if (previous && previous !== next) previous.stop();
    next.play();
    return next;
}

// true once a clip that plays once has come to its end
export const actionDone = (action: THREE.AnimationAction | null) => action !== null && action.loop === THREE.LoopOnce && action.paused;
