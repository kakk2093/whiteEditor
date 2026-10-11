import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { componentDefs, paramDefaults } from "../engine";
import type { Params } from "../engine";
import { EDITOR_LAYER, getComponent, sceneStore } from "../editor/core/SceneStore";

// The handles of "Edit Collider": small dots on the collider of the selected object. Dragging one on a side
// moves that side (the opposite one stays); the square in the middle moves the whole collider. They write
// the fields of the Collider component, so everything they do is in the Inspector and in undo.

type Kind = "size" | "radius" | "height" | "center";

interface Handle {
    mesh: THREE.Mesh;
    kind: Kind;
    axis: 0 | 1 | 2;
    sign: 1 | -1;
}

const AXES = ["X", "Y", "Z"] as const;

// Size of a handle as a part of its distance from the camera: the same on the screen wherever it is
const HANDLE_SIZE = 0.012;

const round = (value: number) => Math.round(value * 1000) / 1000;

export class ColliderHandles {
    // Lives in the scene of the editor, on the layer of its tools
    readonly group = new THREE.Group();

    // true from a press on a handle until the next press: that click must not select something else
    grabbed = false;

    private handles: Handle[] = [];

    private dot = new THREE.SphereGeometry(1, 12, 8);

    private square = new THREE.BoxGeometry(1.6, 1.6, 1.6);

    // Drawn over everything: a handle inside the object must stay reachable
    private material = new THREE.MeshBasicMaterial({ color: 0x66dd88, depthTest: false, transparent: true, fog: false });

