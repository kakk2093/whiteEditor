import { defineAnimator, defineBehavior, defineClip } from "white-engine";

// Animation clips: keys over time for the place, turn, size and active flag of an object and of what is
// under it. An Animation component plays a clip; a behavior can too: self.animation().play("Open").
// The scene "animation" shows these.

// "relative": counted from where the object stands, so the same clip opens any door
export const open = defineClip({
    name: "Open",
    relative: true,
    tracks: [
        { property: "rotation.y", keys: [{ time: 0, value: 0 }, { time: 0.4, value: 0 }, { time: 1.4, value: 100, ease: "inOut" }, { time: 2, value: 100 }] },
    ],
});

export const bob = defineClip({
    name: "Hover",
    relative: true,
    tracks: [
        { property: "position.y", keys: [{ time: 0, value: 0 }, { time: 1, value: 0.6, ease: "inOut" }, { time: 2, value: 0, ease: "inOut" }] },
        { property: "rotation.y", keys: [{ time: 0, value: 0 }, { time: 2, value: 360 }] },
    ],
});

// Several objects in one clip: `object` is a path of names from the object that plays it
export const crane = defineClip({
    name: "Crane",
    length: 6,
    tracks: [
        { object: "Arm", property: "rotation.y", keys: [{ time: 0, value: 0 }, { time: 2, value: 90, ease: "inOut" }, { time: 4, value: 90 }, { time: 6, value: 0, ease: "inOut" }] },
        { object: "Arm/Hook", property: "position.y", keys: [{ time: 2, value: -0.5 }, { time: 3, value: -1.8, ease: "out" }, { time: 4, value: -0.5, ease: "in" }] },
        // "step": the lamp is off until this very moment
        { object: "Arm/Hook/Lamp", property: "active", keys: [{ time: 0, value: false }, { time: 3, value: true }, { time: 4, value: false }] },
        { object: "Arm/Hook", property: "scale", keys: [{ time: 2.8, value: 1 }, { time: 3, value: 1.5, ease: "out" }, { time: 3.4, value: 1, ease: "in" }] },
    ],
});

// An animator: the states of an object, each with its clip, and what leads from one to another. Here the
// clips are those of the model file (robot.glb has "Wave" and "Walk"); clips of the scripts work the same.
export const robot = defineAnimator({
    name: "robot",
    label: "Robot",
    params: {
        walking: { type: "boolean", default: false },
    },
    start: "Wave",
    states: {
        Wave: { clip: "Wave" },
        Walk: { clip: "Walk", speed: 1.5 },
    },
    transitions: [
        { from: "Wave", to: "Walk", when: (p) => p.walking, fade: 0.3 },
        { from: "Walk", to: "Wave", when: (p) => !p.walking, fade: 0.3 },
    ],
});

// Sets a param of the Animator of its object: now walking, now not
export const pacer = defineBehavior({
    name: "pacer",
    label: "Pacer",
    params: {
        // Seconds in each state
        every: { type: "number", default: 2, min: 0.1, step: 0.1 },
    },
    start: (self) => {
        self.every(self.params.every, () => {
            const animator = self.animator();
            animator?.set("walking", !animator.get("walking"));
        });
    },
});
