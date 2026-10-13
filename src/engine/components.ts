import * as THREE from "three";
import { paramDefaults } from "./Registry";
import type { ParamDef, Registry } from "./Registry";
import { createParticles } from "./particles";
import type { ParticleFields } from "./particles";
import { createLabel, createSprite } from "./sprites";
import type { LabelFields, SpriteFields } from "./sprites";
import type { ComponentData, EntityData, Params } from "./types";
import { UI_ANCHORS } from "./ui";
import { createModelFile } from "./gltf";
import type { ModelFileFields } from "./gltf";

// What a component can take from the project's scripts/: a code model, a behavior
export interface SourceDef {
    name: string;
    label?: string;
    params?: Record<string, ParamDef>;
}

// For components whose content is defined in scripts/ and picked by name
export interface ComponentSource {
    // The component field that holds the name; the params of the picked definition live in component.params
    key: string;
    // What it is called in messages: "model", "behavior"
    what: string;
    get: (registry: Registry, name: string) => SourceDef | undefined;
    list: (registry: Registry) => SourceDef[];
}

export interface ComponentDef {
    label: string;
    fields: Record<string, ParamDef>;
    // Builds the three.js object from the fields (defaults filled in); missing if the component draws nothing
    create?: (fields: Params, registry: Registry, component: ComponentData) => THREE.Object3D;
    source?: ComponentSource;
    // An entity may have several, one per source name; every other type is allowed once
    multiple?: boolean;
}

function createGeometry(shape: string): THREE.BufferGeometry {
    switch (shape) {
        case "sphere":
            return new THREE.SphereGeometry(0.5, 32, 16);
        case "cylinder":
            return new THREE.CylinderGeometry(0.5, 0.5, 1, 32);
        case "capsule":
            return new THREE.CapsuleGeometry(0.5, 1, 8, 16);
        case "plane":
            // Lies on the ground, facing up
            return new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
        default:
            return new THREE.BoxGeometry(1, 1, 1);
    }
}

// Lights and cameras look down their local -Z, so the entity rotation aims them
function createLight(f: Params): THREE.Light {
    const color = f.color as string;
    const intensity = f.intensity as number;
    const range = f.range as number;

    if (f.kind === "point") {
        const light = new THREE.PointLight(color, intensity, range);
        light.castShadow = f.castShadow as boolean;
        light.shadow.radius = f.shadowSoftness as number;
        return light;
    }

    const light = f.kind === "spot"
        ? new THREE.SpotLight(color, intensity, range, THREE.MathUtils.degToRad(f.angle as number), 0.3)
        : new THREE.DirectionalLight(color, intensity);
    light.target.position.set(0, 0, -1);
    light.add(light.target);
    light.castShadow = f.castShadow as boolean;
    light.shadow.mapSize.set(1024, 1024);
    light.shadow.radius = f.shadowSoftness as number;
    // A wide blur takes more samples to stay smooth
    light.shadow.blurSamples = (f.shadowSoftness as number) > 2 ? 16 : 8;

    if (light instanceof THREE.DirectionalLight) {
        const size = f.shadowSize as number;
        const camera = light.shadow.camera;
        camera.left = camera.bottom = -size;
        camera.right = camera.top = size;
        camera.far = 100;
    }
    return light;
}

// An object that draws nothing and only carries the fields of its component, for whoever looks for them
function marker(key: string, fields: Params) {
    const object = new THREE.Object3D();
    object.userData[key] = fields;
    return object;
}

// The components of the interface that need a UI Element next to them
export const UI_PARTS = ["text", "image", "button", "layout", "slider", "input", "scroll"];

