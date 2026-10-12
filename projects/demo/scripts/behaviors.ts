import * as THREE from "three";
import { defineBehavior } from "white-engine";

// Every defineBehavior() exported from a file in scripts/ can be added to an object as a Script component.
// Behaviors run in Play mode.

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

// Put it on an object with a Slider or an Input Field: what the player sets there is shown by the Text of
// another object. change() comes with every move of the slider and every letter, submit() with Enter.
export const echo = defineBehavior({
    name: "echo",
    label: "Echo",
    params: {
        // Name of the object whose Text shows the value
        label: { type: "string", default: "" },
        prefix: { type: "string", default: "" },
        // Wait for Enter instead of showing every letter (an Input Field)
        onSubmit: { type: "boolean", default: false },
        // Name of an object with the "spin" behavior: a number becomes its speed
        spin: { type: "string", default: "" },
    },
    change: (self, value) => {
        if (self.params.onSubmit) return;
        const label = self.find({ name: self.params.label });
        if (label) self.setText(self.params.prefix + value, label);
        const spinning = self.params.spin ? self.find({ name: self.params.spin }) : null;
        const spin = spinning && self.get("spin", spinning);
        if (spin && typeof value === "number") spin.params.speed = value;
    },
    submit: (self, value) => {
        const label = self.find({ name: self.params.label });
        if (label) self.setText(self.params.prefix + value, label);
    },
});

// Interface made with HTML instead of drawn: a line of text and a button in self.overlay, the page element
// over the picture. Sizes use var(--unit), one unit of the interface, so they follow the size of the picture.
export const htmlBadge = defineBehavior({
    name: "htmlBadge",
    label: "HTML Badge",
    params: {
        text: { type: "string", default: "Made with HTML" },
    },
    start: (self) => {
        const box = document.createElement("div");
        box.style.cssText =
            "position: absolute; left: calc(var(--unit) * 16); bottom: calc(var(--unit) * 16); padding: calc(var(--unit) * 8) calc(var(--unit) * 12);" +
            "font: calc(var(--unit) * 18) sans-serif; color: #fff; background: rgba(16, 24, 32, 0.85); border-radius: calc(var(--unit) * 6); pointer-events: auto;";
        const label = document.createElement("span");
        const button = document.createElement("button");
        button.textContent = "+1";
        button.style.cssText = "margin-left: calc(var(--unit) * 10); font: inherit; cursor: pointer;";
        let count = 0;
        const show = () => (label.textContent = `${self.params.text}: ${count}`);
        button.onclick = () => {
            count++;
            show();
        };
        show();
        box.append(label, button);
        // Nothing to add it to where there is no page (a check from the command line)
        self.overlay?.append(box);
        return { box };
    },
    // The overlay is emptied with the scene, but this object may be removed before that
    destroy: (self) => self.state.box.remove(),
});

// Looks for the object with a tag and tells on its Label whether it is seen: a ray towards it (self.raycast)
// that reaches it before anything solid does. The object itself needs no Collider.
export const watcher = defineBehavior({
    name: "watcher",
    label: "Watcher",
    params: {
        // Whom it looks for (the Tag of the object)
        tag: { type: "string", default: "player" },
        // How far it sees, meters
        distance: { type: "number", default: 12, min: 0, step: 1 },
    },
    start: () => ({ seen: null as boolean | null }),
    update: (self) => {
        const target = self.find({ tag: self.params.tag });
        if (!target) return;
        const from = self.object.getWorldPosition(new THREE.Vector3());
        const towards = target.getWorldPosition(new THREE.Vector3()).sub(from);
        const seen = self.raycast(from, towards, { distance: self.params.distance })?.object === target;
        if (seen === self.state.seen) return;
        self.state.seen = seen;
        self.setText(seen ? "I see you" : "...");
    },
});

// A door to another scene: an object with the tag walks into it (a Collider with "solid" off) and the scene
// changes (self.loadScene). How many times a scene with a portal was entered is kept in self.globals, which
// outlive the scene, and is shown on the Label of the object.
export const portal = defineBehavior({
    name: "portal",
    label: "Portal",
    params: {
        scene: { type: "asset", kind: "scene", default: "" },
        // Who goes through (the Tag of the object)
        tag: { type: "string", default: "player" },
    },
    start: (self) => {
        const visits = Number(self.globals.visits ?? 0) + 1;
        self.globals.visits = visits;
        self.setText(`Visit ${visits}`);
    },
    enter: (self, other) => {
        if (other.userData.tag === self.params.tag && self.params.scene) self.loadScene(self.params.scene);
    },
});

// Grows and shrinks its object for ever: a tween that goes there and back (self.tween with loop "yoyo")
export const pulse = defineBehavior({
    name: "pulse",
    label: "Pulse",
    params: {
        // How many times bigger it gets
        scale: { type: "number", default: 1.4, min: 0.1, step: 0.1 },
        // Seconds one way
        seconds: { type: "number", default: 0.6, min: 0.05, step: 0.05 },
    },
    start: (self) => {
        const { x, y, z } = self.object.scale;
        const k = self.params.scale;
        self.tween(self.object.scale, { x: x * k, y: y * k, z: z * k }, self.params.seconds, { ease: "inOut", loop: "yoyo" });
    },
});

// Every few seconds throws out a burst of its Particles and counts them on its Label (self.every)
export const burst = defineBehavior({
    name: "burst",
    label: "Burst",
    params: {
        seconds: { type: "number", default: 1, min: 0.1, step: 0.1 },
        count: { type: "number", default: 30, min: 1, step: 5 },
    },
    start: (self) => {
        const state = { bursts: 0 };
        self.every(self.params.seconds, () => {
            state.bursts++;
            self.particles()?.emit(self.params.count);
            self.setText(`x${state.bursts}`);
        });
        return state;
    },
});

// Day and night: put it on the sun. Turns the light around and changes the sky and the ambient light with
// its height (self.setEnvironment).
export const dayNight = defineBehavior({
    name: "dayNight",
    label: "Day and Night",
    params: {
        // Seconds a whole day takes
        period: { type: "number", default: 60, min: 1, step: 5 },
        // Where the day starts: 0 sunrise, 0.25 noon, 0.5 sunset, 0.75 midnight
        start: { type: "number", default: 0.25, min: 0, max: 1, step: 0.05 },
    },
    // The light of the Light component of the same object, and how bright it is at noon
    start: (self) => {
        const light = self.object.children.find((child) => (child as THREE.Light).isLight) as THREE.Light | undefined;
        return { light, noon: light?.intensity ?? 0 };
    },
    update: (self) => {
        const day = (self.params.start + self.time / self.params.period) % 1;
        // The sun goes over the scene from one side to the other; a light shines along its own -Z
        self.object.rotation.set(-day * Math.PI * 2, THREE.MathUtils.degToRad(30), 0, "YXZ");
        // 1 at noon, 0 at the horizon and all night
        const height = Math.max(0, Math.sin(day * Math.PI * 2));
        const mix = (night: string, noon: string) => `#${new THREE.Color(night).lerp(new THREE.Color(noon), height).getHexString()}`;
        self.setEnvironment({
            skyTop: mix("#05070f", "#2f6fc4"),
            skyHorizon: mix("#1a1f3a", "#bfd9ee"),
            ambientIntensity: 0.15 + 0.85 * height,
        });
        // Not object.visible: a hidden object is an inactive one, and this behavior would stop with it
        if (self.state.light) self.state.light.intensity = self.state.noon * height;
    },
});
