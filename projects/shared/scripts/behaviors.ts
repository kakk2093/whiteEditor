import * as THREE from "three";
import { defineBehavior } from "white-engine";

// Behaviors any game can use. What is exported from the scripts of the project "shared" is known to every
// other project; a behavior of a project with the same name takes its place there.

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

// Removes its object after a while; put it on what should not stay forever
export const lifetime = defineBehavior({
    name: "lifetime",
    label: "Lifetime",
    params: {
        seconds: { type: "number", default: 3, min: 0, step: 0.5 },
    },
    start: (self) => ({ born: self.time }),
    update: (self) => {
        if (self.time - self.state.born >= self.params.seconds) self.destroy();
    },
});

// Keeps the object where it was relative to another one: put it on a camera to follow the player
export const follow = defineBehavior({
    name: "follow",
    label: "Follow",
    params: {
        // Name of the object to follow
        target: { type: "string", default: "Player" },
    },
    start: (self) => {
        const target = self.root.getObjectByName(self.params.target);
        return { offset: target ? self.object.position.clone().sub(target.position) : null };
    },
    update: (self) => {
        const target = self.root.getObjectByName(self.params.target);
        if (target && self.state.offset) self.object.position.copy(target.position).add(self.state.offset);
    },
});

// A character: walks with W A S D, the arrows or the left stick of a gamepad, jumps with Space or the A
// button, falls, and walks up onto ledges not higher than `step`. The object needs a solid Collider.
export const walker = defineBehavior({
    name: "walker",
    label: "Walker",
    params: {
        // Meters per second
        speed: { type: "number", default: 4, min: 0, step: 0.5 },
        // The speed a jump starts with, meters per second; 0 for no jumping
        jump: { type: "number", default: 7, min: 0, step: 0.5 },
        // How high a ledge it walks onto without jumping, meters
        step: { type: "number", default: 0.3, min: 0, step: 0.05 },
    },
    update: (self, dt) => {
        const { input, params } = self;
        const stick = input.stick("left");
        const x = input.axis("KeyA", "KeyD") + input.axis("ArrowLeft", "ArrowRight") + stick.x;
        const z = input.axis("KeyW", "KeyS") + input.axis("ArrowUp", "ArrowDown") - stick.y;
        const length = Math.hypot(x, z);
        if (length > 0) {
            // Not faster along a diagonal; a stick pushed halfway walks at half the speed
            const pace = (params.speed * dt) / Math.max(1, length);
            self.move(x * pace, 0, z * pace, params.step);
        }
        if (params.jump > 0 && (input.keyPressed("Space") || input.keyPressed("Pad0")) && self.grounded()) self.jump(params.jump);
        self.fall(dt);
    },
});
