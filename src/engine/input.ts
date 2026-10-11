// Keyboard, mouse, touch and gamepad state for behaviors: self.input.key("KeyW"), self.input.keyPressed("Space"), ...
// Keys are named by KeyboardEvent.code ("KeyW", "Space", "ArrowLeft", "ShiftLeft"): the place of the key
// on the keyboard, the same in any layout. Mouse buttons: 0 left, 1 middle, 2 right.
// The buttons of the first gamepad are keys too: "Pad0" ... "Pad16" (see PAD_BUTTONS below).

const mouseCode = (button: number) => `Mouse${button}`;

// Typing in a text field is not playing
function isTyping(target: EventTarget | null) {
    const tag = (target as HTMLElement | null)?.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

// Keys the browser would scroll the page with
const SCROLL_KEYS = ["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

// The buttons of a gamepad of the usual layout, by their number in "Pad<number>"
export const PAD_BUTTONS = [
    "A / cross", "B / circle", "X / square", "Y / triangle", "left bumper", "right bumper", "left trigger", "right trigger",
    "back / share", "start / options", "left stick press", "right stick press", "up", "down", "left", "right", "home",
];

// A stick pushed less than this far counts as standing still: worn sticks never rest at exactly 0
const DEAD_ZONE = 0.15;

// The mouse, or a finger on the screen
export interface Pointer {
    // 0 is the mouse and the first finger; further fingers have numbers of their own
    id: number;
    // Where it is over the view: -1..1 from left to right and from bottom to top
    x: number;
    y: number;
    // Pressed: the left mouse button, or the finger is on the screen
    down: boolean;
    // It went down, or up, since the previous frame
    pressed: boolean;
    released: boolean;
    // A finger, not the mouse
    touch: boolean;
}

export class Input {
    // Position of the mouse over the view: -1..1 from left to right and from bottom to top, (0, 0) is the center.
    // The first finger on a touch screen moves it too.
    mouseX = 0;

    mouseY = 0;

    // The part of the attached element the picture of the game takes, in its pixels from its corner; null
    // if it takes all of it. The editor sets it when the picture has a shape of its own (black bars around).
    area: { left: number; top: number; width: number; height: number } | null = null;

    // How far the mouse moved since the previous frame, in pixels; y grows downwards. With the pointer
    // locked (lockPointer) this is all the mouse gives.
    mouseDX = 0;

    mouseDY = 0;

    // Keys and mouse buttons that are held now
    private down = new Set<string>();

    // ... that went down, or up, since the previous frame
    private pressed = new Set<string>();

    private released = new Set<string>();

    // The mouse (0) and the fingers on the screen
    private pointerStates = new Map<number, Pointer>();

    // The sticks of the first gamepad as of the last poll(): left x, left y, right x, right y
    private padAxes = [0, 0, 0, 0];

    private padThere = false;

    // The state of the gamepad came from a real one at the last poll(), not from setPad() called by hand
    private padPolled = false;

    // The element the mouse is listened on, while attached
    private element: HTMLElement | null = null;

    // lockPointer() was asked for and has not been taken back
    private wantsLock = false;

    // true while the key is held
    key(code: string) {
        return this.down.has(code);
    }

    // true only in the frame the key went down
    keyPressed(code: string) {
        return this.pressed.has(code);
    }

    // true only in the frame the key went up
    keyReleased(code: string) {
        return this.released.has(code);
    }

    // -1, 0 or 1 out of two keys: axis("KeyA", "KeyD") is 1 while D is held and -1 while A is
    axis(negative: string, positive: string) {
        return Number(this.down.has(positive)) - Number(this.down.has(negative));
    }

    mouseButton(button = 0) {
        return this.down.has(mouseCode(button));
    }

    mousePressed(button = 0) {
        return this.pressed.has(mouseCode(button));
    }

    mouseReleased(button = 0) {
        return this.released.has(mouseCode(button));
    }

    // The mouse and every finger on the screen, for what has to tell them apart (buttons of the interface
    // held by two thumbs)
    get pointers(): Pointer[] {
        return [...this.pointerStates.values()];
    }

    // The fingers that are on the screen now
    get touches(): Pointer[] {
        return this.pointers.filter((pointer) => pointer.touch && pointer.down);
    }

    // true if a gamepad is connected (and one of its buttons was pressed: browsers hide it until then)
    get padConnected() {
        return this.padThere;
    }

    // A stick of the first gamepad: x from -1 (left) to 1 (right), y from -1 (down) to 1 (up); 0, 0 at rest
    // and without a gamepad
    stick(side: "left" | "right" = "left") {
        const at = side === "left" ? 0 : 2;
        return { x: this.padAxes[at], y: this.padAxes[at + 1] };
    }

    // Hides the mouse pointer and keeps it inside the view: the mouse then only tells how far it moved
    // (mouseDX, mouseDY), endlessly, which is what looking around with it needs. The browser takes the
    // pointer only on a click, so it is locked at the next press on the view if it cannot be right away; Esc
    // lets it go.
    lockPointer() {
        this.wantsLock = true;
        this.requestLock();
    }

    unlockPointer() {
        this.wantsLock = false;
        if (this.pointerLocked) document.exitPointerLock();
    }

    get pointerLocked() {
        return typeof document !== "undefined" && this.element !== null && document.pointerLockElement === this.element;
    }

    private requestLock() {
        if (!this.element || this.pointerLocked) return;
        try {
            // Refused without a recent click or key: the next press on the view asks again
            Promise.resolve(this.element.requestPointerLock()).catch(() => {});
        } catch {
            // Not available here
        }
    }

    // The methods below feed the state; attach() calls them from browser events.

    setKey(code: string, isDown: boolean) {
        if (isDown === this.down.has(code)) return;
        if (isDown) {
            this.down.add(code);
            this.pressed.add(code);
        } else {
            this.down.delete(code);
            this.released.add(code);
        }
    }

    // A pointer by its number, made if it is new
    private pointer(id: number) {
        let state = this.pointerStates.get(id);
        if (!state) {
            state = { id, x: 0, y: 0, down: false, pressed: false, released: false, touch: false };
            this.pointerStates.set(id, state);
        }
        return state;
    }

    // A pointer moved, went down or up. `id` 0 is the mouse (and the first finger); it also is what
    // mouseX, mouseY and the left mouse button tell.
    setPointer(id: number, x: number, y: number, isDown: boolean, touch = false) {
        const state = this.pointer(id);
        state.x = x;
        state.y = y;
        state.touch = touch;
        if (isDown !== state.down) {
            state.down = isDown;
            if (isDown) state.pressed = true;
            else state.released = true;
        }
        if (id === 0) {
            this.mouseX = x;
            this.mouseY = y;
            this.setKey(mouseCode(0), isDown);
        }
    }

    setMouseButton(button: number, isDown: boolean) {
        if (button === 0) this.setPointer(0, this.mouseX, this.mouseY, isDown);
        else this.setKey(mouseCode(button), isDown);
    }

    setMouse(x: number, y: number, dx = 0, dy = 0) {
        this.setPointer(0, x, y, this.pointer(0).down);
        this.mouseDX += dx;
        this.mouseDY += dy;
    }

    // The state of the first gamepad: its buttons (true = held), then the two sticks as the browser gives
    // them (left x, left y, right x, right y; y grows downwards). poll() calls it; null: no gamepad.
    setPad(buttons: boolean[] | null, axes: number[] = []) {
        this.padThere = buttons !== null;
        for (let i = 0; i < PAD_BUTTONS.length; i++) this.setKey(`Pad${i}`, buttons?.[i] ?? false);
        const rest = (value: number | undefined) => (value !== undefined && Math.abs(value) > DEAD_ZONE ? value : 0);
        // Up is up
        this.padAxes = [rest(axes[0]), -rest(axes[1]) || 0, rest(axes[2]), -rest(axes[3]) || 0];
    }

    // Called once per frame before the behaviors run (Game.update does it): a gamepad sends no events, it
    // has to be asked
    poll() {
        if (typeof navigator === "undefined" || !navigator.getGamepads) return;
        const pad = [...navigator.getGamepads()].find((gamepad) => gamepad?.connected) ?? null;
        // No real gamepad now or a frame ago: the state may have been set by hand (setPad), it is left alone
        if (!pad && !this.padPolled) return;
        this.setPad(pad ? pad.buttons.map((button) => button.pressed) : null, pad ? [...pad.axes] : []);
        this.padPolled = pad !== null;
    }

    // Lets go of everything, e.g. when the window loses focus and the key-up events will not come
    releaseAll() {
        for (const code of [...this.down]) this.setKey(code, false);
        for (const state of this.pointerStates.values()) {
            if (state.down) {
                state.down = false;
                state.released = true;
            }
        }
    }

    // Called once per frame after the behaviors ran (Game.update does it): "pressed" lasts one frame
    endFrame() {
        this.pressed.clear();
        this.released.clear();
        this.mouseDX = 0;
        this.mouseDY = 0;
        for (const [id, state] of this.pointerStates) {
            state.pressed = false;
            state.released = false;
            // A finger that has left the screen is gone; the mouse is always somewhere
            if (id !== 0 && !state.down) this.pointerStates.delete(id);
        }
    }

    // Listens to the keyboard of the window and to the mouse and the fingers over `element` (the canvas).
    // Returns a function that stops listening.
    attach(element: HTMLElement) {
        this.element = element;
        // The numbers the browser gives the fingers, by the numbers of the pointers here; the first finger is 0
        const fingers = new Map<number, number>();
        let nextFinger = 1;

        const onKey = (e: KeyboardEvent) => {
            if (isTyping(e.target)) return;
            if (SCROLL_KEYS.includes(e.code)) e.preventDefault();
            this.setKey(e.code, e.type === "keydown");
        };
        const onPointer = (e: PointerEvent) => {
            const whole = element.getBoundingClientRect();
            const rect = this.area
                ? { left: whole.left + this.area.left, top: whole.top + this.area.top, width: this.area.width, height: this.area.height }
                : whole;
            const inside = rect.width > 0 && rect.height > 0;
            const x = inside ? ((e.clientX - rect.left) / rect.width) * 2 - 1 : 0;
            const y = inside ? -((e.clientY - rect.top) / rect.height) * 2 + 1 : 0;
            const ended = e.type === "pointerup" || e.type === "pointercancel";

            if (e.pointerType === "mouse") {
                if (inside && !this.pointerLocked) this.setMouse(x, y);
                if (e.type === "pointermove") {
                    this.mouseDX += e.movementX;
                    this.mouseDY += e.movementY;
                }
                if (e.type === "pointerdown") {
                    this.setMouseButton(e.button, true);
                    if (this.wantsLock) this.requestLock();
                }
                if (ended) this.setMouseButton(e.button, false);
                return;
            }

            // A finger (or a pen). The first one is the mouse as well, so what was written for a mouse works
            // on a phone; the others are only in `pointers`.
            if (e.type === "pointerdown") fingers.set(e.pointerId, e.isPrimary || !fingers.size ? 0 : nextFinger++);
            const id = fingers.get(e.pointerId);
            if (id === undefined) return;
            const state = this.pointer(id);
            if (id === 0 && e.type === "pointermove" && state.down) {
                this.mouseDX += e.movementX;
                this.mouseDY += e.movementY;
            }
            this.setPointer(id, inside ? x : state.x, inside ? y : state.y, !ended, true);
            if (ended) fingers.delete(e.pointerId);
        };
        const onBlur = () => this.releaseAll();

        // A finger on the game must not scroll or zoom the page
        const touchAction = element.style.touchAction;
        element.style.touchAction = "none";

        window.addEventListener("keydown", onKey);
        window.addEventListener("keyup", onKey);
        window.addEventListener("blur", onBlur);
        element.addEventListener("pointerdown", onPointer);
        element.addEventListener("pointermove", onPointer);
        // On the window: the button may be released outside of the view
        window.addEventListener("pointerup", onPointer);
        window.addEventListener("pointercancel", onPointer);

        return () => {
            window.removeEventListener("keydown", onKey);
            window.removeEventListener("keyup", onKey);
            window.removeEventListener("blur", onBlur);
            element.removeEventListener("pointerdown", onPointer);
            element.removeEventListener("pointermove", onPointer);
            window.removeEventListener("pointerup", onPointer);
            window.removeEventListener("pointercancel", onPointer);
            element.style.touchAction = touchAction;
            if (this.pointerLocked) document.exitPointerLock();
            this.element = null;
            this.releaseAll();
        };
    }
}