    private activeMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, fog: false });

    private raycaster = new THREE.Raycaster();

    private camera: THREE.Camera;

    private dom: HTMLElement;

    private controls: OrbitControls;

    // The drag in progress: which handle, and what the collider was when it began
    private drag: {
        handle: Pick<Handle, "kind" | "axis" | "sign">;
        id: string;
        start: Params;
        // For a side: the line the handle slides along, and how long one unit of the object is on it
        origin: THREE.Vector3;
        direction: THREE.Vector3;
        scale: number;
        // For the middle: the plane it slides in, facing the camera
        plane: THREE.Plane;
    } | null = null;

    constructor(camera: THREE.Camera, dom: HTMLElement, controls: OrbitControls) {
        this.camera = camera;
        this.dom = dom;
        this.controls = controls;
        this.raycaster.layers.set(EDITOR_LAYER);
        this.group.renderOrder = 1000;
        // Before the camera controls hear of the press: a press on a handle must not turn the camera
        dom.addEventListener("pointerdown", this.onDown, true);
        dom.addEventListener("pointermove", this.onMove);
        dom.addEventListener("pointerup", this.onUp);
        dom.addEventListener("pointercancel", this.onUp);
    }

    // The collider being edited: the fields with their defaults filled in, and the object it sits in
    private target() {
        if (!sceneStore.colliderEdit || sceneStore.playing) return null;
        const entity = sceneStore.selected;
        const object = sceneStore.selectedObject;
        const collider = entity && getComponent(sceneStore.expand(entity) ?? entity, "collider");
        if (!entity || !object || !collider) return null;
        return { id: entity.id, object, fields: { ...paramDefaults(componentDefs.collider.fields), ...collider } as Params };
    }

    // Where a handle is, in the units of the object
    private place(fields: Params, kind: Kind, axis: number, sign: number) {
        const point = new THREE.Vector3(fields.centerX as number, fields.centerY as number, fields.centerZ as number);
        if (kind === "center") return point;
        const reach = kind === "size"
            ? (fields[`size${AXES[axis]}`] as number) / 2
            : kind === "height" ? (fields.height as number) / 2 : (fields.radius as number);
        return point.setComponent(axis, point.getComponent(axis) + sign * reach);
    }

    // Call when the store changes: the handles follow the selection and the fields
    update() {
        this.group.clear();
        this.handles = [];
        const target = this.target();
        if (!target) return;

        target.object.updateWorldMatrix(true, false);
        const add = (kind: Kind, axis: 0 | 1 | 2, sign: 1 | -1) => {
            const active = this.drag && this.drag.handle.kind === kind && this.drag.handle.axis === axis && this.drag.handle.sign === sign;
            const mesh = new THREE.Mesh(kind === "center" ? this.square : this.dot, active ? this.activeMaterial : this.material);
            mesh.position.copy(target.object.localToWorld(this.place(target.fields, kind, axis, sign)));
            mesh.layers.set(EDITOR_LAYER);
            mesh.renderOrder = 1000;
            this.group.add(mesh);
            this.handles.push({ mesh, kind, axis, sign });
        };

        const { shape } = target.fields;
        for (const axis of [0, 1, 2] as const) {
            for (const sign of [1, -1] as const) {
                if (shape === "box") add("size", axis, sign);
                else if (shape === "capsule" && axis === 1) add("height", axis, sign);
                else add("radius", axis, sign);
            }
        }
        add("center", 0, 1);
    }

    // Call every frame: keeps the handles the same size on the screen
    frame() {
        const eye = this.camera.getWorldPosition(new THREE.Vector3());
        for (const { mesh } of this.handles) mesh.scale.setScalar(Math.max(0.001, mesh.position.distanceTo(eye) * HANDLE_SIZE));
    }

    private ray(e: PointerEvent) {
        const rect = this.dom.getBoundingClientRect();
        const mouse = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
        this.raycaster.setFromCamera(mouse, this.camera);
        return this.raycaster.ray;
    }

    private onDown = (e: PointerEvent) => {
        this.grabbed = false;
        if (e.button !== 0 || this.handles.length === 0) return;
        this.ray(e);
        // A little bigger than they look: easier to catch
        const hit = this.handles
            .map((handle) => ({ handle, distance: this.raycaster.ray.distanceToPoint(handle.mesh.position), reach: handle.mesh.scale.x * 2 }))
            .filter(({ distance, reach }) => distance < reach)
            .sort((a, b) => a.distance - b.distance)[0];
        const target = this.target();
        if (!hit || !target) return;

        const { kind, axis, sign } = hit.handle;
        const from = target.object.localToWorld(this.place(target.fields, "center", 0, 1));
        const unit = new THREE.Vector3().setComponent(axis, 1).add(this.place(target.fields, "center", 0, 1));
        const direction = target.object.localToWorld(unit).sub(from);
        const origin = hit.handle.mesh.position.clone();
        this.drag = {
            handle: { kind, axis, sign },
            id: target.id,
            start: target.fields,
            origin,
            scale: direction.length() || 1,
            direction: direction.normalize(),
            plane: new THREE.Plane().setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(new THREE.Vector3()), origin),
        };
        this.grabbed = true;
        this.controls.enabled = false;
        this.dom.setPointerCapture(e.pointerId);
        this.update();
    };

    private onMove = (e: PointerEvent) => {
        const { drag } = this;
        const object = sceneStore.selectedObject;
        if (!drag || !object) return;
        const ray = this.ray(e);
        const set = (field: string, value: number) => {
            if (value !== drag.start[field] || sceneStore.selected) sceneStore.setComponentField(drag.id, "collider", field, round(value));
        };

        if (drag.handle.kind === "center") {
            const point = ray.intersectPlane(drag.plane, new THREE.Vector3());
            if (!point) return;
            object.updateWorldMatrix(true, false);
            const local = object.worldToLocal(point);
            set("centerX", local.x);
            set("centerY", local.y);
            set("centerZ", local.z);
            return;
        }

        // How far along its line the handle has to go to be nearest to the mouse
        const w = drag.origin.clone().sub(ray.origin);
        const b = drag.direction.dot(ray.direction);
        const denominator = 1 - b * b;
        if (denominator < 1e-6) return;
        const along = (b * ray.direction.dot(w) - drag.direction.dot(w)) / denominator;
        // In the units of the object, outwards
        const grow = (drag.handle.sign * along) / drag.scale;

        const axis = AXES[drag.handle.axis];
        if (drag.handle.kind === "size") {
            // The opposite side stays where it is: the middle moves by half of what the size grew
            const before = drag.start[`size${axis}`] as number;
            const size = Math.max(0.01, before + grow);
            set(`size${axis}`, size);
            set(`center${axis}`, (drag.start[`center${axis}`] as number) + (drag.handle.sign * (size - before)) / 2);
        } else if (drag.handle.kind === "height") {
            set("height", Math.max(0.01, (drag.start.height as number) + grow * 2));
        } else {
            set("radius", Math.max(0.01, (drag.start.radius as number) + grow));
        }
    };

    private onUp = (e: PointerEvent) => {
        if (!this.drag) return;
        this.drag = null;
        this.controls.enabled = !sceneStore.gameView;
        if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
        this.update();
    };

    dispose() {
        this.dom.removeEventListener("pointerdown", this.onDown, true);
        this.dom.removeEventListener("pointermove", this.onMove);
        this.dom.removeEventListener("pointerup", this.onUp);
        this.dom.removeEventListener("pointercancel", this.onUp);
        this.group.removeFromParent();
        this.dot.dispose();
        this.square.dispose();
        this.material.dispose();
        this.activeMaterial.dispose();
    }
}
