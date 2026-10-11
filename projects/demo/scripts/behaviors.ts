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
        // move() instead of changing position: with a Collider on the object it stops at solid colliders
        self.move(x * step, 0, z * step);
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

// Makes a new instance of a prefab every `interval` seconds, around its own object, and removes the oldest
// ones once there are more than `max`. self.spawn() and self.destroy() are how objects come and go in a
// running game.
export const spawner = defineBehavior({
    name: "spawner",
    label: "Spawner",
    params: {
        prefab: { type: "asset", kind: "prefab", default: "" },
        // Seconds between two instances
        interval: { type: "number", default: 1, min: 0.1, step: 0.1 },
        max: { type: "number", default: 5, min: 1, step: 1 },
        // How far from the spawner an instance may appear, meters
        radius: { type: "number", default: 2, min: 0, step: 0.5 },
    },
    start: () => ({ next: 0, made: [] as THREE.Object3D[] }),
    update: (self) => {
        const { state, params } = self;
        if (!params.prefab || self.time < state.next) return;
        state.next = self.time + params.interval;

        const angle = Math.random() * Math.PI * 2;
        const distance = Math.random() * params.radius;
        const { x, y, z } = self.object.position;
        state.made.push(self.spawn(params.prefab, [x + Math.cos(angle) * distance, y, z + Math.sin(angle) * distance]));
        while (state.made.length > params.max) {
            const oldest = state.made.shift();
            if (oldest) self.destroy(oldest);
        }
    },
    // The spawner goes: so does what it has made
    destroy: (self) => self.state.made.forEach((object) => self.destroy(object)),
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

// Something to collect: when an object that is driven by the player touches it, it disappears.
// The object needs a Collider with "solid" off (a trigger), so that the player walks into it.
export const pickup = defineBehavior({
    name: "pickup",
    label: "Pickup",
    params: {
        // Heard when it is collected
        sound: { type: "asset", kind: "sound", default: "coin.wav" },
    },
    enter: (self, other) => {
        if (!self.get("drive", other)) return;
        // Not a Sound component: that one would go silent with the object. A slightly different pitch every
        // time, so that several in a row do not sound like a machine.
        if (self.params.sound) self.playSound(self.params.sound, { volume: 0.6, pitch: 0.92 + Math.random() * 0.16 });
        self.destroy();
    },
});

// Put it on an object with a Button: every click adds one to the number a Text shows.
// click() is called when the mouse (or a finger) goes down and up on the button.
export const clicker = defineBehavior({
    name: "clicker",
    label: "Clicker",
    params: {
        // Name of the object whose Text shows the count
        label: { type: "string", default: "Score" },
        sound: { type: "asset", kind: "sound", default: "coin.wav" },
    },
    start: () => ({ count: 0 }),
    click: (self) => {
        self.state.count++;
        const label = self.find({ name: self.params.label });
        if (label) self.setText(`Score: ${self.state.count}`, label);
        if (self.params.sound) self.playSound(self.params.sound, { volume: 0.4 });
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
