import * as THREE from "three";
import { disposeObject } from "./components";
import { Input } from "./input";
import { createEntityObject, createPrefabInstance } from "./loadScene";
import { paramDefaults } from "./Registry";
import type { BehaviorDef, BehaviorSelf, Registry } from "./Registry";
import type { ComponentData, Params, Vec3 } from "./types";

interface Instance {
    def: BehaviorDef;
    // The script component the behavior was created from
    component: ComponentData;
    // component.params that self.params was made of; another object means the params were edited
    source: unknown;
    self: BehaviorSelf;
    started: boolean;
    // Set after start() or update() threw: the behavior is left alone from then on
    failed: boolean;
}

// A collider in the world, as it is this moment
interface Body {
    // The entity the collider belongs to
    object: THREE.Object3D;
    solid: boolean;
    // Either a box along the axes of the world...
    box?: THREE.Box3;
    // ...or an upright capsule: everything within `radius` of the vertical line from `bottom` up to `top`.
    // A sphere is a capsule whose line has no length.
    capsule?: { bottom: THREE.Vector3; top: THREE.Vector3; radius: number };
}

// How far apart two stretches of one line are; 0 if they overlap
const gap = (min1: number, max1: number, min2: number, max2: number) => Math.max(0, min1 - max2, min2 - max1);

function overlaps(a: Body, b: Body) {
    if (a.box && b.box) return a.box.intersectsBox(b.box);
    if (a.capsule && b.capsule) {
        // Both lines are vertical: sideways they are two points, in height two stretches
        const dx = a.capsule.bottom.x - b.capsule.bottom.x;
        const dz = a.capsule.bottom.z - b.capsule.bottom.z;
        const dy = gap(a.capsule.bottom.y, a.capsule.top.y, b.capsule.bottom.y, b.capsule.top.y);
        return Math.hypot(dx, dy, dz) < a.capsule.radius + b.capsule.radius;
    }
    const box = a.box ?? b.box;
    const capsule = a.capsule ?? b.capsule;
    if (!box || !capsule) return false;
    const dx = gap(capsule.bottom.x, capsule.bottom.x, box.min.x, box.max.x);
    const dz = gap(capsule.bottom.z, capsule.bottom.z, box.min.z, box.max.z);
    const dy = gap(capsule.bottom.y, capsule.top.y, box.min.y, box.max.y);
    return Math.hypot(dx, dy, dz) < capsule.radius;
}

// Runs the behaviors (script components) of a built scene.
// Game side:
//   const level = loadScene(registry, json); scene.add(level);
//   const runtime = new Runtime(registry, level); runtime.start();
//   every frame: runtime.update(dt); runtime.input.endFrame();
export class Runtime {
    // Seconds since start()
    time = 0;

    // Called with a readable message when a behavior throws; the error itself goes to the console
    onError: (message: string) => void = () => {};

    private instances: Instance[] = [];

    // Objects that destroy() was asked to remove; they go once the behaviors of the frame have run
    private doomed = new Set<THREE.Object3D>();

    // Who touches whom, as of the last frame: tells "enter" from "still there"
    private contacts = new Map<THREE.Object3D, Set<THREE.Object3D>>();

    private registry: Registry;

    private root: THREE.Object3D;

    // What the behaviors read the keyboard and the mouse from
    readonly input: Input;

    constructor(registry: Registry, root: THREE.Object3D, input = new Input()) {
        this.registry = registry;
        this.root = root;
        this.input = input;
        root.traverse((obj) => this.attach(obj));
    }

    // Number of behaviors in the scene
    get count() {
        return this.instances.length;
    }

    // Creates the behaviors of one entity object that do not exist yet
    private attach(obj: THREE.Object3D) {
        for (const component of (obj.userData.scripts ?? []) as ComponentData[]) {
            if (this.instances.some((i) => i.self.object === obj && i.component === component)) continue;

            const name = component.script as string;
            const def = this.registry.getBehavior(name);
            if (!def) {
                console.warn(`Unknown behavior "${name}"`);
                continue;
            }
            const self: BehaviorSelf = {
                object: obj,
                params: {},
                state: undefined,
                root: this.root,
                registry: this.registry,
                input: this.input,
                time: this.time,
                spawn: (prefab, position, parent) => this.spawn(prefab, position, parent),
                destroy: (object = obj) => this.destroy(object),
                get: <S>(behavior: string, object = obj) => this.get(behavior, object) as BehaviorSelf<Params, S> | null,
                move: (x, y, z) => this.move(obj, x, y, z),
                touching: () => [...(this.contacts.get(obj) ?? [])],
            };
            // `source` differs from any component.params, so the first step fills self.params
            this.instances.push({ def, component, source: null, self, started: false, failed: false });
        }
    }