// The built-in component types; the Inspector is generated from `fields`
export const componentDefs: Record<string, ComponentDef> = {
    mesh: {
        label: "Mesh",
        fields: {
            shape: { type: "select", default: "box", options: ["box", "sphere", "cylinder", "capsule", "plane"] },
            material: { type: "asset", kind: "material", default: "" },
            castShadow: { type: "boolean", default: true },
            receiveShadow: { type: "boolean", default: true },
        },
        create: (f, registry) => {
            const mesh = new THREE.Mesh(createGeometry(f.shape as string), registry.getMaterial(f.material as string));
            mesh.castShadow = f.castShadow as boolean;
            mesh.receiveShadow = f.receiveShadow as boolean;
            return mesh;
        },
    },
    light: {
        label: "Light",
        fields: {
            kind: { type: "select", default: "directional", options: ["directional", "point", "spot"] },
            color: { type: "color", default: "#ffffff" },
            intensity: { type: "number", default: 3, min: 0, step: 0.5 },
            castShadow: { type: "boolean", default: false },
            // point and spot: how far the light reaches, 0 = no limit
            range: { type: "number", default: 0, min: 0, step: 1, when: { kind: ["point", "spot"] } },
            // spot: cone half-angle, degrees
            angle: { type: "number", default: 30, min: 1, max: 89, step: 1, when: { kind: ["spot"] } },
            // directional: half-size of the area that gets shadows
            shadowSize: { type: "number", default: 10, min: 1, step: 1, when: { kind: ["directional"], castShadow: [true] } },
            // How blurred the edge of the shadows is: 0 hard, 1 as three.js draws them, more is softer
            shadowSoftness: { type: "number", default: 1, min: 0, max: 10, step: 0.5, when: { castShadow: [true] } },
        },
        create: createLight,
    },
    camera: {
        label: "Camera",
        fields: {
            // orthographic: no perspective, things do not get smaller with distance (isometric views, pixel art)
            projection: { type: "select", default: "perspective", options: ["perspective", "orthographic"] },
            fov: { type: "number", default: 60, min: 1, max: 179, step: 1, when: { projection: ["perspective"] } },
            // orthographic: half of the height of what the camera sees, meters
            size: { type: "number", default: 5, min: 0.01, step: 0.5, when: { projection: ["orthographic"] } },
            near: { type: "number", default: 0.1, min: 0.001, step: 0.1 },
            far: { type: "number", default: 1000, min: 1, step: 10 },
        },
        create: (f) => {
            const size = f.size as number;
            // The width follows the shape of the screen, see setCameraAspect()
            return f.projection === "orthographic"
                ? new THREE.OrthographicCamera(-size, size, size, -size, f.near as number, f.far as number)
                : new THREE.PerspectiveCamera(f.fov as number, 1, f.near as number, f.far as number);
        },
    },
    // The body of the entity for the running game: what self.move() stops at and what "enter" / "exit" of the
    // behaviors are about (see runtime.ts). It draws nothing; the editor shows its outline.
    collider: {
        label: "Collider",
        fields: {
            // The defaults are the sizes of the mesh shapes: a box 1 x 1 x 1, a sphere 1 across, a capsule 1
            // across and 2 high. All of it is in the units of the entity, so it scales with it. Nothing is ever
            // tilted: of a rotated entity the box that holds it is taken, and a capsule always stands upright.
            shape: { type: "select", default: "box", options: ["box", "sphere", "capsule"] },
            sizeX: { type: "number", default: 1, min: 0.01, step: 0.1, when: { shape: ["box"] } },
            sizeY: { type: "number", default: 1, min: 0.01, step: 0.1, when: { shape: ["box"] } },
            sizeZ: { type: "number", default: 1, min: 0.01, step: 0.1, when: { shape: ["box"] } },
            radius: { type: "number", default: 0.5, min: 0.01, step: 0.05, when: { shape: ["sphere", "capsule"] } },
            // From the very bottom to the very top, the round ends included
            height: { type: "number", default: 2, min: 0.01, step: 0.1, when: { shape: ["capsule"] } },
            // Where its middle is, from the middle of the entity (in the entity's own units)
            centerX: { type: "number", default: 0, step: 0.1 },
            centerY: { type: "number", default: 0, step: 0.1 },
            centerZ: { type: "number", default: 0, step: 0.1 },
            // false: nothing stops at it, it only tells what touches it (a trigger: a coin, a door zone)
            solid: { type: "boolean", default: true },
            // A collision layer of the project (project.json); layers can be set not to collide with each other
            layer: { type: "asset", kind: "layer", default: "" },
        },
        create: (f) => {
            const marker = new THREE.Object3D();
            marker.position.set(f.centerX as number, f.centerY as number, f.centerZ as number);
            marker.userData.collider = f;
            return marker;
        },
    },
    // A box of the world with an environment of its own (see environment.ts): while the camera is inside
    // it, the scene has the fog, the light and the look written here. Under water, a cave, a room.
    zone: {
        label: "Zone",
        fields: {
            // The box, in the units of the entity, around its middle; it turns and grows with the entity
            sizeX: { type: "number", default: 4, min: 0.01, step: 0.5 },
            sizeY: { type: "number", default: 3, min: 0.01, step: 0.5 },
            sizeZ: { type: "number", default: 4, min: 0.01, step: 0.5 },
            // Seconds the colors and the numbers take to change when the camera comes in or goes out
            blend: { type: "number", default: 0.5, min: 0, step: 0.1 },
            // The sky of the scene is seen from inside; off, there is the plain background below instead
            // (a cave, under water). A scene without a sky has that background either way.
            sky: { type: "boolean", default: true },
            background: { type: "color", default: "#0b4a5c" },
            ambientColor: { type: "color", default: "#ffffff" },
            ambientIntensity: { type: "number", default: 1, min: 0, step: 0.1 },
            fog: { type: "boolean", default: true },
            fogColor: { type: "color", default: "#0b4a5c" },
            fogNear: { type: "number", default: 1, min: 0, step: 1 },
            fogFar: { type: "number", default: 20, min: 0, step: 1 },
            // The look inside the zone; none keeps the look of the scene
            look: { type: "asset", kind: "look", default: "" },
        },
        create: (f) => marker("zone", f),
    },
    // An emitter of particles (see particles.ts): sparks, smoke, dust. They fly off along the "up" of the
    // entity (its local Y) and stay in the world when it moves on.
    particles: {
        label: "Particles",
        fields: {
            // The steady stream is on; off, the emitter waits for self.particles().emit()
            playing: { type: "boolean", default: true },
            // Particles per second
            rate: { type: "number", default: 20, min: 0, step: 1 },
            // How many can live at once; the oldest goes when a new one has no room
            max: { type: "number", default: 200, min: 1, max: 5000, step: 10 },
            // Seconds a particle lives (each a little more or less)
            lifetime: { type: "number", default: 1.5, min: 0.05, step: 0.1 },
            // Meters per second at the start
            speed: { type: "number", default: 2, min: 0, step: 0.1 },
            // How far from "up" they may fly, degrees: 0 is a jet, 180 is every way
            spread: { type: "number", default: 25, min: 0, max: 180, step: 5 },
            // They appear anywhere this near the entity, meters
            radius: { type: "number", default: 0, min: 0, step: 0.05 },
            // Pulls them down (meters per second squared); below zero they rise, like smoke
            gravity: { type: "number", default: 0, step: 0.5 },
            // Meters across, at the start and at the end of the life
            size: { type: "number", default: 0.15, min: 0, step: 0.01 },
            sizeEnd: { type: "number", default: 0.05, min: 0, step: 0.01 },
            color: { type: "color", default: "#ffd27a" },
            colorEnd: { type: "color", default: "#ff5a1f" },
            opacity: { type: "number", default: 1, min: 0, max: 1, step: 0.05 },
            // Fades out towards the end of the life
            fade: { type: "boolean", default: true },
            // square keeps hard pixels (pixel art), circle is a hard dot, soft a blurred one
            shape: { type: "select", default: "square", options: ["square", "circle", "soft"] },
            // Adds its light to what is behind it: fire, sparks, magic. Off for smoke and dust.
            additive: { type: "boolean", default: false },
        },
        create: (f) => createParticles(f as unknown as ParticleFields),
    },
    // A flat picture in the world (see sprites.ts): unlit, it can keep facing the camera
    sprite: {
        label: "Sprite",
        fields: {
            // An image of assets/; none is a plain rectangle of the color
            texture: { type: "asset", kind: "texture", default: "" },
            // The image is multiplied by it
            color: { type: "color", default: "#ffffff" },
            opacity: { type: "number", default: 1, min: 0, max: 1, step: 0.05 },
            // Meters
            width: { type: "number", default: 1, min: 0.01, step: 0.1 },
            height: { type: "number", default: 1, min: 0.01, step: 0.1 },
            // Always turned to the camera
            billboard: { type: "boolean", default: true },
            filter: { type: "select", default: "nearest", options: ["nearest", "linear"] },
        },
        create: (f, registry) => createSprite(f as unknown as SpriteFields, registry),
    },
    // A text in the world: a name over a head, a sign, a number that flies up
    label: {
        label: "Label",
        fields: {
            text: { type: "string", default: "Label" },
            font: { type: "asset", kind: "font", default: "" },
            // The height of a line, meters
            size: { type: "number", default: 0.4, min: 0.01, step: 0.05 },
            color: { type: "color", default: "#ffffff" },
            opacity: { type: "number", default: 1, min: 0, max: 1, step: 0.05 },
            // A line around the letters, in parts of the height of a line: 0.08 is a clear edge
            outline: { type: "number", default: 0.08, min: 0, max: 0.5, step: 0.02 },
            outlineColor: { type: "color", default: "#000000" },
            billboard: { type: "boolean", default: true },
        },
        create: (f, registry) => createLabel(f as unknown as LabelFields, registry),
    },
    // Makes the entity a body of the physics (see physics.ts), like Rigidbody in Unity: it falls, rolls, is
    // pushed and bounces. Its shape is the Collider of the same entity, which has to be solid.
    body: {
        label: "Body",
        fields: {
            // Kilograms: what a heavier body does to a lighter one when they meet
            mass: { type: "number", default: 1, min: 0.01, step: 0.5 },
            // 0 slides like ice, 1 grips
            friction: { type: "number", default: 0.5, min: 0, max: 1, step: 0.05 },
            // 0 lands dead, 1 bounces back as high as it fell from
            bounce: { type: "number", default: 0.1, min: 0, max: 1, step: 0.05 },
            // How fast it loses its speed and its spin by itself, as if in thick air
            damping: { type: "number", default: 0.05, min: 0, max: 1, step: 0.05 },
            // Keeps it upright: it is pushed around but never tips over (a character, a crate that only slides)
            lockRotation: { type: "boolean", default: false },
            // Off: it floats, and only moves when something pushes it
            gravity: { type: "boolean", default: true },
        },
        create: (f) => marker("body", f),
    },
    // What the entity sounds like in the running game: an audio file of assets/. It draws nothing; the Runtime
    // starts it (see runtime.ts), a behavior can do it too with self.sound().play().
    sound: {
        label: "Sound",
        fields: {
            sound: { type: "asset", kind: "sound", default: "" },
            volume: { type: "number", default: 1, min: 0, step: 0.05 },
            // Speed of playing: 2 is twice as fast and an octave higher
            pitch: { type: "number", default: 1, min: 0.1, max: 4, step: 0.05 },
            loop: { type: "boolean", default: false, when: { music: [false] } },
            // Starts with the scene (or when the entity appears); off, it waits for self.sound().play()
            autoplay: { type: "boolean", default: true },
            // The music of the game: one at a time, always looping, and it goes on from scene to scene. If the
            // next scene names the same file as its music, it plays on unbroken; another file takes its place.
            // It does not end with the entity.
            music: { type: "boolean", default: false },
            // Comes from where the entity is: quieter with the distance from the camera, to the left or to the right
            spatial: { type: "boolean", default: false, when: { music: [false] } },
            // The distance from the camera, meters, at which nothing is heard any more
            range: { type: "number", default: 20, min: 0.1, step: 1, when: { music: [false], spatial: [true] } },
        },
        create: (f) => {
            const marker = new THREE.Object3D();
            marker.userData.sound = f;
            return marker;
        },
    },
    // The ears of the scene: the distance of the spatial sounds is counted from this entity instead of the
    // camera. For a camera that stands far from what it shows (an isometric view): put it on the player.
    listener: {
        label: "Sound Listener",
        fields: {},
        create: () => {
            const marker = new THREE.Object3D();
            marker.userData.listener = true;
            return marker;
        },
    },
    // The interface of the game (see ui.ts) lives inside a Canvas, like in Unity: the entity with this
    // component is the screen, and the UI Elements under it are laid out from its edges. Switching it off
    // hides all of them.
    canvas: {
        label: "Canvas",
        fields: {
            // How many units of the interface the screen is high for the elements of this canvas, whatever
            // its size in pixels (what Canvas Scaler is in Unity): an element 54 units high takes a tenth of
            // it with the default 540. The width follows the shape of the screen.
            height: { type: "number", default: 540, min: 1, step: 10 },
        },
        create: (f) => marker("uiCanvas", f),
    },
    // An element of the interface: an entity under a Canvas, drawn flat over the picture, not in the world.
    // Its place is the fields below, not its position. Text, Image and Button on the same entity are what
    // is drawn in that place.
    ui: {
        label: "UI Element",
        fields: {
            // Where on its parent (the canvas, or the element it is a child of) it is pinned
            anchor: { type: "select", default: "center", options: UI_ANCHORS },
            // From the anchor, in the units of the interface (the screen is as many of them high as the
            // canvas says): x to the right, y down
            x: { type: "number", default: 0, step: 1 },
            y: { type: "number", default: 0, step: 1 },
            // 0: as wide, as high, as the parent; below 0: the parent with so much taken off (-20 leaves 10 on
            // either side of an element anchored at the center)
            width: { type: "number", default: 200, step: 1 },
            height: { type: "number", default: 50, step: 1 },
        },
        create: (f) => marker("ui", f),
    },
    text: {
        label: "Text",
        fields: {
            text: { type: "string", default: "Text" },
            // A font file of assets/; none is the plain font of the system
            font: { type: "asset", kind: "font", default: "" },
            size: { type: "number", default: 24, min: 1, step: 1 },
            color: { type: "color", default: "#ffffff" },
            opacity: { type: "number", default: 1, min: 0, max: 1, step: 0.05 },
            align: { type: "select", default: "center", options: ["left", "center", "right"] },
            vertical: { type: "select", default: "middle", options: ["top", "middle", "bottom"] },
            // Goes to the next line where the element ends
            wrap: { type: "boolean", default: true },
            // A line around the letters, to read them over any picture; 0 is none
            outline: { type: "number", default: 0, min: 0, step: 0.5 },
            outlineColor: { type: "color", default: "#000000" },
            // No soft edges: every pixel is either there or not. For pixel fonts.
            sharp: { type: "boolean", default: false },
        },
        create: (f) => marker("uiText", f),
    },
    image: {
        label: "Image",
        fields: {
            // An image of assets/ stretched over the element; none is a plain rectangle of the color
            texture: { type: "asset", kind: "texture", default: "" },
            // The color of the rectangle; an image is multiplied by it
            color: { type: "color", default: "#ffffff" },
            opacity: { type: "number", default: 1, min: 0, max: 1, step: 0.05 },
            // Off keeps the pixels of a scaled image hard
            smooth: { type: "boolean", default: false },
        },
        create: (f) => marker("uiImage", f),
    },
    // Makes the element something to click: the behaviors of the entity get click()
    button: {
        label: "Button",
        fields: {
            enabled: { type: "boolean", default: true },
        },
        create: (f) => marker("uiButton", f),
    },
    // Puts the child elements one after another, each next to the previous one; their own anchor, x and y
    // do not count, their sizes do
    layout: {
        label: "Layout",
        fields: {
            direction: { type: "select", default: "column", options: ["column", "row"] },
            // Between the children, and from the edges of the element to them
            gap: { type: "number", default: 8, min: 0, step: 1 },
            padding: { type: "number", default: 0, min: 0, step: 1 },
            // Across the line: at its start (the left of a column, the top of a row), in the middle, at the
            // end, or stretched from side to side
            align: { type: "select", default: "start", options: ["start", "center", "end", "stretch"] },
        },
        create: (f) => marker("uiLayout", f),
    },
    // A value set by dragging along the element: the behaviors of the entity get change(self, value)
    slider: {
        label: "Slider",
        fields: {
            value: { type: "number", default: 0.5, step: 0.05 },
            min: { type: "number", default: 0, step: 0.1 },
            max: { type: "number", default: 1, step: 0.1 },
            // The value goes in steps of this; 0: any value
            step: { type: "number", default: 0, min: 0, step: 0.05 },
            enabled: { type: "boolean", default: true },
            // The part of the element up to the value, and the knob at it
            fill: { type: "color", default: "#4d9cff" },
            knob: { type: "color", default: "#ffffff" },
        },
        create: (f) => marker("uiSlider", f),
    },
    // A line of text the player types, shown by the Text of the same entity: a click on the element takes the
    // keyboard, the behaviors get change(self, text) at every letter and submit(self, text) at Enter
    input: {
        label: "Input Field",
        fields: {
            text: { type: "string", default: "" },
            // Shown, paler, while there is no text
            placeholder: { type: "string", default: "Type here" },
            // The longest text, in characters; 0: any
            max: { type: "number", default: 32, min: 0, step: 1 },
            enabled: { type: "boolean", default: true },
        },
        create: (f) => marker("uiInput", f),
    },
    // Shows only what of its child elements is inside it; the rest comes by dragging or by the mouse wheel
    scroll: {
        label: "Scroll",
        fields: {
            // How far the content has gone up, in the units of the interface
            offset: { type: "number", default: 0, min: 0, step: 10 },
            enabled: { type: "boolean", default: true },
        },
        create: (f) => marker("uiScroll", f),
    },
    // A model made elsewhere and kept as a file of assets/ (glTF: .glb or .gltf), with its own materials
    // and, if it has them, animations
    gltf: {
        label: "glTF Model",
        fields: {
            file: { type: "asset", kind: "gltf", default: "" },
            castShadow: { type: "boolean", default: true },
            receiveShadow: { type: "boolean", default: true },
            // The name of the clip that plays from the start of the game; "" for none
            animation: { type: "string", default: "" },
            loop: { type: "boolean", default: true },
            speed: { type: "number", default: 1, min: 0, step: 0.1 },
        },
        create: (f, registry) => createModelFile(f as unknown as ModelFileFields, f.file ? registry.loadModelFile(f.file as string) : null),
    },
    // A model built by a project script (defineModel)
    model: {
        label: "Model",
        fields: {},
        create: (_fields, registry, component) => createModelObject(registry, component),
        source: {
            key: "model",
            what: "model",
            get: (registry, name) => registry.getModel(name),
            list: (registry) => registry.models(),
        },
    },
    // A behavior from a project script (defineBehavior); it draws nothing and runs in Play, see runtime.ts
    script: {
        label: "Script",
        fields: {},
        source: {
            key: "script",
            what: "behavior",
            get: (registry, name) => registry.getBehavior(name),
            list: (registry) => registry.behaviors(),
        },
        multiple: true,
    },
};

