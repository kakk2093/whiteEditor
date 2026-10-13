import * as THREE from "three";
import { disposeObject } from "./components";
import type { EnvironmentData } from "./environment";
import { Input } from "./input";
import { createEntityObject, createPrefabInstance } from "./loadScene";
import { paramDefaults } from "./Registry";
import { particlesOf, updateParticles } from "./particles";
import { animationOf, animatorOf, updateAnimations } from "./animation";
import { updateModelFiles } from "./gltf";
import { Physics } from "./physics";
import type { BehaviorDef, BehaviorSelf, Ease, FindQuery, RayHit, RayOptions, Registry, Running, SoundSource, TweenOptions, VectorLike } from "./Registry";
import { layerOf } from "./settings";
import { rayTerrain, terrainHeight, terrainRange, terrainSize } from "./terrain";
import type { TerrainData, TerrainMarker } from "./terrain";
import { SoundPlayer } from "./sound";
import type { SoundHandle } from "./sound";
import { setLabelText } from "./sprites";
import { uiOf } from "./ui";
import type { UiEvent } from "./ui";
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
    // The entity has a Body: the physics moves it, and it gives way to what walks into it
    dynamic: boolean;
    // Kilograms of that Body; 0 without one
    mass: number;
    // Either a box along the axes of the world...
    box?: THREE.Box3;
    // ...which, for a collider that is turned (a ramp, a wall at an angle), is only the box it fits in:
    // the collider itself is this one
    oriented?: OrientedBox;
    // ...or an upright capsule: everything within `radius` of the vertical line from `bottom` up to `top`.
    // A sphere is a capsule whose line has no length.
    capsule?: { bottom: THREE.Vector3; top: THREE.Vector3; radius: number };
    // ...or the ground of a Terrain component: everything under its heights. `origin` is the middle of the
    // terrain in the world; `box` is then the box the ground fits in.
    terrain?: { data: TerrainData; origin: THREE.Vector3 };
}

// A box that is turned: its middle, its three axes (each of length 1) and half its size along each
interface OrientedBox {
    center: THREE.Vector3;
    axes: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
    half: [number, number, number];
}

// The collider box of this size (half of it) under this matrix, if it is turned; undefined if its sides
// are along the axes of the world, where a plain Box3 says everything
function orientedBox(matrix: THREE.Matrix4, half: THREE.Vector3): OrientedBox | undefined {
    const center = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    matrix.decompose(center, rotation, scale);
    const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)].map((axis) => axis.applyQuaternion(rotation)) as OrientedBox["axes"];
    if (axes.every((axis) => Math.max(Math.abs(axis.x), Math.abs(axis.y), Math.abs(axis.z)) > 0.99999)) return undefined;
    return { center, axes, half: [Math.abs(half.x * scale.x), Math.abs(half.y * scale.y), Math.abs(half.z * scale.z)] };
}

const WORLD_AXES: OrientedBox["axes"] = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];

// Any box collider in the form of a turned one
function asOriented(body: Body): OrientedBox {
    if (body.oriented) return body.oriented;
    const size = body.box!.getSize(new THREE.Vector3());
    return { center: body.box!.getCenter(new THREE.Vector3()), axes: WORLD_AXES, half: [size.x / 2, size.y / 2, size.z / 2] };
}

// Do two turned boxes overlap: they do not if, seen along one of 15 directions (the sides of each and the
// pairs of their edges), there is a gap between them
function boxesOverlap(a: OrientedBox, b: OrientedBox) {
    const between = b.center.clone().sub(a.center);
    const reach = (box: OrientedBox, along: THREE.Vector3) => box.half[0] * Math.abs(box.axes[0].dot(along)) + box.half[1] * Math.abs(box.axes[1].dot(along)) + box.half[2] * Math.abs(box.axes[2].dot(along));
    const apart = (along: THREE.Vector3) => along.lengthSq() > 1e-10 && Math.abs(between.dot(along)) > (reach(a, along) + reach(b, along)) * (1 + 1e-9);
    for (const axis of [...a.axes, ...b.axes]) if (apart(axis)) return false;
    const cross = new THREE.Vector3();
    for (const first of a.axes) {
        for (const second of b.axes) {
            // The reach is counted for a direction of any length, as long as both sides use the same one
            if (apart(cross.crossVectors(first, second).normalize())) return false;
        }
    }
    return true;
}

