import * as THREE from "three";
import { Game } from "./game";
import type { SceneCamera } from "./game";
import { resolveLook } from "./look";
import { RenderPipeline } from "./pipeline";
import type { Registry } from "./Registry";
import { fitAspect } from "./settings";
import { SoundPlayer } from "./sound";
import type { SceneData, Vec3 } from "./types";
import { uiOf } from "./ui";

// The renderer of the editor viewport and of the built game: one place for its settings, so both look the same.
// `keepPicture` is for reading the canvas back as an image after it was drawn.
export function createRenderer(keepPicture = false) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: keepPicture });
    renderer.shadowMap.enabled = true;
    return renderer;
}

// Something the player does at a moment of a scripted run (see StillOptions.inputs)
export interface PlayEvent {
    // Seconds from the start of the scene
    at: number;
    // A key ("KeyD", "Space", "Pad0") or a mouse button ("Mouse0") that goes down or up
    key?: string;
    down?: boolean;
    // Where the mouse goes: a point of the screen (-1..1, as Input gives it), or the name of an object: the
    // middle of its interface element, or the place of the object on the screen
    mouse?: [number, number] | string;
}

// One entity of the scene after a run, for checking what the game has come to
export interface EntityState {
    name: string;
    // In the world, rounded to millimeters
    position: Vec3;
    active: boolean;
    // Its size in the world, if it is not 1, 1, 1
    scale?: Vec3;
    // What its Text says, if it has one
    text?: string;
}

export interface StillOptions {
    // Size of the picture in pixels
    width?: number;
    height?: number;
    // Seconds the scene runs before the picture is taken: behaviors move, effects see this `time`
    time?: number;
    // Where to look from instead of the camera of the scene
    camera?: { position: Vec3; target: Vec3; fov?: number };
    // The look to draw with instead of the one of the scene; "" for none
    look?: string;
    // What the player does while the scene runs (within `time`): keys, the mouse, clicks
    inputs?: PlayEvent[];
    // true: the result tells where every entity is after the run and what the texts say
    state?: boolean;
}

export interface Still {
    // The picture as a data URL (image/png)
    png: string;
    width: number;
    height: number;
    // Which camera drew it: the one of the scene, the one given in the options, or, with neither, one placed
    // to see the whole scene
    camera: "scene" | "given" | "auto";
    // What went wrong on the way without stopping it: behaviors that threw, shaders that did not compile
    problems: string[];
    // With `state` in the options: the entities after the run, and what the behaviors keep in self.globals
    state?: { entities: EntityState[]; globals: Record<string, unknown> };
}