// Tells the components of one entity apart: "mesh", "light", "script:spin"
export function componentKey(component: ComponentData) {
    const def = componentDefs[component.type];
    return def?.multiple && def.source ? `${component.type}:${component[def.source.key]}` : component.type;
}

export function findComponent(entity: EntityData, key: string) {
    return entity.components.find((c) => componentKey(c) === key) ?? null;
}

// Behaviors have no three.js object of their own; the Runtime starts them from the group of their entity
export function setScripts(group: THREE.Object3D, components: ComponentData[]) {
    const scripts = components.filter((c) => c.type === "script");
    if (scripts.length > 0) group.userData.scripts = scripts;
    else delete group.userData.scripts;
}

// Frees the GPU resources of an object that was removed from the scene
export function disposeObject(obj: THREE.Object3D) {
    obj.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.geometry) return;
        // The geometries of a model file are shared by every entity that shows the file
        if (!mesh.geometry.userData.shared) mesh.geometry.dispose();
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        // Material assets are shared between meshes and owned by the registry
        materials.forEach((m) => {
            if (!m.userData.shared) m.dispose();
        });
    });
}

// Shown instead of a model or prefab that does not exist, so the scene still loads
export function createPlaceholder() {
    return new THREE.Mesh(
        new THREE.BoxGeometry(),
        new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true })
    );
}