// Is an upright capsule within its radius of a turned box. In the box's own axes the box is plain; the
// distance from a point of the line to it has one lowest place along the line, found by narrowing down.
function capsuleInBox(capsule: NonNullable<Body["capsule"]>, box: OrientedBox) {
    const local = (point: THREE.Vector3) => {
        const offset = point.clone().sub(box.center);
        return [offset.dot(box.axes[0]), offset.dot(box.axes[1]), offset.dot(box.axes[2])];
    };
    const from = local(capsule.bottom);
    const to = local(capsule.top);
    const distance = (t: number) => Math.hypot(...[0, 1, 2].map((i) => Math.max(0, Math.abs(from[i] + (to[i] - from[i]) * t) - box.half[i])));
    let low = 0;
    let high = 1;
    for (let n = 0; n < 24 && high - low > 1e-5; n++) {
        const a = low + (high - low) / 3;
        const b = high - (high - low) / 3;
        if (distance(a) < distance(b)) high = b;
        else low = a;
    }
    return distance((low + high) / 2) < capsule.radius;
}

// Is a collider in the ground of a terrain: is the ground, somewhere under the collider, higher than the
// underside of the collider there. Looked at in a few places across it, no further apart than half a cell.
function inTerrain(body: Body, ground: Body) {
    const { data, origin } = ground.terrain!;
    const over = (x: number, z: number, y: number) => {
        const height = terrainHeight(data, x - origin.x, z - origin.z);
        return height !== null && height + origin.y > y;
    };
    if (body.capsule) {
        const { bottom, radius } = body.capsule;
        if (bottom.y - radius > ground.box!.max.y) return false;
        // Rings around its axis: the round end is higher the further from the axis
        const rings = Math.max(1, Math.min(4, Math.ceil(radius / (data.cell / 2))));
        if (over(bottom.x, bottom.z, bottom.y - radius)) return true;
        for (let ring = 1; ring <= rings; ring++) {
            const reach = (radius * ring) / rings;
            // The very edge of the round end is its middle height: a wall, not ground
            const under = bottom.y - Math.sqrt(Math.max(0, radius * radius - reach * reach));
            for (let n = 0; n < 8; n++) {
                const angle = (n * Math.PI) / 4;
                if (over(bottom.x + Math.cos(angle) * reach, bottom.z + Math.sin(angle) * reach, under)) return true;
            }
        }
        return false;
    }
    const box = body.box;
    if (!box || box.min.y > ground.box!.max.y) return false;
    const countX = Math.max(2, Math.min(9, Math.ceil((box.max.x - box.min.x) / (data.cell / 2)) + 1));
    const countZ = Math.max(2, Math.min(9, Math.ceil((box.max.z - box.min.z) / (data.cell / 2)) + 1));
    for (let i = 0; i < countX; i++) {
        for (let j = 0; j < countZ; j++) {
            const x = box.min.x + ((box.max.x - box.min.x) * i) / (countX - 1);
            const z = box.min.z + ((box.max.z - box.min.z) * j) / (countZ - 1);
            if (over(x, z, box.min.y)) return true;
        }
    }
    return false;
}

// How far apart two stretches of one line are; 0 if they overlap
const gap = (min1: number, max1: number, min2: number, max2: number) => Math.max(0, min1 - max2, min2 - max1);

function overlaps(a: Body, b: Body) {
    if (a.terrain || b.terrain) return a.terrain && b.terrain ? false : a.terrain ? inTerrain(b, a) : inTerrain(a, b);
    if (a.box && b.box) {
        // The boxes they fit in first: most pairs are far apart
        if (!a.box.intersectsBox(b.box)) return false;
        return a.oriented || b.oriented ? boxesOverlap(asOriented(a), asOriented(b)) : true;
    }
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
    const turned = (a.box ? a : b).oriented;
    if (turned) return capsuleInBox(capsule, turned);
    const dx = gap(capsule.bottom.x, capsule.bottom.x, box.min.x, box.max.x);
    const dz = gap(capsule.bottom.z, capsule.bottom.z, box.min.z, box.max.z);
    const dy = gap(capsule.bottom.y, capsule.top.y, box.min.y, box.max.y);
    return Math.hypot(dx, dy, dz) < capsule.radius;
}

const toVector = (value: VectorLike) => (Array.isArray(value) ? new THREE.Vector3(...value) : value.clone());

