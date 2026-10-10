import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { dropAsset, getDraggedAsset } from "../editor/core/dnd";
import { sceneStore } from "../editor/core/SceneStore";
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

        ctx.renderer = new THREE.WebGLRenderer({ antialias: true });
        ctx.renderer.setSize(width, height);
        ctx.renderer.shadowMap.enabled = true;
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

        // The ground grid: 1 cell = 1 meter
        const grid = new THREE.GridHelper(40, 40, 0x5a5d66, 0x3a3c43);
        // Just below the ground, so a floor at y = 0 covers it instead of flickering with it
        grid.position.y = -0.002;
        sceneStore.scene.add(grid);

        ctx.raycaster = new THREE.Raycaster();
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
            if (e.button !== 0 || downOnGizmo) return;
            if (Math.hypot(e.clientX - downX, e.clientY - downY) > CLICK_THRESHOLD) return;

            sceneStore.select(pickRef.current(e.clientX, e.clientY));
        };

        pickRef.current = (clientX, clientY) => {
            if (!ctx.renderer || !ctx.raycaster || !ctx.mouse || !ctx.camera) return null;

            const rect = ctx.renderer.domElement.getBoundingClientRect();
            ctx.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
            ctx.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

            ctx.raycaster.setFromCamera(ctx.mouse, ctx.camera);

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
            if (e.button !== 2) return;
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
        const unsubscribe = sceneStore.subscribe(() => {
            ctx.transform?.setMode(sceneStore.gizmoMode);

            // Sync selected object with transform gizmo
            // During Play the viewport draws the running copy of the scene, and the gizmo goes there with it
            if (gizmo.parent !== sceneStore.viewScene) sceneStore.viewScene.add(gizmo);
            const selected = sceneStore.selectedViewObject;
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
            if (ctx.renderer && ctx.camera) {
                ctx.renderer.render(sceneStore.viewScene, ctx.camera);
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
            sceneStore.focusHandler = null;
            gizmo.removeFromParent();
            sceneStore.scene.remove(grid);
            grid.dispose();

            if (ctx.animationId) {
                cancelAnimationFrame(ctx.animationId);
            }

            ctx.controls?.dispose();
            ctx.transform?.dispose();
            ctx.renderer?.dispose();

            ctx.renderer?.domElement.remove();
        };
    }, []);

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
                dropAsset(asset, asset.kind === "material" ? entityId : null);
            }}
            // A right click opens the menu; holding the button to look around or fly must not
            onContextMenu={(e) => {
                e.preventDefault();
                if ((e.target as HTMLElement).tagName !== "CANVAS") return;
                if (downRef.current.moved) return;
                if (Math.hypot(e.clientX - downRef.current.x, e.clientY - downRef.current.y) > 4) return;

                const entityId = pickRef.current(e.clientX, e.clientY);
                const entity = entityId ? store.findEntity(entityId) : null;
                if (entity) store.select(entity.id);
                openContextMenu(e, entity ? entityContextMenu(entity) : sceneContextMenu());
            }}
        >
            <div ref={ref} style={{ width: "100%", height: "100%" }} />

            <div className="viewport-tools">
                {GIZMO_MODES.map(({ mode, icon, title }) => (
                    <button
                        key={mode}
                        className={`btn ghost ${store.gizmoMode === mode ? "active" : ""}`}
                        title={title}
                        onClick={() => store.setGizmoMode(mode)}
                    >
                        <Icon name={icon} />
                    </button>
                ))}
            </div>

            {(store.editingPrefab || store.playing) && (
                <div className={`viewport-badge ${store.playing ? "playing" : ""}`}>
                    {store.playing ? "Playing" : `Editing prefab: ${store.editingPrefab}`}
                </div>
            )}

            <div className="viewport-hint">
                Click — select · drag — orbit · hold right button — look around, W A S D fly, Q E down/up, Shift faster ·
                middle-drag — pan · wheel — zoom · right-click — menu
            </div>
        </div>
    );
}