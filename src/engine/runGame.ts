import * as THREE from "three";
import { Game } from "./game";
import type { SceneCamera } from "./game";
import { resolveLook } from "./look";
import { RenderPipeline } from "./pipeline";
import type { Registry } from "./Registry";
import { fitAspect } from "./settings";
import type { SceneData, Vec3 } from "./types";

// The renderer of the editor viewport and of the built game: one place for its settings, so both look the same.
// `keepPicture` is for reading the canvas back as an image after it was drawn.
export function createRenderer(keepPicture = false) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: keepPicture });
    renderer.shadowMap.enabled = true;
    return renderer;
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
    game.runtime.onError = (message) => problems.push(message);
    const pipeline = new RenderPipeline(renderer);
    const look = options.look ?? data.environment?.look;
    if (look && !registry.getLookData(look)) problems.push(`Look "${look}" does not exist`);
    pipeline.setLook(look ? resolveLook(registry, look) : null, registry);

    // The same steps a game running at 60 frames a second would make
    game.start();
    const dt = 1 / 60;
    for (let t = dt; t <= time + 1e-6; t += dt) game.update(dt);

    let camera: SceneCamera;
    let kind: Still["camera"];
    if (options.camera) {
        kind = "given";
        camera = new THREE.PerspectiveCamera(options.camera.fov ?? 60, width / height, 0.1, 1000);
        camera.position.fromArray(options.camera.position);
        camera.lookAt(new THREE.Vector3(...options.camera.target));
    } else if (game.camera) {
        kind = "scene";
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

    pipeline.render(game.scene, camera, time);
    const png = renderer.domElement.toDataURL("image/png");

    game.dispose();
    pipeline.dispose();
    renderer.dispose();
    return { png, width, height, camera: kind, problems };
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
    let game: Game;
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
        game = new Game(registry, data, globals);
        const look = data.environment?.look;
        pipeline.setLook(look ? resolveLook(registry, look) : null, registry);
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
        // A script may have switched the camera on, off or replaced it
        game.resize(canvas.clientWidth, canvas.clientHeight);
        if (game.camera) pipeline.render(game.scene, game.camera, dt);
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
            pipeline.dispose();
            renderer.dispose();
            canvas.remove();
        },
    };
}
