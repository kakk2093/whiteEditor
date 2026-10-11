import * as THREE from "three";
import { disposeObject } from "./components";
import { Input } from "./input";
import { createEntityObject, createPrefabInstance } from "./loadScene";
import { paramDefaults } from "./Registry";
import type { BehaviorDef, BehaviorSelf, FindQuery, RayHit, RayOptions, Registry, VectorLike } from "./Registry";
import { layerOf } from "./settings";
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
    // Its collision layer: colliders of layers that are set not to collide do not notice each other
    layer: string;
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

const toVector = (value: VectorLike) => (Array.isArray(value) ? new THREE.Vector3(...value) : value.clone());

// Where a ray from `origin` along `direction` (of length 1) enters the body: how far that is and which way
// the surface faces there. null if it misses, or starts inside.
function rayBody(origin: THREE.Vector3, direction: THREE.Vector3, body: Body): { distance: number; normal: THREE.Vector3 } | null {
    if (body.box) {
        // The ray is inside the box between the latest entry and the earliest exit through its three pairs of sides
        let enter = -Infinity;
        let exit = Infinity;
        const normal = new THREE.Vector3();
        for (const axis of ["x", "y", "z"] as const) {
            const from = origin[axis];
            const step = direction[axis];
            if (Math.abs(step) < 1e-9) {
                if (from < body.box.min[axis] || from > body.box.max[axis]) return null;
                continue;
            }
            const near = ((step > 0 ? body.box.min[axis] : body.box.max[axis]) - from) / step;
            const far = ((step > 0 ? body.box.max[axis] : body.box.min[axis]) - from) / step;
            if (near > enter) {
                enter = near;
                normal.set(0, 0, 0)[axis] = step > 0 ? -1 : 1;
            }
            exit = Math.min(exit, far);
        }
        return enter >= 0 && enter <= exit ? { distance: enter, normal } : null;
    }

    const capsule = body.capsule;
    if (!capsule) return null;
    const { bottom, top, radius } = capsule;
    let best: { distance: number; normal: THREE.Vector3 } | null = null;
    const take = (distance: number, normal: THREE.Vector3) => {
        if (distance >= 0 && (!best || distance < best.distance)) best = { distance, normal };
    };

    // The side: a circle seen from above, as high as the line of the capsule
    const ox = origin.x - bottom.x;
    const oz = origin.z - bottom.z;
    const a = direction.x ** 2 + direction.z ** 2;
    if (a > 1e-12 && top.y > bottom.y) {
        const b = ox * direction.x + oz * direction.z;
        const root = b * b - a * (ox * ox + oz * oz - radius * radius);
        if (root >= 0) {
            const distance = (-b - Math.sqrt(root)) / a;
            const y = origin.y + direction.y * distance;
            if (y >= bottom.y && y <= top.y) {
                take(distance, new THREE.Vector3(ox + direction.x * distance, 0, oz + direction.z * distance).divideScalar(radius));
            }
        }
    }
    // The round ends: a ball at each end of the line (for a sphere both are the same ball)
    for (const center of top.y > bottom.y ? [bottom, top] : [bottom]) {
        const offset = origin.clone().sub(center);
        const b = offset.dot(direction);
        const root = b * b - (offset.lengthSq() - radius * radius);
        if (root < 0) continue;
        const distance = -b - Math.sqrt(root);
        const point = origin.clone().addScaledVector(direction, distance);
        // Only the half that sticks out past the line
        if (top.y > bottom.y && (center === bottom ? point.y > bottom.y : point.y < top.y)) continue;
        take(distance, point.sub(center).divideScalar(radius));
    }
    return best;
}

// The longest step a moving collider makes at once, meters: a fast object goes in several, so it does not
// jump over a thin wall
const MAX_STEP = 0.25;

