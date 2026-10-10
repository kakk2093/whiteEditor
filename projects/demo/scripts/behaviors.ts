import * as THREE from "three";
import { defineBehavior } from "white-engine";

// Every defineBehavior() exported from a file in scripts/ can be added to an object as a Script component.
// Behaviors run in Play mode.

export const spin = defineBehavior({
    name: "spin",
    label: "Spin",
    params: {
        // Degrees per second
        speed: { type: "number", default: 90, step: 5 },
        axis: { type: "select", default: "y", options: ["x", "y", "z"] },
    },
    update: (self, dt) => {
        self.object.rotation[self.params.axis as "x" | "y" | "z"] += THREE.MathUtils.degToRad(self.params.speed) * dt;
    },
});

// Moves the object over the ground with W A S D or the arrow keys; Shift is faster.
// In the editor the keys reach the scripts in the Game view of Play, not in the Scene view.
export const drive = defineBehavior({
    name: "drive",
    label: "Drive",
    params: {
        // Meters per second
        speed: { type: "number", default: 3, min: 0, step: 0.5 },
    },
    update: (self, dt) => {
        const { input } = self;
        const x = input.axis("KeyA", "KeyD") + input.axis("ArrowLeft", "ArrowRight");
        const z = input.axis("KeyW", "KeyS") + input.axis("ArrowUp", "ArrowDown");
        if (x === 0 && z === 0) return;

        const fast = input.key("ShiftLeft") || input.key("ShiftRight");
        const step = (self.params.speed * (fast ? 2 : 1) * dt) / Math.hypot(x, z);
        self.object.position.x += x * step;
        self.object.position.z += z * step;
    },
});

export const bob = defineBehavior({
    name: "bob",
    label: "Bob",
    params: {
        height: { type: "number", default: 0.3, min: 0, step: 0.05 },
        // Seconds per full swing
        period: { type: "number", default: 2, min: 0.1, step: 0.1 },
    },
    start: (self) => ({ baseY: self.object.position.y }),
    update: (self) => {
        const phase = (self.time / self.params.period) * Math.PI * 2;
        self.object.position.y = self.state.baseY + Math.sin(phase) * self.params.height;
    },
});
