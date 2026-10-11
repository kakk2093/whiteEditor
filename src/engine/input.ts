// Keyboard and mouse state for behaviors: self.input.key("KeyW"), self.input.keyPressed("Space"), ...
// Keys are named by KeyboardEvent.code ("KeyW", "Space", "ArrowLeft", "ShiftLeft"): the place of the key
// on the keyboard, the same in any layout. Mouse buttons: 0 left, 1 middle, 2 right.

const mouseCode = (button: number) => `Mouse${button}`;

// Typing in a text field is not playing
function isTyping(target: EventTarget | null) {
    const tag = (target as HTMLElement | null)?.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

// Keys the browser would scroll the page with
const SCROLL_KEYS = ["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

export class Input {
    // Position of the mouse over the view: -1..1 from left to right and from bottom to top, (0, 0) is the center
    mouseX = 0;

    mouseY = 0;

    // The part of the attached element the picture of the game takes, in its pixels from its corner; null
    // if it takes all of it. The editor sets it when the picture has a shape of its own (black bars around).
    area: { left: number; top: number; width: number; height: number } | null = null;

    // How far the mouse moved since the previous frame, in pixels; y grows downwards
    mouseDX = 0;

    mouseDY = 0;

    // Keys and mouse buttons that are held now
    private down = new Set<string>();

    // ... that went down, or up, since the previous frame
    private pressed = new Set<string>();

    private released = new Set<string>();

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

    setMouseButton(button: number, isDown: boolean) {
        this.setKey(mouseCode(button), isDown);
    }

    setMouse(x: number, y: number, dx = 0, dy = 0) {
        this.mouseX = x;
        this.mouseY = y;
        this.mouseDX += dx;
        this.mouseDY += dy;
    }

    // Lets go of everything, e.g. when the window loses focus and the key-up events will not come
    releaseAll() {
        for (const code of [...this.down]) this.setKey(code, false);
    }

    // Called once per frame after the behaviors ran (Game.update does it): "pressed" lasts one frame
    endFrame() {
        this.pressed.clear();
        this.released.clear();
        this.mouseDX = 0;
        this.mouseDY = 0;
    }

    // Listens to the keyboard of the window and to the mouse over `element` (the canvas).
    // Returns a function that stops listening.
    attach(element: HTMLElement) {
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
            if (rect.width > 0 && rect.height > 0) {
                this.setMouse(
                    ((e.clientX - rect.left) / rect.width) * 2 - 1,
                    -((e.clientY - rect.top) / rect.height) * 2 + 1,
                    e.type === "pointermove" ? e.movementX : 0,
                    e.type === "pointermove" ? e.movementY : 0
                );
            }
            if (e.type === "pointerdown") this.setMouseButton(e.button, true);
            if (e.type === "pointerup") this.setMouseButton(e.button, false);
        };
        const onBlur = () => this.releaseAll();

        window.addEventListener("keydown", onKey);
        window.addEventListener("keyup", onKey);
        window.addEventListener("blur", onBlur);
        element.addEventListener("pointerdown", onPointer);
        element.addEventListener("pointermove", onPointer);
        // On the window: the button may be released outside of the view
        window.addEventListener("pointerup", onPointer);

        return () => {
            window.removeEventListener("keydown", onKey);
            window.removeEventListener("keyup", onKey);
            window.removeEventListener("blur", onBlur);
            element.removeEventListener("pointerdown", onPointer);
            element.removeEventListener("pointermove", onPointer);
            window.removeEventListener("pointerup", onPointer);
            this.releaseAll();
        };
    }
}
