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
