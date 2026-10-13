import * as THREE from "three";
import { defineBehavior } from "white-engine";

// A character seen through its own eyes: the mouse looks around, W A S D walk where it looks, Space jumps.
// The object needs a solid Collider; its camera is a child object, named in `head`, that nods up and down
// while the object itself turns left and right.
export const firstPerson = defineBehavior({
    name: "firstPerson",
    label: "First Person",
    params: {
        head: { type: "asset", kind: "object", default: "" },
        // Meters per second; Shift runs
        speed: { type: "number", default: 5, min: 0, step: 0.5 },
        run: { type: "number", default: 9, min: 0, step: 0.5 },
        jump: { type: "number", default: 7, min: 0, step: 0.5 },
        // How high a ledge it walks onto without jumping, meters; a slope is walked up the same way
        step: { type: "number", default: 0.4, min: 0, step: 0.05 },
        // Degrees per pixel the mouse moves
        sensitivity: { type: "number", default: 0.15, min: 0.01, step: 0.01 },
    },
    start: (self) => {
        self.input.lockPointer();
        return { pitch: 0 };
    },
    update: (self, dt) => {
        const { input, params, state, object } = self;
        // The arrows turn as well: for a keyboard without a mouse, and for a run of `render --input`
        const turn = (input.pointerLocked ? -input.mouseDX * params.sensitivity : 0) - input.axis("ArrowLeft", "ArrowRight") * 90 * dt;
        const nod = (input.pointerLocked ? -input.mouseDY * params.sensitivity : 0) + input.axis("ArrowDown", "ArrowUp") * 60 * dt;
        object.rotation.y += THREE.MathUtils.degToRad(turn);
        state.pitch = THREE.MathUtils.clamp(state.pitch + nod, -85, 85);
        if (params.head) params.head.rotation.x = THREE.MathUtils.degToRad(state.pitch);

        const stick = input.stick("left");
        const side = input.axis("KeyA", "KeyD") + stick.x;
        const ahead = input.axis("KeyS", "KeyW") + stick.y;
        const length = Math.hypot(side, ahead);
        if (length > 0) {
            const pace = ((input.key("ShiftLeft") ? params.run : params.speed) * dt) / Math.max(1, length);
            // Ahead is where the object looks: its own -Z, turned by its angle around the vertical
            const sin = Math.sin(object.rotation.y);
            const cos = Math.cos(object.rotation.y);
            self.move((side * cos - ahead * sin) * pace, 0, (-side * sin - ahead * cos) * pace, params.step);
        }
        if (params.jump > 0 && (input.keyPressed("Space") || input.keyPressed("Pad0")) && self.grounded()) self.jump(params.jump);
        self.fall(dt);
    },
    destroy: (self) => self.input.unlockPointer(),
});
