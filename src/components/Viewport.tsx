import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { anchorPoint, applyEnvironment, aspectRatio, createRenderer, withZone, zoneAt, RenderPipeline, resolveLook, setCameraAspect, UI_HANDLE, UI_HANDLES, UiLayer, uiOf, updateParticles } from "../engine";
import type { Input } from "../engine";
import { dropAsset, getDraggedAsset } from "../editor/core/dnd";
import { ColliderHandles } from "./colliderHandles";
import { entitiesInRect } from "./marquee";
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
    // The frame of a selection being dragged out with Shift
    const marqueeRef = useRef<HTMLDivElement>(null);
    // The frame of the picture of the game, shown while the interface is edited
    const frameRef = useRef<HTMLDivElement>(null);

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
            // The press was on an element of the interface: it is selected already
            if (uiPressed) {
                uiPressed = false;
                return;
            }
            if (endMarquee(e)) return;
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

        // =====================
        // INTERFACE (drag an element)
        // =====================
        // While the interface of the scene is shown over the viewport, a press on one of its elements selects
        // it, and dragging moves it: its x and y, in the units of the interface. The selected element has
        // handles at its corners and sides: dragging one moves that side, the opposite one stays.
        let uiPressed = false;
        let uiDrag: {
            id: string;
            pointerId: number;
            downX: number;
            downY: number;
            x: number;
            y: number;
            // Pixels of the screen per unit of the interface
            scale: number;
            // A size handle is dragged: which sides it moves, what the size was, where the anchor is
            side?: { h: number; v: number; width: number; height: number; ax: number; ay: number };
            // Where the element was, in the units of its canvas, and how high that canvas is
            box: { left: number; top: number; width: number; height: number; units: number } | null;
            // The other selected elements, which move along with it, with where each one was
            others: { id: string; x: number; y: number }[];
            // What its sides and its middle can line up with: those of its parent and of the other elements
            linesX: number[];
            linesY: number[];
            // It stands in a Layout, which gives it its place: dragging changes its turn among its neighbors
            layout: "row" | "column" | null;
        } | null = null;

        // The id of an entity object, whether the scene has it or a prefab brings it
        const idOf = (object: THREE.Object3D | null | undefined): string | undefined => object?.userData.entityId ?? object?.userData.innerId;

        // How near (pixels of the screen) a side has to come to a line to jump onto it
        const SNAP_REACH = 6;

        const uiPlace = (id: string) => sceneStore.findEntity(id)?.components.find((component) => component.type === "ui");

        // The size handle of the selected element under the mouse, if there is one
        // Where the interface is drawn while the scene is edited: the part of the view that has the shape of
        // the picture of the game, in the pixels of the window
        const uiRect = () => {
            const rect = canvas.getBoundingClientRect();
            const area = sceneStore.gameArea(rect.width, rect.height);
            return { left: rect.left + area.left, top: rect.top + area.top, width: area.width, height: area.height };
        };

        const uiHandleAt = (e: PointerEvent, rect: { left: number; top: number; height: number }) => {
            const id = sceneStore.selectedId;
            const object = id ? sceneStore.objectOf(id) : null;
            const box = object && editorUi.placeOf(object);
            const place = id && uiPlace(id);
            if (!id || !box || !place) return null;
            const scale = rect.height / box.units;
            const reach = Math.max(7, (UI_HANDLE * scale) / 2 + 2);
            for (const handle of UI_HANDLES) {
                const hx = rect.left + (box.left + ((handle.h + 1) / 2) * box.width) * scale;
                const hy = rect.top + (box.top + ((handle.v + 1) / 2) * box.height) * scale;
                if (Math.abs(e.clientX - hx) > reach || Math.abs(e.clientY - hy) > reach) continue;
                const [ax, ay] = anchorPoint((place.anchor as string | undefined) ?? "center");
                // A size of 0 is "as the parent": the drag starts from what that comes to
                return { id, place, scale, side: { ...handle, width: box.width, height: box.height, ax, ay } };
            }
            return null;
        };

        // In the capture phase, to turn the orbiting off before OrbitControls gets the press
        const onUiDown = (e: PointerEvent) => {
            uiPressed = false;
            if (e.button !== 0 || e.shiftKey || sceneStore.playing || !sceneStore.uiVisible || !ctx.controls) return;
            if (ctx.transform?.axis || handles.grabbed) return;
            const rect = uiRect();
            // A handle first: it sticks out of its element, and may lie over another one
            const grabbed = uiHandleAt(e, rect);
            const object = grabbed ? null : editorUi.elementAt(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
            const id: string | undefined = grabbed?.id ?? object?.userData.entityId ?? object?.userData.innerId;
            const place = grabbed?.place ?? (id && uiPlace(id));
            // Pixels of the screen per unit of the canvas the element is in
            const units = object && editorUi.placeOf(object)?.units;
            const scale = grabbed?.scale ?? (units ? rect.height / units : 0);
            if (!id || !place || scale <= 0) return;

            uiPressed = true;
            const adding = !grabbed && (e.ctrlKey || e.metaKey);
            if (adding || !sceneStore.selectedIds.includes(id)) sceneStore.select(id, adding);
            if (adding) return;
            const dragged = sceneStore.objectOf(id);
            const box = dragged ? editorUi.placeOf(dragged) : null;
            // Everything that moves with the element: the other selected ones, and what is inside any of them
            const moving = new Set<THREE.Object3D>();
            const others: { id: string; x: number; y: number }[] = [];
            for (const selectedId of sceneStore.selectedIds) {
                const object = sceneStore.objectOf(selectedId);
                object?.traverse((inner) => moving.add(inner));
                const other = selectedId !== id && uiPlace(selectedId);
                if (other) others.push({ id: selectedId, x: (other.x as number | undefined) ?? 0, y: (other.y as number | undefined) ?? 0 });
            }
            const linesX: number[] = [];
            const linesY: number[] = [];
            if (box) {
                // The edges and the middle of the screen, and of every element that stays where it is
                const still = [{ left: 0, top: 0, width: (box.units * rect.width) / rect.height, height: box.units }, ...editorUi.places().filter((p) => !moving.has(p.object) && p.units === box.units)];
                for (const p of still) {
                    linesX.push(p.left, p.left + p.width / 2, p.left + p.width);
                    linesY.push(p.top, p.top + p.height / 2, p.top + p.height);
                }
            }
            const around = dragged?.parent ? uiOf(dragged.parent)?.layout : undefined;
            uiDrag = {
                id,
                pointerId: e.pointerId,
                downX: e.clientX,
                downY: e.clientY,
                x: (place.x as number | undefined) ?? 0,
                y: (place.y as number | undefined) ?? 0,
                scale,
                side: grabbed?.side,
                box,
                others,
                linesX,
                linesY,
                layout: around ? (around.direction === "row" ? "row" : "column") : null,
            };
            ctx.controls.enabled = false;
            canvas.setPointerCapture(e.pointerId);
        };

        const onUiMove = (e: PointerEvent) => {
            if (!uiDrag) return;
            const dx = e.clientX - uiDrag.downX;
            const dy = e.clientY - uiDrag.downY;
            if (Math.hypot(dx, dy) <= CLICK_THRESHOLD) return;
            const drag = uiDrag;
            const { side } = drag;
            if (!side && drag.layout) {
                // In a Layout the place is the turn: the element goes before or after the neighbor whose
                // middle the mouse has passed
                const object = sceneStore.objectOf(drag.id);
                const rect = uiRect();
                const row = drag.layout === "row";
                const at = ((row ? e.clientX - rect.left : e.clientY - rect.top) / drag.scale);
                const siblings = (object?.parent?.children ?? []).filter((child) => child.userData.component === undefined && uiOf(child));
                const index = object ? siblings.indexOf(object) : -1;
                const middle = (other: THREE.Object3D | undefined) => {
                    const p = other && editorUi.placeOf(other);
                    return p ? (row ? p.left + p.width / 2 : p.top + p.height / 2) : null;
                };
                const before = middle(siblings[index - 1]);
                const after = middle(siblings[index + 1]);
                const beforeId = idOf(siblings[index - 1]);
                const afterId = idOf(siblings[index + 1]);
                if (before !== null && beforeId && at < before) sceneStore.moveBeside(drag.id, beforeId, false);
                else if (after !== null && afterId && at > after) sceneStore.moveBeside(drag.id, afterId, true);
                return;
            }
            // Whole units: easier to line things up, and to read in the file
            sceneStore.batch(() => {
                if (!side) {
                    let moveX = dx / drag.scale;
                    let moveY = dy / drag.scale;
                    editorUi.guides = [];
                    // Its sides and its middle jump onto the lines that are near; Alt lets it move freely
                    if (drag.box && !e.altKey) {
                        const { box } = drag;
                        const reach = SNAP_REACH / drag.scale;
                        const nearest = (lines: number[], points: number[]) => {
                            let best: { shift: number; line: number } | null = null;
                            for (const point of points) {
                                for (const line of lines) {
                                    if (Math.abs(line - point) <= reach && (!best || Math.abs(line - point) < Math.abs(best.shift))) best = { shift: line - point, line };
                                }
                            }
                            return best;
                        };
                        const snapX = nearest(drag.linesX, [box.left + moveX, box.left + box.width / 2 + moveX, box.left + box.width + moveX]);
                        const snapY = nearest(drag.linesY, [box.top + moveY, box.top + box.height / 2 + moveY, box.top + box.height + moveY]);
                        if (snapX) {
                            moveX += snapX.shift;
                            editorUi.guides.push({ vertical: true, at: snapX.line, units: box.units });
                        }
                        if (snapY) {
                            moveY += snapY.shift;
                            editorUi.guides.push({ vertical: false, at: snapY.line, units: box.units });
                        }
                    }
                    sceneStore.setComponentField(drag.id, "ui", "x", Math.round(drag.x + moveX));
                    sceneStore.setComponentField(drag.id, "ui", "y", Math.round(drag.y + moveY));
                    // The other selected elements go the same way
                    for (const other of drag.others) {
                        sceneStore.setComponentField(other.id, "ui", "x", Math.round(other.x + moveX));
                        sceneStore.setComponentField(other.id, "ui", "y", Math.round(other.y + moveY));
                    }
                    return;
                }
                // The side under the handle follows the mouse and the opposite one stays. The place of an
                // element is counted from its anchor, so its x (y) changes with its size, by as much as the
                // anchor is away from the side that stays.
                if (side.h !== 0) {
                    const width = Math.max(1, Math.round(side.width + (side.h * dx) / drag.scale));
                    const grown = width - side.width;
                    sceneStore.setComponentField(drag.id, "ui", "width", width);
                    // In a Layout the place is not its own
                    if (!drag.layout) sceneStore.setComponentField(drag.id, "ui", "x", drag.x + grown * (side.h > 0 ? side.ax : side.ax - 1));
                }
                if (side.v !== 0) {
                    const height = Math.max(1, Math.round(side.height + (side.v * dy) / drag.scale));
                    const grown = height - side.height;
                    sceneStore.setComponentField(drag.id, "ui", "height", height);
                    if (!drag.layout) sceneStore.setComponentField(drag.id, "ui", "y", drag.y + grown * (side.v > 0 ? side.ay : side.ay - 1));
                }
            });
        };

        const onUiUp = () => {
            if (!uiDrag) return;
            if (canvas.hasPointerCapture(uiDrag.pointerId)) canvas.releasePointerCapture(uiDrag.pointerId);
            uiDrag = null;
            editorUi.guides = [];
            if (ctx.controls) ctx.controls.enabled = !sceneStore.gameView;
        };

        // =====================
        // MARQUEE (Shift + drag)
        // =====================
        // Selects everything the frame touches; with Ctrl adds it to what is selected
        let marquee: { x: number; y: number; pointerId: number } | null = null;

        const marqueeRect = (e: PointerEvent) => {
            const rect = canvas.getBoundingClientRect();
            const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
            const x0 = clamp(marquee!.x - rect.left, rect.width);
            const y0 = clamp(marquee!.y - rect.top, rect.height);
            const x1 = clamp(e.clientX - rect.left, rect.width);
            const y1 = clamp(e.clientY - rect.top, rect.height);
            return { left: Math.min(x0, x1), top: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0), rect };
        };

        // In the capture phase, to turn the orbiting off before OrbitControls gets the press
        const onMarqueeDown = (e: PointerEvent) => {
            if (e.button !== 0 || !e.shiftKey || sceneStore.gameView) return;
            if (ctx.transform?.axis || handles.grabbed || !ctx.controls) return;
            marquee = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
            ctx.controls.enabled = false;
            canvas.setPointerCapture(e.pointerId);
        };

        const onMarqueeMove = (e: PointerEvent) => {
            const frame = marqueeRef.current;
            if (!marquee || !frame) return;
            if (Math.hypot(e.clientX - marquee.x, e.clientY - marquee.y) <= CLICK_THRESHOLD) return;
            const { left, top, width, height } = marqueeRect(e);
            frame.style.display = "block";
            frame.style.left = `${left}px`;
            frame.style.top = `${top}px`;
            frame.style.width = `${width}px`;
            frame.style.height = `${height}px`;
        };

        // Ends the drag; true if it was a frame and not a click
        const endMarquee = (e: PointerEvent, cancel = false) => {
            if (!marquee) return false;
            const dragged = Math.hypot(e.clientX - marquee.x, e.clientY - marquee.y) > CLICK_THRESHOLD;
            const { left, top, width, height, rect } = marqueeRect(e);
            if (canvas.hasPointerCapture(marquee.pointerId)) canvas.releasePointerCapture(marquee.pointerId);
            marquee = null;
            if (marqueeRef.current) marqueeRef.current.style.display = "none";
            if (ctx.controls) ctx.controls.enabled = !sceneStore.gameView;
            if (!dragged || cancel || !ctx.camera) return dragged;

            const ids = entitiesInRect(sceneStore.viewRoot, ctx.camera, {
                minX: (left / rect.width) * 2 - 1,
                maxX: ((left + width) / rect.width) * 2 - 1,
                minY: -((top + height) / rect.height) * 2 + 1,
                maxY: -(top / rect.height) * 2 + 1
            });
            const kept = e.ctrlKey || e.metaKey ? sceneStore.selectedIds.filter((id) => !ids.includes(id)) : [];
            sceneStore.selectMany([...kept, ...ids]);
            return true;
        };

        const onMarqueeCancel = (e: PointerEvent) => {
            endMarquee(e, true);
        };

        const canvas = ctx.renderer.domElement;
        canvas.addEventListener("pointerdown", onUiDown, true);
        canvas.addEventListener("pointermove", onUiMove);
        canvas.addEventListener("pointerup", onUiUp, true);
        canvas.addEventListener("pointercancel", onUiUp);
        canvas.addEventListener("pointerdown", onMarqueeDown, true);
        canvas.addEventListener("pointermove", onMarqueeMove);
        canvas.addEventListener("pointercancel", onMarqueeCancel);
        canvas.addEventListener("pointerdown", onPointerDown);
        canvas.addEventListener("pointerup", onPointerUp);

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
        // The look that is shown, and the zone the editor camera is in (as a string of its fields): the
        // viewport shows the scene the way a camera at this place would see it in the game
        let shownLook = "";
        let shownZone = "";
        const applyLook = () => {
            const zone = !sceneStore.playing && ctx.camera ? zoneAt(sceneStore.root, ctx.camera.position) : null;
            shownLook = sceneStore.gameLook ?? (zone?.look || sceneStore.environment.look);
            const name = sceneStore.lookEnabled ? shownLook : "";
            pipeline.setLook(name ? resolveLook(sceneStore.registry, name) : null, sceneStore.registry);
        };
        applyLook();

        // The interface of the scene being edited, shown over it; a running game has its own
        const editorUi = new UiLayer(sceneStore.registry, sceneStore.root);

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
            // The store may have put the environment of the scene back: the zone is looked at again
            shownZone = "?";

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
            // An element of the interface has no place in the world: it is moved by dragging it, not by the gizmo
            const flat = sceneStore.selected?.components.some((component) => component.type === "ui" || component.type === "canvas") ?? false;
            const selected = sceneStore.gameView || editingCollider || flat ? null : sceneStore.selectedViewObject;
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
            // The game moves its own particles; those of the scene being edited are moved here
            if (!sceneStore.playing) updateParticles(sceneStore.root, Math.min(dt, 0.1));

            if (flight && ctx.camera && ctx.controls) {
                flight.t = Math.min(1, flight.t + dt / FOCUS_TIME);
                const eased = 1 - (1 - flight.t) ** 3;
                ctx.camera.position.lerpVectors(flight.fromPos, flight.toPos, eased);
                ctx.controls.target.lerpVectors(flight.fromTarget, flight.toTarget, eased);
                if (flight.t >= 1) flight = null;
            }

            if (ctx.controls) ctx.controls.update();
            if (sceneStore.playing) {
                // A zone the camera of the game has entered may bring its own look
                if (sceneStore.gameLook !== shownLook) applyLook();
            } else if (ctx.camera) {
                // While the scene is edited the editor camera is what walks into the zones
                sceneStore.root.updateMatrixWorld();
                const zone = zoneAt(sceneStore.root, ctx.camera.position);
                const key = zone ? JSON.stringify(zone) : "";
                if (key !== shownZone) {
                    shownZone = key;
                    applyEnvironment(sceneStore.scene, withZone(sceneStore.environment, zone));
                    applyLook();
                }
            }
            handles.frame();
            // The boxes follow what is being dragged
            for (const box of boxes.children as THREE.BoxHelper[]) box.update();
            if (ctx.renderer && ctx.camera) {
                const canvas = ctx.renderer.domElement;
                // In the Game view the picture has the shape the project gives it, the rest of the view is black
                const area = sceneStore.gameView ? sceneStore.gameArea(canvas.clientWidth, canvas.clientHeight) : null;
                const framed = area !== null && (area.width !== canvas.clientWidth || area.height !== canvas.clientHeight);
                const camera = sceneStore.gameCamera(area?.width ?? canvas.clientWidth, area?.height ?? canvas.clientHeight) ?? ctx.camera;
                const { renderer } = ctx;
                const scene = sceneStore.viewScene;
                // The mouse of the game is counted over the picture, not over the whole view
                if (gameInput) gameInput.area = framed ? area : null;

                // The picture itself: the scene through its look. Editor tools are not a part of it: the grid
                // and the markers are on their own layer, the gizmo is hidden for a moment.
                const gizmoShown = gizmo.visible;
                gizmo.visible = false;
                camera.layers.set(0);
                if (framed) {
                    renderer.setScissorTest(false);
                    renderer.setClearColor(0x000000);
                    renderer.clear();
                    // The y of a three.js viewport is counted from the bottom
                    const bottom = canvas.clientHeight - area.top - area.height;
                    renderer.setViewport(area.left, bottom, area.width, area.height);
                    renderer.setScissor(area.left, bottom, area.width, area.height);
                    renderer.setScissorTest(true);
                }
                // The interface: of the running game in its Game view, of the scene while it is edited
                let ui: UiLayer | null = null;
                if (sceneStore.playing) {
                    if (sceneStore.gameView) ui = sceneStore.gameUi;
                } else if (sceneStore.uiVisible) {
                    editorUi.registry = sceneStore.registry;
                    editorUi.root = sceneStore.root;
                    // The size handles are on the main selected element
                    editorUi.handles = sceneStore.selectedId ? sceneStore.objectOf(sceneStore.selectedId) ?? null : null;
                    editorUi.highlight.clear();
                    for (const id of sceneStore.selectedIds) {
                        const object = sceneStore.objectOf(id);
                        if (object) editorUi.highlight.add(object);
                    }
                    ui = editorUi;
                }
                // While the scene is edited the view is the editor's, but the interface keeps the shape of the
                // picture of the game: it is drawn into that part of the view, with a frame around it
                const shape = ui === editorUi ? sceneStore.gameArea(canvas.clientWidth, canvas.clientHeight) : null;
                const shaped = shape !== null && (shape.width !== canvas.clientWidth || shape.height !== canvas.clientHeight);
                pipeline.render(scene, camera, Math.min(dt, 0.1), shaped ? null : ui);
                if (shaped) {
                    const bottom = canvas.clientHeight - shape.top - shape.height;
                    renderer.setViewport(shape.left, bottom, shape.width, shape.height);
                    renderer.setScissor(shape.left, bottom, shape.width, shape.height);
                    renderer.setScissorTest(true);
                    pipeline.drawUi(editorUi);
                }
                if (framed || shaped) {
                    renderer.setScissorTest(false);
                    renderer.setViewport(0, 0, canvas.clientWidth, canvas.clientHeight);
                }
                const frame = frameRef.current;
                const framePlace = shaped ? `${shape.left},${shape.top},${shape.width},${shape.height}` : "";
                if (frame && frame.dataset.place !== framePlace) {
                    frame.dataset.place = framePlace;
                    Object.assign(frame.style, shaped
                        ? { display: "block", left: `${shape.left}px`, top: `${shape.top}px`, width: `${shape.width}px`, height: `${shape.height}px` }
                        : { display: "none" });
                }

                // What the behaviors have put over the picture with HTML (self.overlay): seen in the Game view
                const game = sceneStore.runningGame;
                if (game?.overlay) {
                    if (game.overlay.parentElement !== canvas.parentElement) canvas.after(game.overlay);
                    game.overlay.style.display = area ? "" : "none";
                    if (area) game.placeOverlay(area.left, area.top, area.width, area.height);
                }

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
                    // The shape of the picture of the game, if the project gives it one
                    const shaped = sceneStore.gameArea(width, 100000);
                    const height = shaped.height < 100000 ? shaped.height : Math.round(canvas.clientHeight * PREVIEW_SIZE);
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

            domElement.removeEventListener("pointerdown", onMarqueeDown, true);
            domElement.removeEventListener("pointermove", onMarqueeMove);
            domElement.removeEventListener("pointercancel", onMarqueeCancel);
            domElement.removeEventListener("pointerdown", onFlyDown);
            domElement.removeEventListener("pointermove", onFlyMove);
            domElement.removeEventListener("pointerup", onFlyUp);
            window.removeEventListener("keydown", onFlyKey);
            window.removeEventListener("keyup", onFlyKey);
            window.removeEventListener("blur", stopFlying);
            stopFlying();
            detachInput();
            pipeline.dispose();
            editorUi.dispose();
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
                // A material, a texture, a sound or a behavior goes onto the object under the mouse; the rest becomes new objects
                dropAsset(asset, ["material", "texture", "sound", "behavior"].includes(asset.kind) ? entityId : null);
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
            <div ref={marqueeRef} className="viewport-marquee" />
            <div ref={frameRef} className="viewport-frame" />

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
                {!store.playing && (
                    <button
                        className={`btn ghost ${store.uiVisible ? "active" : ""}`}
                        title="Show the interface of the game (the UI elements of the scene) over the viewport"
                        onClick={() => store.setUiVisible(!store.uiVisible)}
                    >
                        UI
                    </button>
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
                    {store.playScene && ` · scene ${store.playScene}`}
                </div>
            )}

            {store.previewCamera && (
                // With a shape given to the picture of the game the frame has that shape too
                <div
                    className="viewport-preview"
                    style={aspectRatio(store.registry.settings) ? { height: "auto", aspectRatio: String(aspectRatio(store.registry.settings)) } : undefined}
                >
                    <span>{store.selected?.name}</span>
                </div>
            )}
            <div className="viewport-hint">
                {store.gameView
                    ? "Game view: the camera of the scene, keys and mouse go to the game · " +
                        "switch to Scene to look around, select and move objects"
                    : "Click — select · drag — orbit · Shift-drag — frame ·hold right button — look around, W A S D fly, Q E down/up, Shift faster · " +
                        "middle-drag — pan · wheel — zoom · right-click — menu"}
            </div>
        </div>
    );
}