// One picture of a scene, drawn exactly as the game draws it: the same Game, look and pipeline as runGame().
// Needs a browser (WebGL); `npm run render` calls it in a headless one.
export function renderStill(registry: Registry, data: SceneData, options: StillOptions = {}): Still {
    const width = options.width ?? 960;
    const height = options.height ?? 540;
    const time = options.time ?? 0;
    const problems: string[] = [];

    const renderer = createRenderer(true);
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    renderer.debug.onShaderError = (gl, _program, vertexShader, fragmentShader) => {
        const log = gl.getShaderInfoLog(fragmentShader) || gl.getShaderInfoLog(vertexShader) || "does not link";
        problems.push(`Shader error: ${log.trim()}`);
    };

    const game = new Game(registry, data);
    // A picture makes no sound
    game.sound.enabled = false;
    game.runtime.onError = (message) => problems.push(message);
    const pipeline = new RenderPipeline(renderer);

    // The player of a scripted run: what is due by the time `t` is fed to the input of the game
    game.resize(width, height);
    const events = [...(options.inputs ?? [])].sort((a, b) => a.at - b.at);
    const act = (t: number) => {
        while (events.length > 0 && events[0].at <= t + 1e-6) {
            const event = events.shift()!;
            if (typeof event.mouse === "string") {
                const object = game.root.getObjectByName(event.mouse);
                game.ui.layout(width / height);
                const place = object && game.ui.placeOf(object);
                if (!object) {
                    problems.push(`Input: there is no object "${event.mouse}" at ${event.at} s`);
                } else if (place) {
                    game.input.setMouse(((place.left + place.width / 2) / (place.units * (width / height))) * 2 - 1, 1 - ((place.top + place.height / 2) / place.units) * 2);
                } else if (game.camera) {
                    game.camera.updateMatrixWorld();
                    const point = object.getWorldPosition(new THREE.Vector3()).project(game.camera);
                    game.input.setMouse(point.x, point.y);
                }
            } else if (event.mouse) {
                game.input.setMouse(event.mouse[0], event.mouse[1]);
            }
            const button = /^Mouse(\d)$/.exec(event.key ?? "");
            if (button) game.input.setMouseButton(Number(button[1]), event.down ?? true);
            else if (event.key) game.input.setKey(event.key, event.down ?? true);
        }
    };

    // The same steps a game running at 60 frames a second would make
    game.start();
    const dt = 1 / 60;
    for (let t = dt; t <= time + 1e-6; t += dt) {
        act(t - dt);
        game.update(dt);
    }
    // What falls on the very end of the run (a key let go then) is not too late
    act(time);
    for (const event of events) problems.push(`Input: ${event.key ?? "mouse"} at ${event.at} s is after the end of the run (${time} s)`);

    let state: Still["state"];
    if (options.state) {
        const entities: EntityState[] = [];
        const visit = (object: THREE.Object3D, active: boolean) => {
            const shown = active && object.visible;
            if (object.userData.entityId !== undefined || object.userData.innerId !== undefined) {
                const text = uiOf(object)?.text?.text;
                const position = object.getWorldPosition(new THREE.Vector3()).toArray().map((n) => Math.round(n * 1000) / 1000) as Vec3;
                const scale = object.getWorldScale(new THREE.Vector3()).toArray().map((n) => Math.round(n * 1000) / 1000) as Vec3;
                const scaled = scale.some((n) => n !== 1);
                entities.push({ name: object.name, position, active: shown, ...(scaled ? { scale } : {}), ...(text !== undefined ? { text } : {}) });
            }
            for (const child of object.children) {
                if (child.userData.component === undefined) visit(child, shown);
            }
        };
        game.root.updateMatrixWorld(true);
        visit(game.root, true);
        // Only what can be written down
        let globals: Record<string, unknown> = {};
        try {
            globals = JSON.parse(JSON.stringify(game.runtime.globals));
        } catch {
            problems.push("State: self.globals cannot be written as JSON");
        }
        state = { entities, globals };
    }

    // The look after the run: the camera may stand in a zone that has its own
    const look = options.look ?? game.lookName;
    if (look && !registry.getLookData(look)) problems.push(`Look "${look}" does not exist`);
    pipeline.setLook(look ? resolveLook(registry, look) : null, registry);

    let camera: SceneCamera;
    let kind: Still["camera"];
    if (options.camera) {
        kind = "given";
        camera = new THREE.PerspectiveCamera(options.camera.fov ?? 60, width / height, 0.1, 1000);
        camera.position.fromArray(options.camera.position);
        camera.lookAt(new THREE.Vector3(...options.camera.target));
    } else if (game.camera) {
        kind = "scene";
        // A behavior may have switched to another camera
        game.resize(width, height);
        camera = game.camera;
    } else {
        // No camera to look through: step back until everything is in the picture
        kind = "auto";
        const box = new THREE.Box3().setFromObject(game.root);
        const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
        const radius = box.isEmpty() ? 5 : Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
        camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
        camera.position.copy(center).add(new THREE.Vector3(1, 0.7, 1).normalize().multiplyScalar(radius * 2.2));
        camera.lookAt(center);
    }
    camera.updateMatrixWorld();

    pipeline.render(game.scene, camera, time, game.ui);
    const png = renderer.domElement.toDataURL("image/png");

    game.dispose();
    pipeline.dispose();
    renderer.dispose();
    return { png, width, height, camera: kind, problems, state };
}

