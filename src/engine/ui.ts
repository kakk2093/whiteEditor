import * as THREE from "three";
import type { Input } from "./input";
import type { Registry } from "./Registry";

// The interface of the game: what is drawn over the picture, flat, in the units of the screen. It lives
// inside a canvas (an entity with a Canvas component), which stands for the screen. An element is an entity
// under it with a UI Element component (its place) and any of Text, Image and Button on it. All of it is
// painted onto one 2D canvas of the browser, which the pipeline lays over the picture as a texture; it is
// painted again only when something has changed.

// The font files assets/ can hold
export const FONT_FILE = /\.(ttf|otf|woff2?)$/i;

// Where on its parent (the screen, or the element it is a child of) an element is pinned. The same point of
// the element itself goes there: "top-right" puts its top right corner at the top right corner of the parent.
export const UI_ANCHORS = ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"];

// The fields of the four components, defaults filled in (see components.ts)
export interface UiRect {
    anchor: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface UiText {
    text: string;
    font: string;
    size: number;
    color: string;
    opacity: number;
    align: string;
    vertical: string;
    wrap: boolean;
    outline: number;
    outlineColor: string;
    sharp: boolean;
}

export interface UiImage {
    texture: string;
    color: string;
    opacity: number;
    smooth: boolean;
}

export interface UiButton {
    enabled: boolean;
    // Set every frame by the game: true while the button is held down, by the mouse or by a finger. What
    // on-screen controls read: self.ui(button)!.button!.held
    held?: boolean;
}

// Puts the child elements one after another, in a column or a row; their anchors, x and y do not count
export interface UiLayout {
    direction: string;
    gap: number;
    padding: number;
    align: string;
}

// A value between min and max, set by dragging: the behaviors of the entity get change(self, value)
export interface UiSlider {
    value: number;
    min: number;
    max: number;
    step: number;
    enabled: boolean;
    fill: string;
    knob: string;
}

// A line of text the player types; shown by the Text of the same element
export interface UiInput {
    text: string;
    placeholder: string;
    max: number;
    enabled: boolean;
    // Set every frame by the game: true while the keyboard goes here
    focused?: boolean;
}

// Shows only what of its child elements is inside it; `offset` units of them have gone up over its top
export interface UiScroll {
    offset: number;
    enabled: boolean;
}

// The interface components of one entity, as a behavior gets them from self.ui(): the very objects the
// element is drawn from, so a changed field shows in the next frame
export interface UiElement {
    rect: UiRect;
    text?: UiText;
    image?: UiImage;
    button?: UiButton;
    layout?: UiLayout;
    slider?: UiSlider;
    input?: UiInput;
    scroll?: UiScroll;
}

// What happened to an element in a frame; the behaviors of its entity get the hook of the same name
export interface UiEvent {
    object: THREE.Object3D;
    hook: "click" | "change" | "submit";
    value?: number | string;
}

interface Box {
    left: number;
    top: number;
    width: number;
    height: number;
}

// An element with its place on the screen, in the units of the interface from the top left corner
interface Placed extends UiElement {
    object: THREE.Object3D;
    left: number;
    top: number;
    width: number;
    height: number;
    // How many units high the screen is for it: the height of its canvas
    units: number;
    // Shown only inside this box (the Scroll it is in); null: all of it
    clip: Box | null;
}

// The interface components of an entity object; null if it is not an element
export function uiOf(object: THREE.Object3D): UiElement | null {
    let found: UiElement | null = null;
    const rest: Partial<UiElement> = {};
    for (const child of object.children) {
        const data = child.userData;
        if (data.ui) found = { rect: data.ui };
        if (data.uiText) rest.text = data.uiText;
        if (data.uiImage) rest.image = data.uiImage;
        if (data.uiButton) rest.button = data.uiButton;
        if (data.uiLayout) rest.layout = data.uiLayout;
        if (data.uiSlider) rest.slider = data.uiSlider;
        if (data.uiInput) rest.input = data.uiInput;
        if (data.uiScroll) rest.scroll = data.uiScroll;
    }
    return found ? Object.assign(found, rest) : null;
}

// Fonts by address: a file is loaded once for the page, under a family name of its own
const fonts = new Map<string, { family: string; ready: boolean; done: Promise<void> }>();

// The font of a file: its CSS family, whether it is loaded yet, and a promise of that. null outside of a browser.
export function loadFont(url: string) {
    if (typeof FontFace === "undefined" || typeof document === "undefined") return null;
    let font = fonts.get(url);
    if (!font) {
        const entry = { family: `white-font-${fonts.size + 1}`, ready: false, done: Promise.resolve() };
        entry.done = new FontFace(entry.family, `url("${url}")`).load().then(
            (face) => {
                // The types of the DOM library in use do not know add()
                (document.fonts as unknown as { add: (face: FontFace) => void }).add(face);
                entry.ready = true;
            },
            () => console.warn(`Font "${url}" could not be loaded`)
        );
        fonts.set(url, entry);
        font = entry;
    }
    return font;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

// The size of an element along one side: its own, or, from 0 down, that of its parent with so much taken off
const sizeIn = (own: number, parent: number) => (own > 0 ? own : Math.max(0, parent + own));

// The part of both boxes; null stands for "everywhere"
function overlap(a: Box | null, b: Box): Box {
    if (!a) return b;
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    return { left, top, width: Math.max(0, Math.min(a.left + a.width, b.left + b.width) - left), height: Math.max(0, Math.min(a.top + a.height, b.top + b.height) - top) };
}

// How far the value of a slider is from its min to its max, 0..1
export const sliderPart = (slider: UiSlider) => (slider.max > slider.min ? clamp((slider.value - slider.min) / (slider.max - slider.min), 0, 1) : 0);

// How far a finger has to go for a press inside a Scroll to become scrolling, units
const SCROLL_START = 6;

const fraction = (anchor: string, low: string, high: string) => (anchor.includes(low) ? 0 : anchor.includes(high) ? 1 : 0.5);

// Where an anchor is on its parent, as parts of its width and height: "top-right" is [1, 0]
export const anchorPoint = (anchor: string): [number, number] => [fraction(anchor, "left", "right"), fraction(anchor, "top", "bottom")];

// The size handles of an element, in the units of the interface: how big one is drawn, and where the eight
// of them are: at the corners and in the middle of the sides. `h` and `v` tell which side a handle moves:
// -1 the left (top) one, 1 the right (bottom) one, 0 neither.
export const UI_HANDLE = 8;
export const UI_HANDLES = [-1, 0, 1].flatMap((v) => [-1, 0, 1].filter((h) => h !== 0 || v !== 0).map((h) => ({ h, v })));

// Breaks the text into lines: at its own line breaks and, with `width`, where the next word would not fit
function breakLines(ctx: CanvasRenderingContext2D, text: string, width: number) {
    const lines: string[] = [];
    for (const paragraph of text.split("\n")) {
        if (width <= 0) {
            lines.push(paragraph);
            continue;
        }
        let line = "";
        for (const word of paragraph.split(" ")) {
            const longer = line ? `${line} ${word}` : word;
            if (line && ctx.measureText(longer).width > width) {
                lines.push(line);
                line = word;
            } else {
                line = longer;
            }
        }
        lines.push(line);
    }
    return lines;
}

export class UiLayer {
    registry: Registry;

    // The entity objects the elements are looked for in
    root: THREE.Object3D;

    // Elements to draw a frame around: the editor marks the selected ones
    highlight = new Set<THREE.Object3D>();

    // The element to draw the size handles on: the editor's main selected one
    handles: THREE.Object3D | null = null;

    // The elements in the order they are drawn (the order of the Hierarchy), as of the last layout
    private elements: Placed[] = [];

    // Width / height of the screen, as of the last layout
    private aspect = 1;

    private canvas: HTMLCanvasElement | null = null;

    private texture: THREE.CanvasTexture | null = null;

    // What the canvas shows now; the same thing is not painted twice
    private painted = "";

    // Two more canvases to paint a part on before it goes to the main one
    private spare: HTMLCanvasElement[] = [];

    // The buttons the mouse is over, and the ones that are held down: by the mouse or by fingers, each of
    // which may hold a button of its own
    private hovered = new Set<THREE.Object3D>();

    private held = new Set<THREE.Object3D>();

    // The button, slider or input field each pointer went down on (null: it went down elsewhere), by the
    // number of the pointer
    private grabs = new Map<number, THREE.Object3D | null>();

    // The Scroll each pointer went down in: where (units from the top) and at what offset
    private pulls = new Map<number, { object: THREE.Object3D; y: number; offset: number; moving: boolean }>();

    // The input field the keyboard goes to
    private focused: THREE.Object3D | null = null;

    // How high the content of every Scroll is, as of the last layout
    private extents = new Map<THREE.Object3D, number>();

    constructor(registry: Registry, root: THREE.Object3D) {
        this.registry = registry;
        this.root = root;
    }

    // Number of elements, as of the last layout
    get count() {
        return this.elements.length;
    }

    // Where the element of this entity object is on the screen, in the units of its canvas (the screen is
    // `units` of them high); null if it is not shown
    placeOf(object: THREE.Object3D) {
        const found = this.elements.find((element) => element.object === object);
        return found ? { left: found.left, top: found.top, width: found.width, height: found.height, units: found.units } : null;
    }

    // true while the player types into an input field: the keys are letters then, not controls
    get typing() {
        return this.focused !== null;
    }

    // Finds the elements and their places for a screen of this shape (width / height). For the elements of a
    // canvas the screen is always as many units high as the canvas says, so an interface looks the same in
    // a window of any size.
    layout(aspect: number) {
        this.aspect = aspect;
        this.elements = [];
        const extents = new Map<THREE.Object3D, number>();
        // `parent` is null outside of a canvas: nothing there is an element. `slot` is the place a Layout
        // gives the element instead of the one its anchor would.
        const visit = (object: THREE.Object3D, parent: Box | null, units: number, slot: Box | null, clip: Box | null) => {
            if (!object.visible) return;
            // A canvas is the screen, wherever it stands
            const canvas = object.children.find((child) => child.userData.uiCanvas);
            if (canvas) {
                units = Math.max(1, (canvas.userData.uiCanvas as { height: number }).height);
                parent = { left: 0, top: 0, width: units * aspect, height: units };
                slot = null;
                clip = null;
            }
            const element = parent && uiOf(object);
            let box = parent;
            if (element && parent) {
                const { rect } = element;
                const width = sizeIn(rect.width, parent.width);
                const height = sizeIn(rect.height, parent.height);
                const ax = fraction(rect.anchor, "left", "right");
                const ay = fraction(rect.anchor, "top", "bottom");
                box = slot ?? {
                    left: parent.left + ax * (parent.width - width) + rect.x,
                    top: parent.top + ay * (parent.height - height) + rect.y,
                    width,
                    height,
                };
                this.elements.push({ ...element, object, ...box, units, clip });
            }
            // The objects of the components are not entities
            const children = object.children.filter((child) => child.userData.component === undefined);
            if (!element || !box || (!element.scroll && !element.layout)) {
                for (const child of children) visit(child, box, units, null, clip);
                return;
            }

            const first = this.elements.length;
            let inner = box;
            if (element.scroll) {
                const { scroll } = element;
                // Not further than the content goes, as far as the last layout knows it
                scroll.offset = clamp(scroll.offset, 0, Math.max(0, (this.extents.get(object) ?? Infinity) - box.height));
                inner = { ...box, top: box.top - scroll.offset };
                clip = overlap(clip, box);
            }
            if (element.layout) {
                const { direction, gap, padding, align } = element.layout;
                const row = direction === "row";
                inner = { left: inner.left + padding, top: inner.top + padding, width: Math.max(0, inner.width - padding * 2), height: Math.max(0, inner.height - padding * 2) };
                let at = row ? inner.left : inner.top;
                for (const child of children) {
                    const rect = child.visible ? uiOf(child)?.rect : null;
                    if (!rect) {
                        visit(child, inner, units, null, clip);
                        continue;
                    }
                    // Across the line: at its start, middle or end, or from side to side
                    const room = row ? inner.height : inner.width;
                    const across = align === "stretch" ? room : sizeIn(row ? rect.height : rect.width, room);
                    const along = sizeIn(row ? rect.width : rect.height, row ? inner.width : inner.height);
                    const side = (row ? inner.top : inner.left) + (align === "center" ? (room - across) / 2 : align === "end" ? room - across : 0);
                    visit(child, inner, units, row ? { left: at, top: side, width: along, height: across } : { left: side, top: at, width: across, height: along }, clip);
                    at += along + gap;
                }
            } else {
                for (const child of children) visit(child, inner, units, null, clip);
            }
            if (element.scroll) {
                let bottom = inner.top;
                for (let i = first; i < this.elements.length; i++) bottom = Math.max(bottom, this.elements[i].top + this.elements[i].height);
                extents.set(object, bottom - (box.top - element.scroll.offset) + (element.layout?.padding ?? 0));
            }
        };
        visit(this.root, null, 1, null, null);
        this.extents = extents;
    }

    // A point of the screen (x, y from -1 to 1) in the units of the canvas of an element, from its top left corner
    private pointIn(e: Placed, x: number, y: number) {
        return { x: ((x + 1) / 2) * e.units * this.aspect, y: ((1 - y) / 2) * e.units };
    }

    // The element under a point of the screen (x, y from -1 to 1, as Input gives the mouse) that `wanted`
    // takes; the one drawn last is on top
    private pick(x: number, y: number, wanted: (element: UiElement) => unknown) {
        for (let i = this.elements.length - 1; i >= 0; i--) {
            const e = this.elements[i];
            if (!wanted(e)) continue;
            const { x: px, y: py } = this.pointIn(e, x, y);
            const shown = overlap(e.clip, e);
            if (px >= shown.left && px <= shown.left + shown.width && py >= shown.top && py <= shown.top + shown.height) return e.object;
        }
        return null;
    }

    // The entity object of the element under a point of the screen, as of the last layout: one that shows
    // something, so an empty container over the whole screen is not in the way. The editor picks with it.
    elementAt(x: number, y: number) {
        return this.pick(x, y, (element) => element.text || element.image || element.button || element.slider || element.input);
    }

    // Once a frame, before the behaviors: follows the mouse, the fingers and the keyboard over the buttons,
    // sliders, input fields and scrolls. Returns what happened: a button clicked (pressed and released on the
    // same one), a slider or an input field changed, Enter pressed in an input field.
    update(aspect: number, input: Input): UiEvent[] {
        this.layout(aspect);
        this.hovered.clear();
        this.held.clear();
        const events: UiEvent[] = [];
        const placed = (object: THREE.Object3D | null | undefined) => (object ? this.elements.find((element) => element.object === object) : undefined);
        const active = (element: UiElement) => element.button?.enabled || element.slider?.enabled || element.input?.enabled;
        const scrolls = (element: UiElement) => element.scroll?.enabled;

        for (const pointer of input.pointers) {
            const over = this.pick(pointer.x, pointer.y, active);
            if (pointer.pressed) {
                this.grabs.set(pointer.id, over);
                this.focused = placed(over)?.input ? over : null;
                const area = placed(this.pick(pointer.x, pointer.y, scrolls));
                // A slider is dragged itself, not the list it is in
                if (area && !placed(over)?.slider) {
                    this.pulls.set(pointer.id, { object: area.object, y: this.pointIn(area, pointer.x, pointer.y).y, offset: area.scroll!.offset, moving: false });
                }
            }
            const pull = this.pulls.get(pointer.id);
            const pulled = placed(pull?.object);
            if (pull && pulled?.scroll && pointer.down) {
                const moved = this.pointIn(pulled, pointer.x, pointer.y).y - pull.y;
                if (Math.abs(moved) > SCROLL_START) {
                    pull.moving = true;
                    // The press was the start of scrolling, not a click on what is under it
                    this.grabs.set(pointer.id, null);
                }
                if (pull.moving) pulled.scroll.offset = pull.offset - moved;
            }

            const grabbed = this.grabs.get(pointer.id) ?? null;
            const target = placed(grabbed);
            if (pointer.down && target?.slider?.enabled && target.width > 0) {
                const { slider } = target;
                const part = clamp((this.pointIn(target, pointer.x, pointer.y).x - target.left) / target.width, 0, 1);
                let value = slider.min + part * (slider.max - slider.min);
                if (slider.step > 0) value = clamp(slider.min + Math.round((value - slider.min) / slider.step) * slider.step, slider.min, slider.max);
                // Steps of 0.1 would otherwise give 0.30000000000000004
                value = Number(value.toFixed(6));
                if (value !== slider.value) {
                    slider.value = value;
                    events.push({ object: target.object, hook: "change", value });
                }
            }
            if (pointer.down && grabbed && grabbed === over && target?.button) this.held.add(grabbed);
            // A finger that is not on the screen is nowhere
            if (!pointer.down && !pointer.touch && over && placed(over)?.button) this.hovered.add(over);
            if (pointer.released) {
                if (grabbed && grabbed === over && target?.button?.enabled) events.push({ object: grabbed, hook: "click" });
                this.grabs.delete(pointer.id);
                this.pulls.delete(pointer.id);
            }
        }

        if (input.wheel !== 0) {
            const area = placed(this.pick(input.mouseX, input.mouseY, scrolls));
            if (area?.scroll) area.scroll.offset += input.wheel * 0.5;
        }

        const field = placed(this.focused)?.input;
        if (!this.focused || !field?.enabled) this.focused = null;
        else {
            const object = this.focused;
            const before = field.text;
            for (const char of input.typed) {
                if (char === "\n") events.push({ object, hook: "submit", value: field.text });
                else if (char === "\b") field.text = field.text.slice(0, -1);
                else if (field.max <= 0 || field.text.length < field.max) field.text += char;
            }
            // Before a submit of the same frame: the behaviors hear of the last letter first
            if (field.text !== before) events.unshift({ object, hook: "change", value: field.text });
        }

        for (const element of this.elements) {
            if (element.button) element.button.held = this.held.has(element.object);
            if (element.input) element.input.focused = element.object === this.focused;
        }
        return events;
    }

    // true while the mouse is over a button or one is held: a press there is not a press on the world
    get overButton() {
        return this.hovered.size > 0 || this.held.size > 0;
    }

    // How a button is drawn: 2 held down, 1 under the mouse, 0 as it is
    private stateOf(element: Placed) {
        if (!element.button?.enabled) return 0;
        return this.held.has(element.object) ? 2 : this.hovered.has(element.object) ? 1 : 0;
    }

    private spareCanvas(index: number, width: number, height: number) {
        const canvas = this.spare[index] ?? (this.spare[index] = document.createElement("canvas"));
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        const ctx = canvas.getContext("2d", { willReadFrequently: index === 1 })!;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.clearRect(0, 0, width, height);
        return ctx;
    }

    // The CSS font of a text; the family of its file once that is loaded, a plain one until then
    private fontOf(text: UiText) {
        return (text.font && this.registry.fontFamily(text.font)) || "sans-serif";
    }

    // Everything the picture of the interface depends on, as one string
    private signature(width: number, height: number) {
        return JSON.stringify([
            width,
            height,
            this.elements.map((e) => [
                e.left, e.top, e.width, e.height, e.units, e.text, e.image, e.slider, e.input, e.clip,
                e.text ? this.fontOf(e.text) : 0,
                e.image?.texture ? this.registry.getImage(e.image.texture) !== null : 0,
                this.stateOf(e),
                this.highlight.has(e.object),
                this.handles === e.object,
            ]),
        ]);
    }

    private paintImage(ctx: CanvasRenderingContext2D, image: UiImage, x: number, y: number, width: number, height: number) {
        if (width <= 0 || height <= 0) return;
        ctx.globalAlpha = image.opacity;
        if (!image.texture) {
            ctx.fillStyle = image.color;
            ctx.fillRect(x, y, width, height);
        } else {
            const picture = this.registry.getImage(image.texture);
            if (picture) {
                if (image.color.toLowerCase() === "#ffffff") {
                    ctx.imageSmoothingEnabled = image.smooth;
                    ctx.drawImage(picture, x, y, width, height);
                } else {
                    // Tinted: multiplied by the color where the picture is, and nowhere else
                    const tint = this.spareCanvas(1, width, height);
                    tint.imageSmoothingEnabled = image.smooth;
                    tint.drawImage(picture, 0, 0, width, height);
                    tint.globalCompositeOperation = "multiply";
                    tint.fillStyle = image.color;
                    tint.fillRect(0, 0, width, height);
                    tint.globalCompositeOperation = "destination-in";
                    tint.drawImage(picture, 0, 0, width, height);
                    ctx.drawImage(tint.canvas, x, y);
                }
            }
        }
        ctx.globalAlpha = 1;
    }

    // `scale`: pixels of the canvas per unit of the interface
    private paintText(ctx: CanvasRenderingContext2D, text: UiText, x: number, y: number, width: number, height: number, scale: number) {
        if (!text.text) return;
        const size = text.sharp ? Math.max(1, Math.round(text.size * scale)) : text.size * scale;
        const outline = text.outline * scale;
        // A sharp text is painted aside, where its soft edges can be cut off, and then put in its place
        const pad = text.sharp ? Math.ceil(size + outline) : 0;
        const target = text.sharp ? this.spareCanvas(1, width + pad * 2, height + pad * 2) : ctx;
        const left = text.sharp ? pad : x;
        const top = text.sharp ? pad : y;

        target.font = `${size}px ${this.fontOf(text)}`;
        target.textBaseline = "middle";
        target.textAlign = text.align as CanvasTextAlign;
        const lines = breakLines(target, text.text, text.wrap ? width : 0);
        const lineHeight = text.sharp ? Math.round(size * 1.25) : size * 1.25;
        const free = height - lines.length * lineHeight;
        const first = top + (text.vertical === "top" ? 0 : text.vertical === "bottom" ? free : free / 2);
        const at = left + (text.align === "left" ? 0 : text.align === "right" ? width : width / 2);

        target.globalAlpha = text.sharp ? 1 : text.opacity;
        lines.forEach((line, i) => {
            const lineY = first + lineHeight * (i + 0.5);
            const lineX = text.sharp ? Math.round(at) : at;
            if (outline > 0) {
                target.lineWidth = outline * 2;
                target.lineJoin = "round";
                target.strokeStyle = text.outlineColor;
                target.strokeText(line, lineX, text.sharp ? Math.round(lineY) : lineY);
            }
            target.fillStyle = text.color;
            target.fillText(line, lineX, text.sharp ? Math.round(lineY) : lineY);
        });
        target.globalAlpha = 1;

        if (text.sharp) {
            // Every pixel is either there or not: what a pixel font needs
            const pixels = target.getImageData(0, 0, width + pad * 2, height + pad * 2);
            for (let i = 3; i < pixels.data.length; i += 4) pixels.data[i] = pixels.data[i] >= 128 ? 255 : 0;
            target.putImageData(pixels, 0, 0);
            ctx.globalAlpha = text.opacity;
            ctx.drawImage(target.canvas, x - pad, y - pad);
            ctx.globalAlpha = 1;
        }
    }

    // The picture of the interface for a screen of width x height pixels, as a texture; null if there is
    // nothing to show. Painted anew only if something has changed since the last time.
    draw(width: number, height: number): THREE.Texture | null {
        if (typeof document === "undefined" || width <= 0 || height <= 0) return null;
        this.layout(width / height);
        if (this.elements.length === 0) return null;

        const signature = this.signature(width, height);
        if (signature === this.painted && this.texture) return this.texture;
        this.painted = signature;

        if (!this.canvas) this.canvas = document.createElement("canvas");
        const { canvas } = this;
        if (canvas.width !== width || canvas.height !== height || !this.texture) {
            canvas.width = width;
            canvas.height = height;
            // A texture keeps the size it was made with
            this.texture?.dispose();
            this.texture = new THREE.CanvasTexture(canvas);
            this.texture.colorSpace = THREE.NoColorSpace;
            this.texture.minFilter = THREE.NearestFilter;
            this.texture.magFilter = THREE.NearestFilter;
            this.texture.generateMipmaps = false;
        }
        const ctx = canvas.getContext("2d")!;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, width, height);

        for (const e of this.elements) {
            // Pixels of the picture per unit of the canvas of this element
            const scale = height / e.units;
            const x = Math.round(e.left * scale);
            const y = Math.round(e.top * scale);
            const w = Math.round(e.width * scale);
            const h = Math.round(e.height * scale);
            const state = this.stateOf(e);
            // A button under the mouse is painted aside, to be lightened (or darkened, while it is pressed)
            // only where it has something
            const target = state ? this.spareCanvas(0, width, height) : ctx;
            if (e.clip) {
                ctx.save();
                ctx.beginPath();
                ctx.rect(Math.round(e.clip.left * scale), Math.round(e.clip.top * scale), Math.round(e.clip.width * scale), Math.round(e.clip.height * scale));
                ctx.clip();
            }
            if (e.image) this.paintImage(target, e.image, x, y, w, h);
            if (e.slider) {
                // The part up to the value, and a knob at it
                const reach = Math.round(sliderPart(e.slider) * w);
                const knob = Math.min(w, Math.max(2, Math.round(h * 0.4)));
                target.fillStyle = e.slider.fill;
                target.fillRect(x, y, reach, h);
                target.fillStyle = e.slider.knob;
                target.fillRect(clamp(x + reach - Math.round(knob / 2), x, x + w - knob), y, knob, h);
            }
            // An input field shows what was typed, with a caret while it is typed into, or its hint
            const text = !e.text || !e.input
                ? e.text
                : e.input.text || e.input.focused
                  ? { ...e.text, text: e.input.text + (e.input.focused ? "|" : "") }
                  : { ...e.text, text: e.input.placeholder, opacity: e.text.opacity * 0.5 };
            if (text) this.paintText(target, text, x, y, w, h, scale);
            if (state) {
                target.globalCompositeOperation = "source-atop";
                target.fillStyle = state === 2 ? "rgba(0, 0, 0, 0.25)" : "rgba(255, 255, 255, 0.2)";
                target.fillRect(0, 0, width, height);
                ctx.drawImage(target.canvas, 0, 0);
            }
            if (e.clip) ctx.restore();
            if (this.highlight.has(e.object)) {
                ctx.strokeStyle = "#4d9cff";
                ctx.lineWidth = 1;
                ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
            }
            if (this.handles === e.object) {
                const size = Math.max(3, Math.round(UI_HANDLE * scale));
                ctx.fillStyle = "#ffffff";
                ctx.strokeStyle = "#4d9cff";
                ctx.lineWidth = 1;
                for (const handle of UI_HANDLES) {
                    const hx = Math.round(x + ((handle.h + 1) / 2) * w - size / 2);
                    const hy = Math.round(y + ((handle.v + 1) / 2) * h - size / 2);
                    ctx.fillRect(hx, hy, size, size);
                    ctx.strokeRect(hx + 0.5, hy + 0.5, size - 1, size - 1);
                }
            }
        }
        this.texture.needsUpdate = true;
        return this.texture;
    }

    dispose() {
        this.texture?.dispose();
        this.texture = null;
        this.canvas = null;
        this.spare = [];
        this.painted = "";
    }
}