// How far down "standing on something" reaches, meters
const GROUND_REACH = 0.05;

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

    // The camera the scene is seen through, for screenRay(); whoever runs the scene keeps it up to date
    camera: THREE.Camera | null = null;

    // The vertical speed of the objects that fall(), meters per second
    private speeds = new WeakMap<THREE.Object3D, number>();

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
                raycast: (origin, direction, options) => this.raycast(origin, direction, { ignore: obj, ...options }),
                screenRay: (x, y) => this.screenRay(x, y),
                findAll: (query) => this.findAll(query),
                find: (query) => this.findAll(query)[0] ?? null,
                fall: (dt, gravity) => this.fall(obj, dt, gravity),
                jump: (speed) => this.speeds.set(obj, speed),
                grounded: () => this.grounded(obj),
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
        const layer = layerOf((f as { layer?: unknown }).layer);
        if (shape === "sphere" || shape === "capsule") {
            const scale = new THREE.Vector3().setFromMatrixScale(marker.matrixWorld);
            const center = new THREE.Vector3().setFromMatrixPosition(marker.matrixWorld);
            if (shape === "sphere") {
                return { object, solid, layer, capsule: { bottom: center, top: center, radius: f.radius * Math.max(scale.x, scale.y, scale.z) } };
            }
            // The line of the capsule ends where its round ends begin
            const radius = f.radius * Math.max(scale.x, scale.z);
            const half = Math.max(0, (f.height * scale.y) / 2 - radius);
            return {
                object,
                solid,
                layer,
                capsule: { bottom: center.clone().setY(center.y - half), top: center.clone().setY(center.y + half), radius },
            };
        }
        const half = new THREE.Vector3(f.sizeX, f.sizeY, f.sizeZ).multiplyScalar(0.5);
        return { object, solid, layer, box: new THREE.Box3(half.clone().negate(), half).applyMatrix4(marker.matrixWorld) };
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
        const obstacles = this.obstacles(object);
        if (!obstacles) {
            object.position.x += x;
            object.position.y += y;
            object.position.z += z;
            return true;
        }

        let free = true;
        for (const [axis, delta] of [["x", x], ["y", y], ["z", z]] as const) {
            if (delta === 0) continue;
            // A long way is gone in short steps, up to the first one that something stops
            const steps = Math.ceil(Math.abs(delta) / MAX_STEP);
            for (let i = 0; i < steps; i++) {
                object.position[axis] += delta / steps;
                object.updateWorldMatrix(true, true);
                if (obstacles(this.bodyOf(object)!)) {
                    // Back to before the step, then as near to the obstacle as halving the step gets
                    let part = delta / steps;
                    object.position[axis] -= part;
                    for (let n = 0; n < 6; n++) {
                        part /= 2;
                        object.position[axis] += part;
                        object.updateWorldMatrix(true, true);
                        if (obstacles(this.bodyOf(object)!)) object.position[axis] -= part;
                    }
                    free = false;
                    break;
                }
            }
        }
        object.updateWorldMatrix(true, true);
        return free;
    }

    // For an object with a solid collider: a test that tells whether its collider, wherever it has got to, is
    // stopped by another solid one. undefined if the object has no solid collider, so nothing stops it.
    private obstacles(object: THREE.Object3D) {
        const mine = this.bodyOf(object);
        if (!mine?.solid) return undefined;
        const inside = new Set<THREE.Object3D>();
        object.traverse((obj) => inside.add(obj));
        const others = this.bodies().filter(
            (body) => body.solid && !inside.has(body.object) && this.registry.layersCollide(mine.layer, body.layer)
        );
        // What it is stuck in already does not hold it: otherwise it could never get out
        const stuck = new Set(others.filter((other) => overlaps(mine, other)));
        return (moved: Body) => others.some((other) => !stuck.has(other) && overlaps(moved, other));
    }

    // What a behavior calls as self.fall(): gravity, one frame of it
    fall(object: THREE.Object3D, dt: number, gravity = 20) {
        let speed = (this.speeds.get(object) ?? 0) - gravity * dt;
        const free = this.move(object, 0, speed * dt, 0);
        const standing = !free && speed < 0;
        // Stopped by the ground, or by a ceiling on the way up
        if (!free) speed = 0;
        this.speeds.set(object, speed);
        return standing;
    }

    // What a behavior calls as self.grounded(): is there a solid collider right under the object
    grounded(object: THREE.Object3D) {
        const obstacles = this.obstacles(object);
        if (!obstacles) return false;
        object.position.y -= GROUND_REACH;
        object.updateWorldMatrix(true, true);
        const standing = obstacles(this.bodyOf(object)!);
        object.position.y += GROUND_REACH;
        object.updateWorldMatrix(true, true);
        return standing;
    }

    // What a behavior calls as self.raycast(): the nearest collider on the way of a ray
    raycast(origin: VectorLike, direction: VectorLike, options: RayOptions = {}): RayHit | null {
        const from = toVector(origin);
        const along = toVector(direction);
        if (along.lengthSq() === 0) return null;
        along.normalize();
        const reach = options.distance ?? Infinity;
        const skipped = new Set<THREE.Object3D>();
        options.ignore?.traverse((obj) => skipped.add(obj));

        let best: RayHit | null = null;
        for (const body of this.bodies()) {
            if (skipped.has(body.object) || (!body.solid && !options.triggers)) continue;
            if (options.layers && !options.layers.includes(body.layer)) continue;
            const hit = rayBody(from, along, body);
            if (!hit || hit.distance > reach || (best && hit.distance >= best.distance)) continue;
            best = { object: body.object, point: from.clone().addScaledVector(along, hit.distance), ...hit };
        }
        return best;
    }

    // What a behavior calls as self.screenRay(): from the camera through a point of the screen
    screenRay(x = this.input.mouseX, y = this.input.mouseY) {
        if (!this.camera) return null;
        this.camera.updateMatrixWorld();
        const caster = new THREE.Raycaster();
        caster.setFromCamera(new THREE.Vector2(x, y), this.camera);
        return { origin: caster.ray.origin.clone(), direction: caster.ray.direction.clone() };
    }

    // What a behavior calls as self.findAll(): the active entities that fit the query
    findAll(query: FindQuery) {
        const found: THREE.Object3D[] = [];
        this.root.traverse((obj) => {
            if (obj.userData.entityId === undefined && obj.userData.innerId === undefined) return;
            if (query.tag !== undefined && obj.userData.tag !== query.tag) return;
            if (query.name !== undefined && obj.name !== query.name) return;
            if (query.behavior !== undefined && !this.get(query.behavior, obj)) return;
            if (this.isActive(obj) && !this.doomed.has(obj)) found.push(obj);
        });
        return found;
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
                if (!this.registry.layersCollide(bodies[i].layer, bodies[j].layer) || !overlaps(bodies[i], bodies[j])) continue;
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
        const what = `Script "${instance.def.name}" on "${instance.self.object.name}" stopped`;
        console.error(`${what}:`, e);
        this.onError(`${what}: ${e instanceof Error ? e.message : String(e)}`);
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