// Shows a line of text over the game: a script error, or why there is nothing to see
function showMessage(container: HTMLElement, text: string) {
    let box = container.querySelector<HTMLElement>("[data-game-message]");
    if (!box) {
        box = document.createElement("div");
        box.dataset.gameMessage = "";
        box.style.cssText = "position:absolute;left:0;right:0;bottom:0;padding:8px 12px;font:13px sans-serif;" +
            "color:#fff;background:rgba(160,40,40,0.85);pointer-events:none";
        if (getComputedStyle(container).position === "static") container.style.position = "relative";
        container.appendChild(box);
    }
    box.textContent = text;
    box.style.display = text ? "" : "none";
}

// The whole game outside of the editor: fills `container` with a canvas, runs the scene with its behaviors and
// draws it through the camera of the scene. A built game (npm run build:game) is this function plus the
// project's scripts and assets.
// `scenes` is one scene, or every scene of the project by name with `start` naming the first: then
// self.loadScene() of a behavior goes from one to another. The picture has the shape the project settings
// give it (registry.settings.aspect), centered in the container.
export function runGame(container: HTMLElement, registry: Registry, scenes: SceneData | Record<string, SceneData>, start?: string) {
    const all: Record<string, SceneData> = "entities" in scenes ? { [start ?? "main"]: scenes as SceneData } : scenes;
    const first = start && all[start] ? start : Object.keys(all)[0];
    registry.setScenes(Object.keys(all));

    const renderer = createRenderer();
    const canvas = renderer.domElement;
    canvas.style.position = "absolute";
    if (getComputedStyle(container).position === "static") container.style.position = "relative";
    container.appendChild(canvas);

    // The look of the scene: the same drawing code as the editor viewport
    const pipeline = new RenderPipeline(renderer);
    // What the behaviors keep from scene to scene
    const globals: Record<string, unknown> = {};
    // One for all the scenes: the music goes on from one to the next
    const sound = new SoundPlayer(registry);
    let game: Game;
    // The look the pipeline has now; a zone the camera enters may bring another
    let shownLook = "";
    let detachInput = () => {};

    const resize = () => {
        const area = fitAspect(registry.settings, container.clientWidth, container.clientHeight);
        canvas.style.left = `${area.left}px`;
        canvas.style.top = `${area.top}px`;
        renderer.setSize(area.width, area.height);
        game.resize(area.width, area.height);
    };

    // Starts a scene; the one that was running is taken down first
    const enter = (name: string) => {
        const data = all[name];
        detachInput();
        game?.dispose();
        game = new Game(registry, data, globals, sound);
        shownLook = game.lookName;
        pipeline.setLook(shownLook ? resolveLook(registry, shownLook) : null, registry);
        game.runtime.onError = (message) => showMessage(container, message);
        detachInput = game.input.attach(canvas);
        showMessage(container, game.camera ? "" : `The scene "${name}" has no active object with a Camera component.`);
        resize();
        game.start();
    };
    enter(first);

    const observer = new ResizeObserver(resize);
    observer.observe(container);

    let frame = 0;
    let last = performance.now();
    const animate = () => {
        frame = requestAnimationFrame(animate);
        const now = performance.now();
        // A long pause (hidden tab) must not become one huge step
        const dt = Math.min((now - last) / 1000, 0.1);
        last = now;

        game.update(dt);
        // A behavior has asked for another scene: this one is over
        const next = game.requestedScene;
        if (next !== null) {
            if (all[next]) enter(next);
            else showMessage(container, `loadScene: there is no scene "${next}" in this game.`);
            game.runtime.requestedScene = null;
        }
        if (game.lookName !== shownLook) {
            shownLook = game.lookName;
            pipeline.setLook(shownLook ? resolveLook(registry, shownLook) : null, registry);
        }
        // A script may have switched the camera on, off or replaced it
        game.resize(canvas.clientWidth, canvas.clientHeight);
        if (game.camera) pipeline.render(game.scene, game.camera, dt, game.ui);
    };
    animate();

    return {
        get game() {
            return game;
        },
        stop() {
            cancelAnimationFrame(frame);
            observer.disconnect();
            detachInput();
            game.dispose();
            sound.dispose();
            pipeline.dispose();
            renderer.dispose();
            canvas.remove();
        },
    };
}