// Where a ray from `origin` along `direction` (of length 1) enters the body: how far that is and which way
// the surface faces there. null if it misses, or starts inside.
function rayBody(origin: THREE.Vector3, direction: THREE.Vector3, body: Body, reach = Infinity): { distance: number; normal: THREE.Vector3 } | null {
    if (body.terrain) return rayTerrain(body.terrain.data, origin.clone().sub(body.terrain.origin), direction, reach);
    if (body.oriented) {
        // The same as for a plain box, in the axes of this one
        const { center, axes, half } = body.oriented;
        const offset = origin.clone().sub(center);
        let enter = -Infinity;
        let exit = Infinity;
        const normal = new THREE.Vector3();
        for (let i = 0; i < 3; i++) {
            const from = offset.dot(axes[i]);
            const step = direction.dot(axes[i]);
            if (Math.abs(step) < 1e-9) {
                if (Math.abs(from) > half[i]) return null;
                continue;
            }
            const near = ((step > 0 ? -half[i] : half[i]) - from) / step;
            const far = ((step > 0 ? half[i] : -half[i]) - from) / step;
            if (near > enter) {
                enter = near;
                normal.copy(axes[i]).multiplyScalar(step > 0 ? -1 : 1);
            }
            exit = Math.min(exit, far);
        }
        return enter >= 0 && enter <= exit ? { distance: enter, normal } : null;
    }
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

const EASES: Record<Ease, (t: number) => number> = {
    linear: (t) => t,
    in: (t) => t * t,
    out: (t) => 1 - (1 - t) * (1 - t),
    inOut: (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
};

// Something that goes on by itself once a behavior has started it: a tween or a timer
interface Process {
    // The entity object of the behavior that started it: it ends with that object
    owner: THREE.Object3D;
    running: boolean;
    // Moves it on by dt seconds; false when it is over
    advance: (dt: number) => boolean;
}

// The longest step a moving collider makes at once, meters: a fast object goes in several, so it does not
// jump over a thin wall
const MAX_STEP = 0.25;

// How far down "standing on something" reaches, meters
const GROUND_REACH = 0.05;

// An object this close over the ground is on it
const GROUND_TOUCH = 0.004;

// The steepest slope an object walks up (self.move with a step): how much it rises for every meter forward.
// 1.2 is about 50 degrees; steeper is a wall.
const MAX_SLOPE = 1.2;

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

    // The environment of the scene, for self.environment; whoever runs the scene keeps it up to date and
    // takes the changes of self.setEnvironment()
    environment: EnvironmentData | null = null;

    onEnvironment: (change: Partial<EnvironmentData>) => void = () => {};

    // The tweens and timers that are going on
    private processes: Process[] = [];

    // What the sounds are played with
    readonly sound: SoundPlayer;

    // The bodies: what falls, rolls and is pushed
    readonly physics: Physics;

    // The Sound components that were noticed, by their marker objects, with what each of them plays now
    private sources = new Map<THREE.Object3D, SoundHandle | null>();

    // What every object that falls (self.fall) stood on after its last frame, and where that was then
    private supports = new Map<THREE.Object3D, { object: THREE.Object3D; place: THREE.Vector3 }>();

    // The camera the scene is seen through, for screenRay(); whoever runs the scene keeps it up to date
    camera: THREE.Camera | null = null;

    // The page element over the picture (self.overlay); the Game gives it
    overlay: HTMLElement | null = null;

    // What the behaviors keep from scene to scene (self.globals); whoever runs the scenes gives every one
    // of them the same object
    globals: Record<string, unknown> = {};

    // The scene a behavior has asked for with self.loadScene(); whoever runs the scene looks here after
    // update() and loads it
    requestedScene: string | null = null;

    // The vertical speed of the objects that fall(), meters per second
    private speeds = new WeakMap<THREE.Object3D, number>();

    constructor(registry: Registry, root: THREE.Object3D, input = new Input(), sound = new SoundPlayer(registry)) {
        this.registry = registry;
        this.root = root;
        this.input = input;
        this.sound = sound;
        this.physics = new Physics(registry);
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
            // For the getters of `self`, where `this` is `self`
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const runtime = this;
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
                move: (x, y, z, step) => this.move(obj, x, y, z, step),
                touching: () => [...(this.contacts.get(obj) ?? [])],
                raycast: (origin, direction, options) => this.raycast(origin, direction, { ignore: obj, ...options }),
                screenRay: (x, y) => this.screenRay(x, y),
                findAll: (query) => this.findAll(query),
                find: (query) => this.findAll(query)[0] ?? null,
                fall: (dt, gravity) => this.fall(obj, dt, gravity),
                jump: (speed) => this.speeds.set(obj, speed),
                grounded: () => this.grounded(obj),
                loadScene: (scene) => this.loadScene(scene),
                playSound: (sound, options) => this.sound.play(sound, options),
                playMusic: (sound, options) => this.sound.playMusic(sound, options),
                stopMusic: () => this.sound.stopMusic(),
                sound: (object = obj) => this.soundOf(object),
                body: (object = obj) => this.physics.handle(object),
                tween: (target, to, seconds, options) => this.tween(obj, target as Record<string, number>, to, seconds, options),
                after: (seconds, call) => this.timer(obj, seconds, call, false),
                every: (seconds, call) => this.timer(obj, seconds, call, true),
                ui: (object = obj) => uiOf(object),
                setText: (text, object = obj) => {
                    const element = uiOf(object);
                    if (element?.text) element.text.text = String(text);
                    setLabelText(object, String(text));
                },
                particles: (object = obj) => particlesOf(object),
                animation: (object = obj) => animationOf(object, this.registry),
                animator: (object = obj) => animatorOf(object),
                setEnvironment: (change) => this.onEnvironment(change),
                get environment() {
                    return runtime.environment;
                },
                get overlay() {
                    return runtime.overlay;
                },
                // Read through the runtime: the object is given after the behaviors are attached
                get globals() {
                    return runtime.globals;
                },
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
        const weight = object.children.find((child) => child.userData.body)?.userData.body as { mass?: number } | undefined;
        const dynamic = weight !== undefined;
        const mass = weight?.mass ?? 0;
        if (shape === "sphere" || shape === "capsule") {
            const scale = new THREE.Vector3().setFromMatrixScale(marker.matrixWorld);
            const center = new THREE.Vector3().setFromMatrixPosition(marker.matrixWorld);
            if (shape === "sphere") {
                return { object, solid, layer, dynamic, mass, capsule: { bottom: center, top: center, radius: f.radius * Math.max(scale.x, scale.y, scale.z) } };
            }
            // The line of the capsule ends where its round ends begin
            const radius = f.radius * Math.max(scale.x, scale.z);
            const half = Math.max(0, (f.height * scale.y) / 2 - radius);
            return {
                object,
                solid,
                layer,
                dynamic,
                mass,
                capsule: { bottom: center.clone().setY(center.y - half), top: center.clone().setY(center.y + half), radius },
            };
        }
        const half = new THREE.Vector3(f.sizeX, f.sizeY, f.sizeZ).multiplyScalar(0.5);
        const oriented = orientedBox(marker.matrixWorld, half);
        return { object, solid, layer, dynamic, mass, box: new THREE.Box3(half.clone().negate(), half).applyMatrix4(marker.matrixWorld), ...(oriented ? { oriented } : {}) };
    }

    // The ground of a Terrain component, from its mesh: where it is now
    private groundOf(mesh: THREE.Object3D): Body {
        const { data, layer } = mesh.userData.terrain as TerrainMarker;
        const origin = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
        const [width, depth] = terrainSize(data);
        const [low, high] = terrainRange(data);
        const box = new THREE.Box3(
            new THREE.Vector3(origin.x - width / 2, origin.y + low, origin.z - depth / 2),
            new THREE.Vector3(origin.x + width / 2, origin.y + high, origin.z + depth / 2),
        );
        return { object: mesh.parent!, solid: true, layer: layerOf(layer), dynamic: false, mass: 0, box, terrain: { data, origin } };
    }

    // Every collider of the active entities
    private bodies() {
        this.root.updateMatrixWorld();
        const bodies: Body[] = [];
        this.root.traverse((obj) => {
            if (!obj.parent || !this.isActive(obj.parent)) return;
            if (obj.userData.terrain) bodies.push(this.groundOf(obj));
            if (!obj.userData.collider) return;
            const body = this.bodyOf(obj.parent);
            if (body) bodies.push(body);
        });
        return bodies;
    }

    // What a behavior calls as self.move(): one axis at a time, so that an object pushed into a wall at an
    // angle slides along it instead of stopping dead. `step`: how high a ledge the object walks up onto
    // instead of stopping at it (a stair, a curb), meters; 0 for none.
    move(object: THREE.Object3D, x: number, y: number, z: number, step = 0) {
        const obstacles = this.obstacles(object);
        if (!obstacles) {
            object.position.x += x;
            object.position.y += y;
            object.position.z += z;
            return true;
        }

        // Is there ground right under the object, where it is now
        const standing = () => {
            object.position.y -= GROUND_REACH;
            object.updateWorldMatrix(true, true);
            const found = obstacles(this.bodyOf(object)!);
            object.position.y += GROUND_REACH;
            return found !== undefined;
        };
        // An object that walks (it has a step) keeps to the ground: down a slope and down the stairs it goes
        // with its feet on them, instead of walking off into the air and falling after
        let grounded = step > 0 && (x !== 0 || z !== 0) && standing();

        let free = true;
        for (const [axis, delta] of [["x", x], ["y", y], ["z", z]] as const) {
            if (delta === 0) continue;
            // A long way is gone in short steps, up to the first one that something stops
            const steps = Math.ceil(Math.abs(delta) / MAX_STEP);
            for (let i = 0; i < steps; i++) {
                object.position[axis] += delta / steps;
                object.updateWorldMatrix(true, true);
                // Sideways a body of the physics is not a wall: the object walks into it, and the physics
                // pushes it away. From above it is: the object can stand on it.
                const firm = axis === "y";
                const blocker = obstacles(this.bodyOf(object)!, firm);
                if (blocker) {
                    // Back to before the step, then as near to the obstacle as halving the step gets
                    let part = delta / steps;
                    object.position[axis] -= part;
                    // Unless it is low enough to step onto, or a slope to walk up
                    if (step > 0 && axis !== "y" && this.stepUp(object, axis, part, step, obstacles, blocker)) continue;
                    for (let n = 0; n < 6; n++) {
                        part /= 2;
                        object.position[axis] += part;
                        object.updateWorldMatrix(true, true);
                        if (obstacles(this.bodyOf(object)!, firm)) object.position[axis] -= part;
                    }
                    free = false;
                    break;
                }
                // Down onto the ground again, if it has gone from under its feet and is within a step
                if (grounded && axis !== "y") grounded = this.stepDown(object, step, obstacles);
            }
        }
        object.updateWorldMatrix(true, true);
        return free;
    }

    // An object that stands on something was stopped going `part` along `axis`: tries the same move
    // `height` higher and, if the way is free there, comes down onto what was in the way. false, with the
    // object left where it was, if it cannot.
    private stepUp(object: THREE.Object3D, axis: "x" | "z", part: number, height: number, obstacles: (moved: Body, firm?: boolean) => Body | undefined, blocker: Body) {
        const blocked = () => {
            object.updateWorldMatrix(true, true);
            return obstacles(this.bodyOf(object)!) !== undefined;
        };
        const from = object.position.y;
        // Only from the ground: a jump does not climb walls
        object.position.y -= GROUND_REACH;
        const standing = blocked();
        object.position.y += GROUND_REACH;
        if (!standing) return false;

        object.position.y += height;
        object.position[axis] += part;
        if (blocked()) {
            object.position.y -= height;
            object.position[axis] -= part;
            object.updateWorldMatrix(true, true);
            return false;
        }
        // Down onto the ledge: all the way if nothing is there, otherwise as near as halving gets
        object.position.y -= height;
        if (blocked()) {
            object.position.y += height;
            let drop = height;
            for (let n = 0; n < 6; n++) {
                drop /= 2;
                object.position.y -= drop;
                if (blocked()) object.position.y += drop;
            }
        }
        // A tilted box and the ground of a terrain are slopes, not stairs: too steep, and it is a wall after all
        const sloped = blocker.terrain || (blocker.oriented && Math.abs(blocker.oriented.axes[1].y) < 0.999);
        if (sloped && object.position.y - from > Math.abs(part) * MAX_SLOPE + 0.01) {
            object.position.y = from;
            object.position[axis] -= part;
            object.updateWorldMatrix(true, true);
            return false;
        }
        object.updateWorldMatrix(true, true);
        return true;
    }

    // An object that walked has no ground under it any more: if there is some within `height` below, it is
    // put down onto it (a slope going down, a stair). false, with the object left in the air, if there is none.
    private stepDown(object: THREE.Object3D, height: number, obstacles: (moved: Body, firm?: boolean) => Body | undefined) {
        const blocked = () => {
            object.updateWorldMatrix(true, true);
            return obstacles(this.bodyOf(object)!) !== undefined;
        };
        // Level ground: it is there already
        object.position.y -= GROUND_TOUCH;
        const there = blocked();
        object.position.y += GROUND_TOUCH;
        if (there) {
            object.updateWorldMatrix(true, true);
            return true;
        }
        object.position.y -= height;
        if (!blocked()) {
            object.position.y += height;
            object.updateWorldMatrix(true, true);
            return false;
        }
        object.position.y += height;
        let drop = height;
        // Near enough for the next fall() to find the ground in its first frame
        for (let n = 0; n < 8; n++) {
            drop /= 2;
            object.position.y -= drop;
            if (blocked()) object.position.y += drop;
        }
        object.updateWorldMatrix(true, true);
        return true;
    }

    // For an object with a solid collider: a test that tells whether its collider, wherever it has got to, is
    // stopped by another solid one. undefined if the object has no solid collider, so nothing stops it.
    private obstacles(object: THREE.Object3D) {
        // Where the object is now, not where it was drawn last: in the first frame nothing has been drawn
        // yet, and a collider taken from the origin would count as stuck in the floor and fall through it
        object.updateWorldMatrix(true, true);
        const mine = this.bodyOf(object);
        if (!mine?.solid) return undefined;
        const inside = new Set<THREE.Object3D>();
        object.traverse((obj) => inside.add(obj));
        const others = this.bodies().filter(
            (body) => body.solid && !inside.has(body.object) && this.registry.layersCollide(mine.layer, body.layer)
        );
        // What it is stuck in already does not hold it: otherwise it could never get out
        const stuck = new Set(others.filter((other) => overlaps(mine, other)));
        // A body too heavy to shove (settings.pushMass) is a wall
        const limit = this.registry.settings.pushMass;
        const yields = (other: Body) => other.dynamic && !(limit > 0 && other.mass > limit);
        // `firm`: the bodies of the physics count too (see move())
        // What stops the collider, if anything does
        return (moved: Body, firm = true) => others.find((other) => !stuck.has(other) && (firm || !yields(other)) && overlaps(moved, other));
    }

    // What a behavior calls as self.fall(): gravity, one frame of it
    fall(object: THREE.Object3D, dt: number, gravity = 20) {
        let speed = (this.speeds.get(object) ?? 0) - gravity * dt;
        const free = this.move(object, 0, speed * dt, 0);
        const standing = !free && speed < 0;
        // Stopped by the ground, or by a ceiling on the way up
        if (!free) speed = 0;
        this.speeds.set(object, speed);
        // What it stands on, and where that is: when it moves, the object goes with it (see ride())
        const support = standing ? this.under(object) : null;
        if (support) this.supports.set(object, { object: support, place: support.getWorldPosition(new THREE.Vector3()) });
        else this.supports.delete(object);
        return standing;
    }

    // The solid collider right under the object that the physics does not move: a floor, a platform
    private under(object: THREE.Object3D) {
        const mine = this.bodyOf(object);
        if (!mine?.solid) return null;
        const inside = new Set<THREE.Object3D>();
        object.traverse((obj) => inside.add(obj));
        const others = this.bodies().filter(
            (body) => body.solid && !body.dynamic && !inside.has(body.object) && this.registry.layersCollide(mine.layer, body.layer) && !overlaps(mine, body)
        );
        object.position.y -= GROUND_REACH;
        object.updateWorldMatrix(true, true);
        const lowered = this.bodyOf(object)!;
        const found = others.find((other) => overlaps(lowered, other));
        object.position.y += GROUND_REACH;
        object.updateWorldMatrix(true, true);
        return found?.object ?? null;
    }

    // An object that stood on something a frame ago goes where that has gone since: a lift takes it up
    // (instead of rising through it), a platform carries it sideways until a wall is in the way
    private ride(object: THREE.Object3D) {
        const support = this.supports.get(object);
        if (!support) return;
        if (!support.object.parent || !this.isActive(support.object)) {
            this.supports.delete(object);
            return;
        }
        const moved = support.object.getWorldPosition(new THREE.Vector3()).sub(support.place);
        if (moved.lengthSq() === 0) return;
        support.place.add(moved);
        // Further than a platform moves in a frame: it was put elsewhere, and its rider was not
        if (moved.length() > 1) return;
        // Up with it whatever is above; down and sideways only as far as nothing else is in the way
        if (moved.y > 0) object.position.y += moved.y;
        this.move(object, moved.x, Math.min(0, moved.y), moved.z);
    }

    // What a behavior calls as self.grounded(): is there a solid collider right under the object
    grounded(object: THREE.Object3D) {
        const obstacles = this.obstacles(object);
        if (!obstacles) return false;
        object.position.y -= GROUND_REACH;
        object.updateWorldMatrix(true, true);
        const standing = obstacles(this.bodyOf(object)!) !== undefined;
        object.position.y += GROUND_REACH;
        object.updateWorldMatrix(true, true);
        return standing;
    }

    // What a behavior calls as self.loadScene(): asks for another scene; it comes after this frame
    loadScene(name: string) {
        const known = this.registry.sceneNames();
        if (known.length > 0 && !known.includes(name)) {
            console.error(`loadScene: there is no scene "${name}" (scenes: ${known.join(", ")})`);
            return;
        }
        this.requestedScene = name;
    }

    // Starts the Sound component whose marker object this is, from the beginning
    private playSource(marker: THREE.Object3D) {
        const f = marker.userData.sound as { sound: string; volume: number; pitch: number; loop: boolean; music: boolean; spatial: boolean; range: number };
        this.sources.get(marker)?.stop();
        const { volume, pitch, loop, range } = f;
        if (f.music) {
            // The music is not this entity's to stop: it goes on without it, and into the next scene
            if (f.sound) this.sound.playMusic(f.sound, { volume, pitch });
            this.sources.set(marker, null);
            return;
        }
        this.sources.set(marker, f.sound ? this.sound.play(f.sound, { volume, pitch, loop, range, at: f.spatial ? marker : undefined }) : null);
    }

    // What a behavior calls as self.sound(): the Sound component of the object
    soundOf(object: THREE.Object3D): SoundSource | null {
        const marker = object.children.find((child) => child.userData.sound);
        if (!marker) return null;
        const { sources, sound } = this;
        const f = marker.userData.sound as { sound: string; music: boolean };
        return {
            play: () => this.playSource(marker),
            stop: () => (f.music ? sound.music === f.sound && sound.stopMusic() : sources.get(marker)?.stop()),
            get playing() {
                return f.music ? f.sound !== "" && sound.music === f.sound : sources.get(marker)?.playing ?? false;
            },
        };
    }

    // Starts the Sound components that have appeared (those set to play on start) and stops the ones whose
    // entities are gone or switched off; switched on again, such a sound starts anew
    private sounds() {
        const present = new Set<THREE.Object3D>();
        this.root.traverse((obj) => {
            if (!obj.userData.sound || !obj.parent || !this.isActive(obj.parent)) return;
            present.add(obj);
            if (this.sources.has(obj)) return;
            this.sources.set(obj, null);
            if (obj.userData.sound.autoplay) this.playSource(obj);
        });
        for (const [marker, playing] of this.sources) {
            if (present.has(marker)) continue;
            playing?.stop();
            this.sources.delete(marker);
        }
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
            const hit = rayBody(from, along, body, reach);
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

    private run(owner: THREE.Object3D, advance: Process["advance"]): Running {
        const process: Process = { owner, running: true, advance };
        this.processes.push(process);
        return {
            stop: () => {
                process.running = false;
            },
            get running() {
                return process.running;
            },
        };
    }

    // What a behavior calls as self.tween()
    tween(owner: THREE.Object3D, target: Record<string, number>, to: Record<string, number>, seconds: number, options: TweenOptions = {}) {
        const ease = EASES[options.ease ?? "linear"] ?? EASES.linear;
        const loop = options.loop ?? "none";
        let wait = options.delay ?? 0;
        let time = 0;
        // Where it starts from is what the numbers are when it starts, after the delay
        let from: Record<string, number> | null = null;
        return this.run(owner, (dt) => {
            if (wait > 0) {
                wait -= dt;
                if (wait > 0) return true;
                dt = -wait;
            }
            from ??= Object.fromEntries(Object.keys(to).map((key) => [key, Number(target[key]) || 0]));
            time += dt;
            let t = seconds > 0 ? time / seconds : 1;
            const over = t >= 1 && loop === "none";
            if (loop === "repeat") t %= 1;
            // There and back: 0..1, then 1..0
            else if (loop === "yoyo") t = 1 - Math.abs((t % 2) - 1);
            else t = Math.min(1, t);
            const k = ease(t);
            for (const key of Object.keys(to)) target[key] = from[key] + (to[key] - from[key]) * k;
            if (over) options.done?.();
            return !over;
        });
    }

    // What a behavior calls as self.after() and self.every()
    timer(owner: THREE.Object3D, seconds: number, call: () => void, repeat: boolean) {
        let left = seconds;
        return this.run(owner, (dt) => {
            left -= dt;
            if (left > 0) return true;
            call();
            // Never faster than once a frame
            left = Math.max(left + seconds, 0);
            return repeat;
        });
    }

    // Moves the tweens and timers on; a behavior on an inactive entity waits, and so do they
    private advance(dt: number) {
        // A plain loop: a timer may start another one
        for (let i = 0; i < this.processes.length; i++) {
            const process = this.processes[i];
            if (!process.running || !this.isActive(process.owner)) continue;
            try {
                process.running = process.advance(dt) && process.running;
            } catch (e) {
                process.running = false;
                console.error(`A tween or a timer of "${process.owner.name}" stopped:`, e);
                this.onError(`A tween or a timer of "${process.owner.name}" stopped: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        this.processes = this.processes.filter((process) => process.running);
    }

    // The behaviors that run on an object, with what they hold now: for whoever wants to look at a running
    // game (the editor shows it for the objects created in Play)
    behaviorsOf(object: THREE.Object3D) {
        return this.instances
            .filter((instance) => instance.self.object === object)
            .map((instance) => ({ name: instance.def.name, params: instance.self.params, state: instance.self.state, failed: instance.failed }));
    }

    // Something happened to the interface element of the object (a Button clicked, a Slider or an Input Field
    // changed, Enter in an Input Field): its behaviors are told through the hook of that name
    uiEvent(event: UiEvent) {
        for (const instance of [...this.instances]) {
            if (instance.self.object !== event.object || !instance.started || instance.failed) continue;
            try {
                if (event.hook === "click") instance.def.click?.(instance.self);
                else if (event.hook === "change") instance.def.change?.(instance.self, event.value!);
                else instance.def.submit?.(instance.self, String(event.value));
            } catch (e) {
                instance.failed = true;
                this.report(instance, e);
            }
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
            // A param of kind "object" is the name of an object in the data and the object itself for the
            // behavior: looked up when it is read, so one that was spawned later, or replaced, is found too
            for (const [key, param] of Object.entries(def.params ?? {})) {
                if (param.type !== "asset" || param.kind !== "object") continue;
                const name = self.params[key];
                let found: THREE.Object3D | null = null;
                Object.defineProperty(self.params, key, {
                    enumerable: true,
                    configurable: true,
                    get: () => {
                        if (typeof name !== "string" || !name) return null;
                        if (!found || found.name !== name || !this.isActive(found)) found = this.findAll({ name })[0] ?? null;
                        return found;
                    },
                });
            }
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
            this.processes = this.processes.filter((process) => !inside.has(process.owner));
            gone.forEach((instance) => this.end(instance));

            object.removeFromParent();
            disposeObject(object);
        }
    }

    start() {
        // A plain loop: a behavior may add objects, and with them instances, while this runs
        for (let i = 0; i < this.instances.length; i++) this.step(this.instances[i]);
        this.sweep();
        this.sounds();
    }

    update(dt: number) {
        this.time += dt;
        for (let i = 0; i < this.instances.length; i++) {
            const instance = this.instances[i];
            instance.self.time = this.time;
            this.step(instance, dt);
        }
        this.advance(dt);
        // The clips of the scripts move objects, like the tweens do
        updateAnimations(this.root, dt, (object) => this.isActive(object), this.registry);
        // The behaviors, the tweens and the clips have moved the platforms: what stands on them goes along
        for (const object of [...this.supports.keys()]) this.ride(object);
        // After the behaviors: what they have moved pushes the bodies in this same frame
        // A body that has fallen out of the world is gone
        for (const object of this.physics.step(this.root, dt, (object) => this.isActive(object))) this.destroy(object);
        this.collide();
        this.sweep();
        this.sounds();
        updateParticles(this.root, dt, (object) => this.isActive(object));
        updateModelFiles(this.root, dt, (object) => this.isActive(object));
    }

    // The scene stops: every behavior gets its destroy()
    dispose() {
        this.instances.forEach((instance) => this.end(instance));
        this.instances = [];
        this.doomed.clear();
        this.processes = [];
        this.contacts.clear();
        this.supports.clear();
        this.sources.forEach((playing) => playing?.stop());
        this.sources.clear();
    }
}
