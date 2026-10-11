import * as THREE from "three";
import type { Registry } from "./Registry";

// Flat things in the world: a picture (Sprite) and a line of text (Label). Unlike the interface they have a
// place in the scene: a tree made of one picture, a name over a head, a number that flies up from a hit.
// Both are a plane with an unlit material, which can keep facing the camera.

// The fields of the two components, defaults filled in (see components.ts)
export interface SpriteFields {
    texture: string;
    color: string;
    opacity: number;
    width: number;
    height: number;
    billboard: boolean;
    filter: string;
}

export interface LabelFields {
    text: string;
    font: string;
    size: number;
    color: string;
    opacity: number;
    outline: number;
    outlineColor: string;
    billboard: boolean;
}

const parentTurn = new THREE.Quaternion();

function createPlane(color: string, opacity: number, billboard: boolean) {
    const material = new THREE.MeshBasicMaterial({ color, opacity, transparent: true, alphaTest: 0.01, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    if (billboard) {
        // Turned to the camera that is drawing it, whatever the entity is turned to
        mesh.onBeforeRender = (_renderer, _scene, camera) => {
            mesh.quaternion.copy(camera.quaternion);
            if (mesh.parent) mesh.quaternion.premultiply(mesh.parent.getWorldQuaternion(parentTurn).invert());
            mesh.updateMatrixWorld();
        };
    }
    return mesh;
}

// The three.js object of a Sprite component
export function createSprite(fields: SpriteFields, registry: Registry) {
    const mesh = createPlane(fields.color, fields.opacity, fields.billboard);
    mesh.scale.set(fields.width, fields.height, 1);
    const material = mesh.material;
    const setMap = (image: HTMLImageElement) => {
        const map = new THREE.Texture(image);
        map.colorSpace = THREE.SRGBColorSpace;
        const nearest = fields.filter !== "linear";
        map.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
        map.minFilter = nearest ? THREE.NearestFilter : THREE.LinearMipmapLinearFilter;
        map.generateMipmaps = !nearest;
        map.needsUpdate = true;
        material.map = map;
        material.needsUpdate = true;
    };
    // The image arrives later: until then the sprite is a plain rectangle of its color
    const image = fields.texture ? registry.loadTexture(fields.texture) : null;
    if (image instanceof Promise) image.then(setMap).catch(() => console.warn(`Texture "${fields.texture}" could not be loaded`));
    else if (image) setMap(image);
    return mesh;
}

// How many pixels of its picture a line of a label is high
const LINE = 64;

// The three.js object of a Label component. Its userData.label has redraw(text?), which a behavior reaches
// through self.setText().
export function createLabel(fields: LabelFields, registry: Registry) {
    const mesh = createPlane("#ffffff", fields.opacity, fields.billboard);
    const state = { ...fields };

    const redraw = (text = state.text) => {
        state.text = text;
        if (typeof document === "undefined") return;
        const family = (state.font && registry.fontFamily(state.font)) || "sans-serif";
        const lines = String(text).split("\n");
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d")!;
        const font = `${LINE * 0.8}px ${family}`;
        // The line around the letters is in the units of the letters: 0.1 is a tenth of a line
        const edge = Math.max(0, state.outline) * LINE;
        ctx.font = font;
        const widest = Math.max(1, ...lines.map((line) => ctx.measureText(line).width));
        canvas.width = Math.ceil(widest + edge * 2 + 4);
        canvas.height = Math.ceil(lines.length * LINE + edge * 2);
        ctx.font = font;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        lines.forEach((line, i) => {
            const y = edge + LINE * (i + 0.5);
            if (edge > 0) {
                ctx.lineWidth = edge * 2;
                ctx.lineJoin = "round";
                ctx.strokeStyle = state.outlineColor;
                ctx.strokeText(line, canvas.width / 2, y);
            }
            ctx.fillStyle = state.color;
            ctx.fillText(line, canvas.width / 2, y);
        });

        mesh.material.map?.dispose();
        const map = new THREE.CanvasTexture(canvas);
        map.colorSpace = THREE.SRGBColorSpace;
        mesh.material.map = map;
        mesh.material.needsUpdate = true;
        // `size` is the height of one line, meters
        const height = (canvas.height / LINE) * state.size;
        mesh.scale.set((canvas.width / canvas.height) * height, height, 1);
    };
    redraw();
    // Drawn with a plain font until its own is loaded
    if (state.font && !registry.fontFamily(state.font)) registry.fontReady(state.font)?.then(() => redraw());

    mesh.userData.label = { redraw };
    return mesh;
}

// Sets what the Label of an entity object says; false if it has no Label
export function setLabelText(object: THREE.Object3D, text: string) {
    const label = object.children.find((child) => child.userData.label)?.userData.label as { redraw: (text: string) => void } | undefined;
    label?.redraw(text);
    return label !== undefined;
}