    // The script components of the object were added or removed while the scene is running (the editor does
    // that during Play). New behaviors start on the next update.
    refresh(obj: THREE.Object3D) {
        const scripts = (obj.userData.scripts ?? []) as ComponentData[];
        this.instances = this.instances.filter((i) => i.self.object !== obj || scripts.includes(i.component));
        this.attach(obj);
    }

    // Puts an object built by createEntityObject() or instantiatePrefab() into the running scene (under
    // `parent`, the scene itself by default). Its behaviors start in this very frame if it is added by a
    // behavior, otherwise on the next update.
    add(object: THREE.Object3D, parent: THREE.Object3D = this.root) {
        parent.add(object);
        object.traverse((obj) => this.attach(obj));
        return object;
    }

    // A new instance of the prefab in the running scene; what a behavior calls as self.spawn()
    spawn(prefab: string, position: Vec3 = [0, 0, 0], parent?: THREE.Object3D) {
        const entity = createPrefabInstance(this.registry, prefab);
        entity.position = [...position];
        return this.add(createEntityObject(this.registry, entity), parent);
    }

    // Removes the object with everything under it; what a behavior calls as self.destroy(). It happens after
    // the behaviors of this frame have run, so nothing disappears under a behavior that is still working.
    destroy(object: THREE.Object3D) {
        if (object !== this.root) this.doomed.add(object);
    }

    // The behavior `name` of the object, as that behavior sees itself: its params and state
    get(name: string, object: THREE.Object3D): BehaviorSelf | null {
        return this.instances.find((i) => i.self.object === object && i.def.name === name)?.self ?? null;
    }

    // The collider of one entity object, where it is now; undefined if it has none
    private bodyOf(object: THREE.Object3D): Body | undefined {
        const marker = object.children.find((child) => child.userData.collider);
        if (!marker) return undefined;
        // The fields of the collider component, defaults filled in
        const f = marker.userData.collider as { shape: string; sizeX: number; sizeY: number; sizeZ: number; radius: number; height: number; solid: boolean };
        const { shape, solid } = f;
        if (shape === "sphere" || shape === "capsule") {
            const scale = new THREE.Vector3().setFromMatrixScale(marker.matrixWorld);
            const center = new THREE.Vector3().setFromMatrixPosition(marker.matrixWorld);
            if (shape === "sphere") {
                return { object, solid, capsule: { bottom: center, top: center, radius: f.radius * Math.max(scale.x, scale.y, scale.z) } };
            }
            // The line of the capsule ends where its round ends begin
            const radius = f.radius * Math.max(scale.x, scale.z);
            const half = Math.max(0, (f.height * scale.y) / 2 - radius);
            return {
                object,
                solid,
                capsule: { bottom: center.clone().setY(center.y - half), top: center.clone().setY(center.y + half), radius },
            };
        }
        const half = new THREE.Vector3(f.sizeX, f.sizeY, f.sizeZ).multiplyScalar(0.5);
        return { object, solid, box: new THREE.Box3(half.clone().negate(), half).applyMatrix4(marker.matrixWorld) };
    }

    // Every collider of the active entities
    private bodies() {
        this.root.updateMatrixWorld();
        const bodies: Body[] = [];
        this.root.traverse((obj) => {
            if (!obj.userData.collider || !obj.parent || !this.isActive(obj.parent)) return;
            const body = this.bodyOf(obj.parent);
            if (body) bodies.push(body);
        });
        return bodies;
    }

    // What a behavior calls as self.move(): one axis at a time, so that an object pushed into a wall at an
    // angle slides along it instead of stopping dead
    move(object: THREE.Object3D, x: number, y: number, z: number) {
        const mine = this.bodyOf(object);
        if (!mine?.solid) {
            object.position.x += x;
            object.position.y += y;
            object.position.z += z;
            return true;
        }

        const inside = new Set<THREE.Object3D>();
        object.traverse((obj) => inside.add(obj));
        const others = this.bodies().filter((body) => body.solid && !inside.has(body.object));
        // What it is stuck in already does not hold it: otherwise it could never get out
        const stuck = new Set(others.filter((other) => overlaps(mine, other)));

        let free = true;
        for (const [axis, delta] of [["x", x], ["y", y], ["z", z]] as const) {
            if (delta === 0) continue;
            object.position[axis] += delta;
            object.updateWorldMatrix(true, true);
            const moved = this.bodyOf(object)!;
            if (others.some((other) => !stuck.has(other) && overlaps(moved, other))) {
                object.position[axis] -= delta;
                free = false;
            }
        }
        object.updateWorldMatrix(true, true);
        return free;
    }

