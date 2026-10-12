import * as THREE from "three";
import { defineBehavior } from "white-engine";

// The game of this project: a small level to walk, jump and collect coins in, a menu before it and a
// result after it. Every behavior here is a Script component of some object of the scenes.

// The player: W A S D or the arrows (or the left stick), Space (or the A button) jumps. Walks up onto low
// ledges, falls, and comes back to where it started after a fall off the level or a touch of a hazard.
// The object needs a solid Collider and the tag "player".
export const hero = defineBehavior({
    name: "hero",
    label: "Hero",
    params: {
        speed: { type: "number", default: 4, min: 0, step: 0.5 },
        jump: { type: "number", default: 7.5, min: 0, step: 0.5 },
        step: { type: "number", default: 0.3, min: 0, step: 0.05 },
        // Below this height the player has fallen off the level
        floor: { type: "number", default: -6, step: 1 },
    },
    start: (self) => {
        const home = self.object.position.clone();
        return {
            respawn: () => {
                self.object.position.copy(home);
                // Not with the speed of the fall
                self.jump(0);
                self.globals.falls = Number(self.globals.falls ?? 0) + 1;
            },
        };
    },
    update: (self, dt) => {
        const { input, params } = self;
        const stick = input.stick("left");
        const x = input.axis("KeyA", "KeyD") + input.axis("ArrowLeft", "ArrowRight") + stick.x;
        const z = input.axis("KeyW", "KeyS") + input.axis("ArrowUp", "ArrowDown") - stick.y;
        const length = Math.hypot(x, z);
        if (length > 0) {
            const pace = (params.speed * dt) / Math.max(1, length);
            self.move(x * pace, 0, z * pace, params.step);
        }
        if ((input.keyPressed("Space") || input.keyPressed("Pad0")) && self.grounded()) self.jump(params.jump);
        self.fall(dt);
        if (self.object.position.y < params.floor) self.state.respawn();
    },
});

// On the camera: keeps the place it has relative to the object with the tag, catching up smoothly
export const chase = defineBehavior({
    name: "chase",
    label: "Chase",
    params: {
        tag: { type: "string", default: "player" },
        // How fast it catches up; bigger is stiffer
        speed: { type: "number", default: 5, min: 0.1, step: 0.5 },
    },
    start: (self) => {
        const target = self.find({ tag: self.params.tag });
        return { offset: target ? self.object.position.clone().sub(target.position) : null };
    },
    update: (self, dt) => {
        const target = self.find({ tag: self.params.tag });
        if (!target || !self.state.offset) return;
        const goal = target.position.clone().add(self.state.offset);
        self.object.position.lerp(goal, 1 - Math.exp(-dt * self.params.speed));
    },
});

// A coin: turns, and is collected by the player walking into it (a Collider with "solid" off). The count is
// kept in self.globals, so the result scene knows it.
export const coin = defineBehavior({
    name: "coin",
    label: "Coin",
    params: {
        // Name of an object with Particles that sparkles where a coin was collected
        sparks: { type: "string", default: "Sparks" },
    },
    update: (self, dt) => {
        self.object.rotation.y += dt * 3;
    },
    enter: (self, other) => {
        if (other.userData.tag !== "player") return;
        self.globals.coins = Number(self.globals.coins ?? 0) + 1;
        const sparks = self.find({ name: self.params.sparks });
        if (sparks) {
            sparks.position.copy(self.object.position);
            self.particles(sparks)?.emit(24);
        }
        self.destroy();
    },
});

// On a Text of the interface: starts the count of the level and shows it every frame
export const hud = defineBehavior({
    name: "hud",
    label: "HUD",
    start: (self) => {
        self.globals.coins = 0;
        self.globals.falls = 0;
        self.globals.total = self.findAll({ behavior: "coin" }).length;
    },
    update: (self) => {
        self.setText(`Coins: ${self.globals.coins} / ${self.globals.total}`);
    },
});

// Something that must not be touched: goes back and forth along an axis, and the player who walks into it
// (a Collider with "solid" off) starts over
export const hazard = defineBehavior({
    name: "hazard",
    label: "Hazard",
    params: {
        axis: { type: "select", default: "z", options: ["x", "y", "z"] },
        distance: { type: "number", default: 4, step: 0.5 },
        // Seconds one way
        seconds: { type: "number", default: 2, min: 0.1, step: 0.1 },
    },
    start: (self) => {
        const axis = self.params.axis as "x" | "y" | "z";
        self.tween(self.object.position, { [axis]: self.object.position[axis] + self.params.distance }, self.params.seconds, { loop: "yoyo", ease: "inOut" });
    },
    enter: (self, other) => {
        if (other.userData.tag === "player") self.get<{ respawn: () => void }>("hero", other)?.state.respawn();
    },
});

// A platform that goes up and down for ever
export const lift = defineBehavior({
    name: "lift",
    label: "Lift",
    params: {
        height: { type: "number", default: 3, step: 0.5 },
        seconds: { type: "number", default: 3, min: 0.1, step: 0.1 },
    },
    start: (self) => {
        self.tween(self.object.position, { y: self.object.position.y + self.params.height }, self.params.seconds, { loop: "yoyo", ease: "inOut" });
    },
});

// The way out of a scene: the player walks into it (a Collider with "solid" off)
export const door = defineBehavior({
    name: "door",
    label: "Door",
    params: {
        scene: { type: "asset", kind: "scene", default: "" },
    },
    enter: (self, other) => {
        if (other.userData.tag === "player" && self.params.scene) self.loadScene(self.params.scene);
    },
});

// On a Button: a click opens another scene
export const goto = defineBehavior({
    name: "goto",
    label: "Go To Scene",
    params: {
        scene: { type: "asset", kind: "scene", default: "" },
    },
    click: (self) => {
        if (self.params.scene) self.loadScene(self.params.scene);
    },
});

// On a Text of the interface: tells how the level went
export const result = defineBehavior({
    name: "result",
    label: "Result",
    start: (self) => {
        const coins = Number(self.globals.coins ?? 0);
        const total = Number(self.globals.total ?? 0);
        const falls = Number(self.globals.falls ?? 0);
        self.setText(`${coins} of ${total} coins\n${falls === 0 ? "without a single fall" : `fell ${falls} ${falls === 1 ? "time" : "times"}`}`);
    },
});

// Turns its object: something to look at behind a menu
export const turn = defineBehavior({
    name: "turn",
    label: "Turn",
    params: {
        speed: { type: "number", default: 40, step: 5 },
    },
    update: (self, dt) => {
        self.object.rotation.y += THREE.MathUtils.degToRad(self.params.speed) * dt;
    },
});
