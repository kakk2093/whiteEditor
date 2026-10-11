import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { createRenderer, RenderPipeline, resolveLook, setCameraAspect } from "../engine";
import type { Input } from "../engine";
import { dropAsset, getDraggedAsset } from "../editor/core/dnd";
import { ColliderHandles } from "./colliderHandles";
import { EDITOR_LAYER, sceneStore } from "../editor/core/SceneStore";
import type { GizmoMode } from "../editor/core/SceneStore";
import { useSceneStore } from "../editor/core/useSceneStore";
import { openContextMenu } from "../editor/contextMenu";
import { entityContextMenu, sceneContextMenu } from "../editor/createMenu";
import { Icon } from "../editor/ui";
import type { IconName } from "../editor/ui";

const GIZMO_MODES: { mode: GizmoMode; icon: IconName; title: string }[] = [
    { mode: "translate", icon: "move", title: "Move (W)" },
    { mode: "rotate", icon: "rotate", title: "Rotate (E)" },
    { mode: "scale", icon: "scale", title: "Scale (R)" }
];

interface ViewportContext {
    renderer: THREE.WebGLRenderer | null;
    camera: THREE.PerspectiveCamera | null;
    controls: OrbitControls | null;
    transform: TransformControls | null;
    raycaster: THREE.Raycaster | null;
    mouse: THREE.Vector2 | null;
    animationId: number | null;
}

// The view of a selected camera: its part of the viewport's width and height, and its distance from the corner.
// The same numbers are in editor.css (.viewport-preview).
const PREVIEW_SIZE = 0.3;
const PREVIEW_MARGIN = 10;

