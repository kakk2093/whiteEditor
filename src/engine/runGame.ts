import * as THREE from "three";
import { Game } from "./game";
import { resolveLook } from "./look";
import { RenderPipeline } from "./pipeline";
import type { Registry } from "./Registry";
import type { SceneData } from "./types";

// The renderer of the editor viewport and of the built game: one place for its settings, so both look the same
export function createRenderer() {
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.shadowMap.enabled = true;
    return renderer;
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
}

// The whole game outside of the editor: fills `container` with a canvas, runs the scene with its behaviors and
// draws it through the camera of the scene. A built game (npm run build:game) is this function plus the
// project's scripts and assets.
export function runGame(container: HTMLElement, registry: Registry, data: SceneData) {
    const renderer = createRenderer();
    container.appendChild(renderer.domElement);

    const game = new Game(registry, data);
    // The look of the scene: the same drawing code as the editor viewport
    const pipeline = new RenderPipeline(renderer);
    const look = data.environment?.look;
    pipeline.setLook(look ? resolveLook(registry, look) : null, registry);
    game.runtime.onError = (message) => showMessage(container, message);
    const detachInput = game.input.attach(renderer.domElement);
    if (!game.camera) showMessage(container, "The scene has no active object with a Camera component.");

    const resize = () => {
        renderer.setSize(container.clientWidth, container.clientHeight);
        game.resize(container.clientWidth, container.clientHeight);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    game.start();

    let frame = 0;
    let last = performance.now();
    const animate = () => {
        frame = requestAnimationFrame(animate);
        const now = performance.now();
        // A long pause (hidden tab) must not become one huge step
        const dt = Math.min((now - last) / 1000, 0.1);
        last = now;

        game.update(dt);
        // A script may have switched the camera on, off or replaced it
        game.resize(container.clientWidth, container.clientHeight);
        if (game.camera) pipeline.render(game.scene, game.camera, dt);
    };
    animate();

    return {
        game,
        stop() {
            cancelAnimationFrame(frame);
            observer.disconnect();
            detachInput();
            game.dispose();
            pipeline.dispose();
            renderer.dispose();
            renderer.domElement.remove();
        },
    };
}
