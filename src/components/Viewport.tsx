import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { sceneStore } from "../editor/core/SceneStore";

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
        ref.current.appendChild(ctx.renderer.domElement);

        // =====================
        // LIGHTS
        // =====================
        const ambient = new THREE.AmbientLight(0xffffff, 2);
        sceneStore.scene.add(ambient);

        const dir = new THREE.DirectionalLight(0xffffff, 3);
        dir.position.set(5, 5, 5);
        sceneStore.scene.add(dir);

        // =====================
        // CONTROLS
        // =====================
        ctx.controls = new OrbitControls(ctx.camera, ctx.renderer.domElement);
        ctx.controls.enableDamping = true;

        ctx.transform = new TransformControls(ctx.camera, ctx.renderer.domElement);
        ctx.transform.addEventListener("dragging-changed", (e) => {
            if (ctx.controls) ctx.controls.enabled = !e.value;
        });
        // Keep the Inspector in sync while dragging the gizmo
        ctx.transform.addEventListener("objectChange", () => sceneStore.updateObject());

        // TransformControls is not an Object3D, its gizmo has to be added separately
        const gizmo = ctx.transform.getHelper();
        sceneStore.scene.add(gizmo);

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
            downOnGizmo = !!ctx.transform?.axis;
        };

        const onPointerUp = (e: PointerEvent) => {
            if (!ctx.renderer || !ctx.raycaster || !ctx.mouse || !ctx.camera) return;
            if (e.button !== 0 || downOnGizmo) return;
            if (Math.hypot(e.clientX - downX, e.clientY - downY) > CLICK_THRESHOLD) return;

            const rect = ctx.renderer.domElement.getBoundingClientRect();
            ctx.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            ctx.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

            ctx.raycaster.setFromCamera(ctx.mouse, ctx.camera);

            const hits = ctx.raycaster.intersectObjects(sceneStore.objects, true);

            if (hits.length > 0) {
                const obj = hits[0].object;
                sceneStore.select(obj);
                ctx.transform?.attach(obj);
            } else {
                sceneStore.select(null);
                ctx.transform?.detach();
            }
        };

        ctx.renderer.domElement.addEventListener("pointerdown", onPointerDown);
        ctx.renderer.domElement.addEventListener("pointerup", onPointerUp);

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
            // Sync selected object with transform gizmo
            if (sceneStore.selected && ctx.transform) {
                ctx.transform.attach(sceneStore.selected);
            } else if (ctx.transform) {
                ctx.transform.detach();
            }
        });

        // =====================
        // ANIMATION LOOP
        // =====================
        const animate = () => {
            ctx.animationId = requestAnimationFrame(animate);

            if (ctx.controls) ctx.controls.update();
            if (ctx.renderer && ctx.camera) {
                ctx.renderer.render(sceneStore.scene, ctx.camera);
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

            sceneStore.scene.remove(ambient, dir, gizmo);

            if (ctx.animationId) {
                cancelAnimationFrame(ctx.animationId);
            }

            ctx.controls?.dispose();
            ctx.transform?.dispose();
            ctx.renderer?.dispose();

            ctx.renderer?.domElement.remove();
        };
    }, []);

    return <div ref={ref} style={{ flex: 1, width: 0, overflow: "hidden" }} />;
}