export default function Viewport() {
    const store = useSceneStore();
    const ref = useRef<HTMLDivElement>(null);
    const contextRef = useRef<ViewportContext>({
        renderer: null,
        camera: null,
        controls: null,
        transform: null,
        raycaster: null,
        mouse: null,
        animationId: null
    });
    // Set by the effect below: the entity under a screen point, or null
    const pickRef = useRef<(clientX: number, clientY: number) => string | null>(() => null);
    // Where the last mouse button went down, to tell a click from a drag
    // `moved` is set once that press turned into looking around or flying
    const downRef = useRef({ x: 0, y: 0, moved: false });

    useEffect(() => {
        if (!ref.current) return;

        const ctx = contextRef.current;

        // =====================
        // CAMERA & RENDERER
        // =====================
        const width = ref.current.clientWidth;
        const height = ref.current.clientHeight;

        ctx.camera = new THREE.PerspectiveCamera(
            60,
            width / height,
            0.1,
            1000
        );
        ctx.camera.position.set(0, 2, 5);

        // The same renderer settings as the built game
        ctx.renderer = createRenderer();
        ctx.renderer.setSize(width, height);
        ref.current.appendChild(ctx.renderer.domElement);

        // =====================
        // CONTROLS
        // =====================
        ctx.controls = new OrbitControls(ctx.camera, ctx.renderer.domElement);
        ctx.controls.enableDamping = true;
        // Like in Unity: left drag orbits, middle drag pans, the right button is for looking around and flying
        ctx.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: null };

        ctx.transform = new TransformControls(ctx.camera, ctx.renderer.domElement);
        ctx.transform.addEventListener("dragging-changed", (e) => {
            if (ctx.controls) ctx.controls.enabled = !e.value;
        });
        // Keep the Inspector in sync while dragging the gizmo
        ctx.transform.addEventListener("objectChange", () => {
            sceneStore.syncFromGizmo();
        });

        // TransformControls is not an Object3D, its gizmo has to be added separately
        const gizmo = ctx.transform.getHelper();
        sceneStore.scene.add(gizmo);

        // "Edit Collider": handles on the collider of the selected object
        const handles = new ColliderHandles(ctx.camera, ctx.renderer.domElement, ctx.controls);
        sceneStore.scene.add(handles.group);

        // The ground grid: 1 cell = 1 meter
        const grid = new THREE.GridHelper(40, 40, 0x5a5d66, 0x3a3c43);
        // Just below the ground, so a floor at y = 0 covers it instead of flickering with it
        grid.position.y = -0.002;
        grid.layers.set(EDITOR_LAYER);
        sceneStore.scene.add(grid);

        // Writes depth only: lets the scene hide the editor layer behind its objects
        const depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false });

        ctx.raycaster = new THREE.Raycaster();
        // The markers of lights and cameras are clickable
        ctx.raycaster.layers.enable(EDITOR_LAYER);
        ctx.mouse = new THREE.Vector2();

        // =====================
        // SELECTION
        // =====================
        // Select on click only, so orbiting the camera or dragging the gizmo keeps the selection
        const CLICK_THRESHOLD = 4;
        let downX = 0;
        let downY = 0;
        let downOnGizmo = false;

        const onPointerDown = (e: PointerEvent) => {
            downX = e.clientX;
            downY = e.clientY;
            downRef.current = { x: e.clientX, y: e.clientY, moved: false };
            downOnGizmo = !!ctx.transform?.axis;
        };

        const onPointerUp = (e: PointerEvent) => {
            if (!ctx.renderer || !ctx.raycaster || !ctx.mouse || !ctx.camera) return;
            if (e.button !== 0 || downOnGizmo || handles.grabbed) return;
            if (Math.hypot(e.clientX - downX, e.clientY - downY) > CLICK_THRESHOLD) return;
            if (sceneStore.gameView) return;

            // Ctrl or Shift adds to the selection (or takes out of it)
            sceneStore.select(pickRef.current(e.clientX, e.clientY), e.ctrlKey || e.metaKey || e.shiftKey);
        };

        pickRef.current = (clientX, clientY) => {
            if (!ctx.renderer || !ctx.raycaster || !ctx.mouse || !ctx.camera) return null;
            if (sceneStore.gameView) return null;

            const rect = ctx.renderer.domElement.getBoundingClientRect();
            ctx.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
            ctx.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

            // The camera the viewport is looking through: in the Game view that is the camera of the scene
            const camera = sceneStore.gameCamera(rect.width, rect.height) ?? ctx.camera;
            ctx.raycaster.setFromCamera(ctx.mouse, camera);

            const hits = ctx.raycaster.intersectObjects(sceneStore.viewRoot.children, true);

            // The hit mesh is a part of a model, so walk up to the entity that owns it
            let obj: THREE.Object3D | null = hits.length > 0 ? hits[0].object : null;
            while (obj && !obj.userData.entityId) obj = obj.parent;

            return obj ? obj.userData.entityId : null;
        };

        ctx.renderer.domElement.addEventListener("pointerdown", onPointerDown);
        ctx.renderer.domElement.addEventListener("pointerup", onPointerUp);

        // =====================
        // FLY (hold right mouse button)
        // =====================
        // Mouse looks around, W/A/S/D move, Q/E go down/up, Shift is faster
        const FLY_SPEED = 5;
        const LOOK_SPEED = 0.003;
        const FLY_KEYS = ["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE"];
        const pressed = new Set<string>();
        const domElement = ctx.renderer.domElement;

        const stopFlying = () => {
            sceneStore.flying = false;
            pressed.clear();
        };

        const onFlyDown = (e: PointerEvent) => {
            if (e.button !== 2 || sceneStore.gameView) return;
            sceneStore.flying = true;
            domElement.setPointerCapture(e.pointerId);
        };

        const onFlyMove = (e: PointerEvent) => {
            if (!sceneStore.flying || !ctx.camera || !ctx.controls) return;
            if (e.movementX === 0 && e.movementY === 0) return;
            flight = null;

            // Turn the view direction, keeping the camera in place
            const offset = ctx.controls.target.clone().sub(ctx.camera.position);
            const spherical = new THREE.Spherical().setFromVector3(offset);
            spherical.theta -= e.movementX * LOOK_SPEED;
            spherical.phi = THREE.MathUtils.clamp(spherical.phi + e.movementY * LOOK_SPEED, 0.05, Math.PI - 0.05);
            ctx.controls.target.copy(ctx.camera.position).add(offset.setFromSpherical(spherical));

            if (Math.hypot(e.clientX - downRef.current.x, e.clientY - downRef.current.y) > CLICK_THRESHOLD) {
                downRef.current.moved = true;
            }
        };

        const onFlyUp = (e: PointerEvent) => {
            if (e.button === 2) stopFlying();
        };

        const onFlyKey = (e: KeyboardEvent) => {
            if (e.type === "keyup") pressed.delete(e.code);
            else if (sceneStore.flying && (FLY_KEYS.includes(e.code) || e.code.startsWith("Shift"))) pressed.add(e.code);
        };

        domElement.addEventListener("pointerdown", onFlyDown);
        domElement.addEventListener("pointermove", onFlyMove);
        domElement.addEventListener("pointerup", onFlyUp);
        window.addEventListener("keydown", onFlyKey);
        window.addEventListener("keyup", onFlyKey);
        window.addEventListener("blur", stopFlying);

        const fly = (dt: number) => {
            if (!sceneStore.flying || !ctx.camera || !ctx.controls) return;
            const axis = (plus: string, minus: string) => Number(pressed.has(plus)) - Number(pressed.has(minus));
            const move = new THREE.Vector3(axis("KeyD", "KeyA"), 0, -axis("KeyW", "KeyS"));
            const lift = axis("KeyE", "KeyQ");
            if (move.lengthSq() === 0 && lift === 0) return;

            const fast = pressed.has("ShiftLeft") || pressed.has("ShiftRight");
            // Forward and sideways follow the camera, up and down follow the world
            move.applyQuaternion(ctx.camera.quaternion).setY(move.y + lift);
            move.normalize().multiplyScalar(FLY_SPEED * (fast ? 3 : 1) * dt);

            ctx.camera.position.add(move);
            ctx.controls.target.add(move);
            downRef.current.moved = true;
            flight = null;
        };

        // =====================
        // FOCUS (F)
        // =====================
        // The camera flies to a point from which the whole object is visible, keeping its view direction
        const FOCUS_TIME = 0.25;
        let flight: { fromPos: THREE.Vector3; toPos: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3; t: number } | null = null;
        let lastTime = performance.now();

        sceneStore.focusHandler = (obj) => {
            if (!ctx.camera || !ctx.controls) return;

            const box = new THREE.Box3().setFromObject(obj);
            const sphere = new THREE.Sphere();
            if (box.isEmpty()) obj.getWorldPosition(sphere.center);
            else box.getBoundingSphere(sphere);
            const radius = Math.max(sphere.radius, 0.5);

            const distance = (radius / Math.sin(THREE.MathUtils.degToRad(ctx.camera.fov / 2))) * 1.3;
            const direction = ctx.camera.getWorldDirection(new THREE.Vector3());
            flight = {
                fromPos: ctx.camera.position.clone(),
                toPos: sphere.center.clone().addScaledVector(direction, -distance),
                fromTarget: ctx.controls.target.clone(),
                toTarget: sphere.center.clone(),
                t: 0
            };
        };

        // =====================
        // RESIZE
        // =====================
        const resizeObserver = new ResizeObserver(() => {
            if (!ref.current || !ctx.camera || !ctx.renderer) return;
            const width = ref.current.clientWidth;
            const height = ref.current.clientHeight;
            ctx.camera.aspect = width / height;
            ctx.camera.updateProjectionMatrix();
            ctx.renderer.setSize(width, height);
        });

        resizeObserver.observe(ref.current);

        // =====================
        // STORE SUBSCRIPTION
        // =====================
        // The viewport draws through the look of the scene, with the same code as the game
        const pipeline = new RenderPipeline(ctx.renderer);
        const applyLook = () => {
            const name = sceneStore.lookEnabled ? sceneStore.environment.look : "";
            pipeline.setLook(name ? resolveLook(sceneStore.registry, name) : null, sceneStore.registry);
        };
        applyLook();

        // The input of the running game the canvas is attached to now, and how to detach it
        let gameInput: Input | null = null;
        let detachInput = () => {};

        // With several objects selected each one gets a box around it; the gizmo holds the main one
        const boxes = new THREE.Group();
        sceneStore.scene.add(boxes);
        let boxed = "";
        const updateBoxes = () => {
            const ids = sceneStore.selectedIds.length > 1 && !sceneStore.playing ? sceneStore.selectedIds : [];
            if (ids.join() === boxed) return;
            boxed = ids.join();
            for (const box of [...boxes.children] as THREE.BoxHelper[]) {
                boxes.remove(box);
                box.dispose();
            }
            for (const id of ids) {
                const object = sceneStore.objectOf(id);
                if (!object) continue;
                const box = new THREE.BoxHelper(object, id === sceneStore.selectedId ? 0xffffff : 0x4d9cff);
                box.layers.set(EDITOR_LAYER);
                box.raycast = () => {};
                boxes.add(box);
            }
        };

        const unsubscribe = sceneStore.subscribe(() => {
            ctx.transform?.setMode(sceneStore.gizmoMode);
            ctx.transform?.setSpace(sceneStore.gizmoSpace);
            // Snapping: whole steps instead of any value
            ctx.transform?.setTranslationSnap(sceneStore.snap ? sceneStore.snapStep : null);
            ctx.transform?.setRotationSnap(sceneStore.snap ? THREE.MathUtils.degToRad(15) : null);
            ctx.transform?.setScaleSnap(sceneStore.snap ? 0.25 : null);
            updateBoxes();
            applyLook();

            // Game view: the keyboard and the mouse go to the behaviors of the scene
            if (sceneStore.gameInput !== gameInput) {
                detachInput();
                gameInput = sceneStore.gameInput;
                detachInput = gameInput ? gameInput.attach(domElement) : () => {};
                // The Play button or a field of the Inspector must not keep the keys: Space would press the button
                if (gameInput) (document.activeElement as HTMLElement | null)?.blur?.();
            }

            // Sync selected object with transform gizmo
            // During Play the viewport draws the running copy of the scene, and the gizmo goes there with it
            if (gizmo.parent !== sceneStore.viewScene) sceneStore.viewScene.add(gizmo);
            // While a collider is being edited its handles are there instead of the gizmo
            const editingCollider = sceneStore.colliderEdit && sceneStore.hasCollider && !sceneStore.playing;
            const selected = sceneStore.gameView || editingCollider ? null : sceneStore.selectedViewObject;
            handles.update();
            // Looking through the camera of the scene: the editor camera stays where it was
            if (ctx.controls && !ctx.transform?.dragging) ctx.controls.enabled = !sceneStore.gameView;
            if (sceneStore.gameView) stopFlying();
            if (selected && ctx.transform) {
                ctx.transform.attach(selected);
            } else if (ctx.transform) {
                ctx.transform.detach();
            }
        });

        // =====================
        // ANIMATION LOOP
        // =====================
        const animate = () => {
            ctx.animationId = requestAnimationFrame(animate);

            const now = performance.now();
            const dt = (now - lastTime) / 1000;
            lastTime = now;

            fly(Math.min(dt, 0.1));
            // Play mode: runs the behaviors; a long pause (hidden tab) must not become one huge step
            sceneStore.tick(Math.min(dt, 0.1));

            if (flight && ctx.camera && ctx.controls) {
                flight.t = Math.min(1, flight.t + dt / FOCUS_TIME);
                const eased = 1 - (1 - flight.t) ** 3;
                ctx.camera.position.lerpVectors(flight.fromPos, flight.toPos, eased);
                ctx.controls.target.lerpVectors(flight.fromTarget, flight.toTarget, eased);
                if (flight.t >= 1) flight = null;
            }

            if (ctx.controls) ctx.controls.update();
            handles.frame();
            // The boxes follow what is being dragged
            for (const box of boxes.children as THREE.BoxHelper[]) box.update();
            if (ctx.renderer && ctx.camera) {
                const canvas = ctx.renderer.domElement;
                const camera = sceneStore.gameCamera(canvas.clientWidth, canvas.clientHeight) ?? ctx.camera;
                const { renderer } = ctx;
                const scene = sceneStore.viewScene;

                // The picture itself: the scene through its look. Editor tools are not a part of it: the grid
                // and the markers are on their own layer, the gizmo is hidden for a moment.
                const gizmoShown = gizmo.visible;
                gizmo.visible = false;
                camera.layers.set(0);
                pipeline.render(scene, camera, Math.min(dt, 0.1));

                renderer.autoClear = false;
                // The editor layer goes on top, sharp and at full size. The look may have drawn the scene into
                // a smaller picture, so its depth is drawn again here for the objects to hide what is behind them.
                if (scene === sceneStore.scene) {
                    const { background, overrideMaterial } = scene;
                    scene.background = null;
                    scene.overrideMaterial = depthOnly;
                    renderer.clearDepth();
                    renderer.render(scene, camera);
                    scene.overrideMaterial = overrideMaterial;

                    // Still without the background: three.js clears the canvas for a scene that has one
                    camera.layers.set(EDITOR_LAYER);
                    renderer.render(scene, camera);
                    camera.layers.set(0);
                    scene.background = background;
                }

                gizmo.visible = gizmoShown;
                if (gizmoShown) {
                    renderer.clearDepth();
                    renderer.render(gizmo, camera);
                }
                renderer.autoClear = true;

                // A camera is selected: its view in the corner, small, drawn as the game would draw it
                const preview = sceneStore.previewCamera;
                if (preview) {
                    const width = Math.round(canvas.clientWidth * PREVIEW_SIZE);
                    const height = Math.round(canvas.clientHeight * PREVIEW_SIZE);
                    const left = canvas.clientWidth - width - PREVIEW_MARGIN;
                    setCameraAspect(preview, width / height);
                    gizmo.visible = false;
                    // The y of a three.js viewport is counted from the bottom
                    renderer.setViewport(left, PREVIEW_MARGIN, width, height);
                    renderer.setScissor(left, PREVIEW_MARGIN, width, height);
                    renderer.setScissorTest(true);
                    pipeline.render(scene, preview);
                    renderer.setScissorTest(false);
                    renderer.setViewport(0, 0, canvas.clientWidth, canvas.clientHeight);
                    gizmo.visible = gizmoShown;
                }
            }
        };

        animate();

        // =====================
        // CLEANUP
        // =====================
        return () => {
            resizeObserver.disconnect();
            ctx.renderer?.domElement.removeEventListener("pointerdown", onPointerDown);
            ctx.renderer?.domElement.removeEventListener("pointerup", onPointerUp);
            unsubscribe();

            domElement.removeEventListener("pointerdown", onFlyDown);
            domElement.removeEventListener("pointermove", onFlyMove);
            domElement.removeEventListener("pointerup", onFlyUp);
            window.removeEventListener("keydown", onFlyKey);
            window.removeEventListener("keyup", onFlyKey);
            window.removeEventListener("blur", stopFlying);
            stopFlying();
            detachInput();
            pipeline.dispose();
            sceneStore.focusHandler = null;
            handles.dispose();
            boxes.removeFromParent();
            gizmo.removeFromParent();
            sceneStore.scene.remove(grid);
            grid.dispose();
            depthOnly.dispose();

            if (ctx.animationId) {
                cancelAnimationFrame(ctx.animationId);
            }

            ctx.controls?.dispose();
            ctx.transform?.dispose();
            ctx.renderer?.dispose();

            ctx.renderer?.domElement.remove();
        };
    }, []);

    const looks = store.registry.lookNames();

    return (
        <div
            className="viewport"
            // Assets dragged from the Project panel: a material goes onto the object under the cursor,
            // a model or a prefab becomes a new object
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
                const asset = getDraggedAsset(e);
                if (!asset) return;
                e.preventDefault();
                const entityId = pickRef.current(e.clientX, e.clientY);
                // A material, a texture or a behavior goes onto the object under the mouse; the rest becomes new objects
                dropAsset(asset, ["material", "texture", "behavior"].includes(asset.kind) ? entityId : null);
            }}
            // A right click opens the menu; holding the button to look around or fly must not
            onContextMenu={(e) => {
                e.preventDefault();
                if ((e.target as HTMLElement).tagName !== "CANVAS") return;
                if (downRef.current.moved || store.gameView) return;
                if (Math.hypot(e.clientX - downRef.current.x, e.clientY - downRef.current.y) > 4) return;

                const entityId = pickRef.current(e.clientX, e.clientY);
                const entity = entityId ? store.findEntity(entityId) : null;
                if (entity) store.select(entity.id);
                openContextMenu(e, entity ? entityContextMenu(entity) : sceneContextMenu());
            }}
        >
            <div ref={ref} style={{ width: "100%", height: "100%" }} />

            <div className="viewport-tools">
                {!store.gameView && GIZMO_MODES.map(({ mode, icon, title }) => (
                    <button
                        key={mode}
                        className={`btn ghost ${store.gizmoMode === mode ? "active" : ""}`}
                        title={title}
                        onClick={() => store.setGizmoMode(mode)}
                    >
                        <Icon name={icon} />
                    </button>
                ))}
                {!store.gameView && (
                    <>
                        <button
                            className="btn ghost"
                            title="The axes of the gizmo: World — along the axes of the scene, Local — turned with the object (X)"
                            onClick={() => store.setGizmoSpace(store.gizmoSpace === "world" ? "local" : "world")}
                        >
                            {store.gizmoSpace === "world" ? "World" : "Local"}
                        </button>
                        <button
                            className={`btn ghost ${store.snap ? "active" : ""}`}
                            title="Snap: the gizmo moves by whole steps, turns by 15° and scales by 0.25"
                            onClick={() => store.setSnap(!store.snap)}
                        >
                            <Icon name="snap" />
                        </button>
                        {store.snap && (
                            <select
                                className="select"
                                value={store.snapStep}
                                title="The step of a move, meters"
                                onChange={(e) => store.setSnap(true, Number(e.target.value))}
                            >
                                {[0.1, 0.25, 0.5, 1, 2].map((step) => (
                                    <option key={step} value={step}>{step} m</option>
                                ))}
                            </select>
                        )}
                    </>
                )}
                {!store.playing && store.hasCollider && (
                    <button
                        className={`btn ghost ${store.colliderEdit ? "active" : ""}`}
                        title="Edit Collider: drag the dots on its sides to resize it, the square in the middle to move it"
                        onClick={() => store.setColliderEdit(!store.colliderEdit)}
                    >
                        <Icon name="collider" />
                    </button>
                )}
                {looks.length > 0 && !store.editingPrefab && (
                    <>
                        {!store.gameView && <span className="sep" />}
                        <select
                            className="select"
                            value={store.environment.look}
                            title="The look of this scene: its render style (pixels, outlines, palette…). Looks are made in the Project panel, Looks tab"
                            onChange={(e) => store.setEnvironment("look", e.target.value)}
                        >
                            <option value="">Standard (no effects)</option>
                            {/* A look the scene names but the project no longer has stays visible */}
                            {(looks.includes(store.environment.look) || !store.environment.look ? looks : [...looks, store.environment.look]).map((name) => (
                                <option key={name} value={name}>{name}</option>
                            ))}
                        </select>
                        {store.environment.look && (
                            <button
                                className={`btn ghost ${store.lookEnabled ? "active" : ""}`}
                                title="Show the look in the viewport; off draws the plain scene, easier to arrange. The game always has its look"
                                onClick={() => store.setLookEnabled(!store.lookEnabled)}
                            >
                                <Icon name="look" />
                            </button>
                        )}
                    </>
                )}
                {store.playing && (
                    <>
                        {(!store.gameView || looks.length > 0) && <span className="sep" />}
                        <button
                            className={`btn ghost ${store.playCamera === "game" && store.hasGameCamera ? "" : "active"}`}
                            title="Scene view: the editor camera; select and move objects while the scene runs"
                            onClick={() => store.setPlayCamera("editor")}
                        >
                            Scene
                        </button>
                        <button
                            className={`btn ghost ${store.playCamera === "game" && store.hasGameCamera ? "active" : ""}`}
                            title={store.hasGameCamera
                                ? "Game view: the camera of the scene, keys and mouse go to the game. On pause the viewport is the editor"
                                    + " until the game resumes"
                                : "The scene has no active object with a Camera component"}
                            disabled={!store.hasGameCamera}
                            onClick={() => store.setPlayCamera("game")}
                        >
                            <Icon name="camera" /> Game
                        </button>
                    </>
                )}
            </div>

            {(store.editingPrefab || store.playing) && (
                <div className={`viewport-badge ${store.playing ? "playing" : ""}`}>
                    {store.paused ? "Paused" : store.playing ? "Playing" : `Editing prefab: ${store.editingPrefab}`}
                </div>
            )}

            {store.previewCamera && (
                <div className="viewport-preview">
                    <span>{store.selected?.name}</span>
                </div>
            )}
            <div className="viewport-hint">
                {store.gameView
                    ? "Game view: the camera of the scene, keys and mouse go to the game · " +
                        "switch to Scene to look around, select and move objects"
                    : "Click — select · drag — orbit · hold right button — look around, W A S D fly, Q E down/up, Shift faster · " +
                        "middle-drag — pan · wheel — zoom · right-click — menu"}
            </div>
        </div>
    );
}