function createModelObject(registry: Registry, component: ComponentData) {
    const name = component.model as string;
    const def = registry.getModel(name);
    if (!def) {
        console.warn(`Unknown model "${name}"`);
        return createPlaceholder();
    }
    return def.create({ ...registry.modelDefaults(name), ...(component.params as Params | undefined) });
}

// The three.js object of one component; it becomes a child of the entity's group
export function createComponentObject(registry: Registry, component: ComponentData): THREE.Object3D | null {
    const def = componentDefs[component.type];
    if (!def) {
        console.warn(`Unknown component "${component.type}"`);
        return null;
    }
    if (!def.create) return null;

    const obj = def.create({ ...paramDefaults(def.fields), ...component } as Params, registry, component);
    obj.userData.component = componentKey(component);
    return obj;
}

// Replaces the three.js object of one component of the entity after the component was added, removed or changed.
// `group` is the object of the entity, `key` is the componentKey() of the component.
export function rebuildComponentObject(registry: Registry, group: THREE.Object3D, entity: EntityData, key: string) {
    const old = group.children.find((c) => c.userData.component === key);
    if (old) {
        group.remove(old);
        disposeObject(old);
    }
    setScripts(group, entity.components);
    const component = findComponent(entity, key);
    const created = component && createComponentObject(registry, component);
    if (created) group.add(created);
}