    // Finds which colliders touch now and tells the behaviors about what began and what ended
    private collide() {
        const bodies = this.bodies();
        const now = new Map<THREE.Object3D, Set<THREE.Object3D>>();
        const touch = (a: THREE.Object3D, b: THREE.Object3D) => {
            if (!now.has(a)) now.set(a, new Set());
            now.get(a)!.add(b);
        };
        for (let i = 0; i < bodies.length; i++) {
            for (let j = i + 1; j < bodies.length; j++) {
                if (!overlaps(bodies[i], bodies[j])) continue;
                touch(bodies[i].object, bodies[j].object);
                touch(bodies[j].object, bodies[i].object);
            }
        }

        const before = this.contacts;
        this.contacts = now;
        const tell = (hook: "enter" | "exit", object: THREE.Object3D, other: THREE.Object3D) => {
            for (const instance of [...this.instances]) {
                if (instance.self.object !== object || !instance.started || instance.failed) continue;
                try {
                    instance.def[hook]?.(instance.self, other);
                } catch (e) {
                    instance.failed = true;
                    this.report(instance, e);
                }
            }
        };
        for (const [object, others] of now) {
            for (const other of others) if (!before.get(object)?.has(other)) tell("enter", object, other);
        }
        for (const [object, others] of before) {
            for (const other of others) if (!now.get(object)?.has(other)) tell("exit", object, other);
        }
    }

    // An inactive entity is hidden with its children, and their behaviors wait until it is shown
    private isActive(obj: THREE.Object3D) {
        for (let o: THREE.Object3D | null = obj; o; o = o.parent) {
            if (!o.visible) return false;
            if (o === this.root) return true;
        }
        // Removed from the scene
        return false;
    }

    private report(instance: Instance, e: unknown) {
        console.error(e);
        const message = e instanceof Error ? e.message : String(e);
        this.onError(`Script "${instance.def.name}" on "${instance.self.object.name}" stopped: ${message}`);
    }

    // Starts the behavior if it has not started yet, then updates it when `dt` is given
    private step(instance: Instance, dt?: number) {
        const { def, component, self } = instance;
        if (instance.failed || !this.isActive(self.object)) return;

        // Params are read from the component, so a value edited during Play applies at once
        if (instance.source !== component.params) {
            instance.source = component.params;
            self.params = { ...paramDefaults(def.params ?? {}), ...(component.params as Params | undefined) };
        }

        try {
            if (!instance.started) {
                instance.started = true;
                self.state = def.start?.(self);
            }
            if (dt !== undefined) def.update?.(self, dt);
        } catch (e) {
            instance.failed = true;
            this.report(instance, e);
        }
    }

    // Tells a behavior that its object is going away; only one that has started has anything to clean up
    private end(instance: Instance) {
        if (!instance.started || instance.failed) return;
        try {
            instance.def.destroy?.(instance.self);
        } catch (e) {
            this.report(instance, e);
        }
    }

    // Removes what destroy() was asked to remove
    private sweep() {
        // A destroy hook may destroy more
        while (this.doomed.size > 0) {
            const [object] = this.doomed;
            this.doomed.delete(object);

            const inside = new Set<THREE.Object3D>();
            object.traverse((obj) => inside.add(obj));
            const gone = this.instances.filter((i) => inside.has(i.self.object));
            this.instances = this.instances.filter((i) => !inside.has(i.self.object));
            gone.forEach((instance) => this.end(instance));

            object.removeFromParent();
            disposeObject(object);
        }
    }

    start() {
        // A plain loop: a behavior may add objects, and with them instances, while this runs
        for (let i = 0; i < this.instances.length; i++) this.step(this.instances[i]);
        this.sweep();
    }

    update(dt: number) {
        this.time += dt;
        for (let i = 0; i < this.instances.length; i++) {
            const instance = this.instances[i];
            instance.self.time = this.time;
            this.step(instance, dt);
        }
        this.collide();
        this.sweep();
    }

    // The scene stops: every behavior gets its destroy()
    dispose() {
        this.instances.forEach((instance) => this.end(instance));
        this.instances = [];
        this.doomed.clear();
        this.contacts.clear();
    }
}
