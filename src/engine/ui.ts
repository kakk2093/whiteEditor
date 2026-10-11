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

// The interface components of one entity, as a behavior gets them from self.ui(): the very objects the
// element is drawn from, so a changed field shows in the next frame
export interface UiElement {
    rect: UiRect;
    text?: UiText;
    image?: UiImage;
    button?: UiButton;
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

    // The button each pointer went down on (null: it went down elsewhere), by the number of the pointer
    private grabs = new Map<number, THREE.Object3D | null>();

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

    // Finds the elements and their places for a screen of this shape (width / height). For the elements of a
    // canvas the screen is always as many units high as the canvas says, so an interface looks the same in
    // a window of any size.
    layout(aspect: number) {
        this.aspect = aspect;
        this.elements = [];
        type Box = { left: number; top: number; width: number; height: number };
        // `parent` is null outside of a canvas: nothing there is an element
        const visit = (object: THREE.Object3D, parent: Box | null, units: number) => {
            if (!object.visible) return;
            // A canvas is the screen, wherever it stands
            const canvas = object.children.find((child) => child.userData.uiCanvas);
            if (canvas) {
                units = Math.max(1, (canvas.userData.uiCanvas as { height: number }).height);
                parent = { left: 0, top: 0, width: units * aspect, height: units };
            }
            const element = parent && uiOf(object);
            let box = parent;
            if (element && parent) {
                const { rect } = element;
                // No size of its own: as wide, or as high, as what it is in
                const width = rect.width > 0 ? rect.width : parent.width;
                const height = rect.height > 0 ? rect.height : parent.height;
                const ax = fraction(rect.anchor, "left", "right");
                const ay = fraction(rect.anchor, "top", "bottom");
                box = {
                    left: parent.left + ax * (parent.width - width) + rect.x,
                    top: parent.top + ay * (parent.height - height) + rect.y,
                    width,
                    height,
                };
                this.elements.push({ ...element, object, ...box, units });
            }
            for (const child of object.children) {
                // The objects of the components are not entities
                if (child.userData.component === undefined) visit(child, box, units);
            }
        };
        visit(this.root, null, 1);
    }

    // The element under a point of the screen (x, y from -1 to 1, as Input gives the mouse) that `wanted`
    // takes; the one drawn last is on top
    private pick(x: number, y: number, wanted: (element: UiElement) => unknown) {
        for (let i = this.elements.length - 1; i >= 0; i--) {
            const e = this.elements[i];
            if (!wanted(e)) continue;
            // The point in the units of the canvas of this element
            const px = ((x + 1) / 2) * e.units * this.aspect;
            const py = ((1 - y) / 2) * e.units;
            if (px >= e.left && px <= e.left + e.width && py >= e.top && py <= e.top + e.height) return e.object;
        }
        return null;
    }

    // The entity object of the element under a point of the screen, as of the last layout: one that shows
    // something, so an empty container over the whole screen is not in the way. The editor picks with it.
    elementAt(x: number, y: number) {
        return this.pick(x, y, (element) => element.text || element.image || element.button);
    }

    // Once a frame, before the behaviors: follows the mouse over the buttons. Returns the entity objects whose
    // buttons were clicked: pressed and released on the same one.
    update(aspect: number, input: Input): THREE.Object3D[] {
        this.layout(aspect);
        this.hovered.clear();
        this.held.clear();
        const clicked: THREE.Object3D[] = [];
        for (const pointer of input.pointers) {
            const over = this.pick(pointer.x, pointer.y, (element) => element.button?.enabled);
            if (pointer.pressed) this.grabs.set(pointer.id, over);
            const grabbed = this.grabs.get(pointer.id) ?? null;
            if (pointer.down && grabbed && grabbed === over) this.held.add(over);
            // A finger that is not on the screen is nowhere
            if (!pointer.down && !pointer.touch && over) this.hovered.add(over);
            if (pointer.released) {
                if (grabbed && grabbed === over) clicked.push(grabbed);
                this.grabs.delete(pointer.id);
            }
        }
        for (const element of this.elements) {
            if (element.button) element.button.held = this.held.has(element.object);
        }
        return clicked;
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
                e.left, e.top, e.width, e.height, e.units, e.text, e.image,
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
            if (e.image) this.paintImage(target, e.image, x, y, w, h);
            if (e.text) this.paintText(target, e.text, x, y, w, h, scale);
            if (state) {
                target.globalCompositeOperation = "source-atop";
                target.fillStyle = state === 2 ? "rgba(0, 0, 0, 0.25)" : "rgba(255, 255, 255, 0.2)";
                target.fillRect(0, 0, width, height);
                ctx.drawImage(target.canvas, 0, 0);
            }
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
