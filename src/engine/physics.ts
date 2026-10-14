import * as CANNON from "cannon-es";
import * as THREE from "three";
import type { Registry } from "./Registry";
import { scatterColliders } from "./scatter";
import { DEFAULT_LAYER, layerOf } from "./settings";
import { terrainHeight, terrainSize } from "./terrain";
import { flowAt, submergedAt } from "./water";
import { groundEntity } from "./world";
import type { TerrainData, TerrainMarker } from "./terrain";

// Real physics, by the cannon-es library: things fall, roll, push each other and bounce. All of the library
// is used in this file only.
//
// An entity with a Body component (and a solid Collider, which is its shape) is a dynamic body: the physics
// moves it. Every other solid collider is something the bodies run into, standing still or moved by a
// behavior (self.move): a floor, a wall, the player. Triggers are not a part of it. The ground of a Terrain
// component is such a thing as well, in the shape of its heights.
//
// The props of a terrain (see scatter.ts) stand in the way of the bodies too, by the solid Collider of the
// root of their prefab. There are thousands of them, and the library tests every body against every other:
// so a prop has a body only while something the physics moves is near it.

// The fields of the Collider and Body components, defaults filled in (see components.ts)
interface ColliderFields {
    shape: string;
    sizeX: number;
    sizeY: number;
    sizeZ: number;
    radius: number;
    height: number;
    solid: boolean;
    layer?: unknown;
}

interface BodyFields {
    mass: number;
    friction: number;
    bounce: number;
    damping: number;
    lockRotation: boolean;
    gravity: boolean;
    buoyancy: number;
}

// What a behavior gets from self.body(): the physical body of an entity
export interface BodyHandle {
    // Meters per second, in the world
    readonly velocity: THREE.Vector3;
    setVelocity: (x: number, y: number, z: number) => void;
    // A sudden shove: changes the velocity by this much divided by the mass
    push: (x: number, y: number, z: number) => void;
    // Turns per second around the axes of the world, in radians
    setSpin: (x: number, y: number, z: number) => void;
}

interface Tracked {
    body: CANNON.Body;
    // The entity object, and the marker objects its body was made from (for a terrain, its mesh)
    object: THREE.Object3D;
    collider: THREE.Object3D;
    marker: THREE.Object3D | null;
    // What the shape depends on; another value means the body is made anew
    shape: string;
    // Where the physics has put the object (dynamic) or where it was seen last (the rest), in the world
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    // How much of the body is under water now, 0 to 1 (a body with buoyancy)
    sunk: number;
    // Where the water it is in carries it, meters per second (a river)
    flow: THREE.Vector3;
    // The forces of its own the body gets before every small step of the physics
    forces: (() => void)[];
}

// How fast water takes the speed of what is in it, a part of it per second
const WATER_DRAG = 2.5;

// The steps the physics makes, however long a frame is
const STEP = 1 / 60;

// The props of a terrain are kept by squares of this many meters
const PROP_SQUARE = 8;

// A prop of a terrain as the physics needs it: the collider of one copy of a prefab
interface Prop {
    fields: ColliderFields;
    // From the middle of the terrain
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    scale: THREE.Vector3;
}

// The props of one ground: all of them by the squares they reach into, and those that have a body now
interface Props {
    // What they were taken from: another list means they are taken again
    scatter: unknown;
    squares: Map<number, Prop[]>;
    live: Map<Prop, CANNON.Body>;
}

const square = (x: number, z: number) => (Math.floor(x / PROP_SQUARE) + 32768) * 65536 + Math.floor(z / PROP_SQUARE) + 32768;

const position = new THREE.Vector3();
const quaternion = new THREE.Quaternion();
const scale = new THREE.Vector3();

// The point of the triangle a, b, c that is nearest to p (Ericson, Real-Time Collision Detection)
function nearestOnTriangle(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, target: THREE.Vector3) {
    const ab = b.clone().sub(a);
    const ac = c.clone().sub(a);
    const ap = p.clone().sub(a);
    const d1 = ab.dot(ap);
    const d2 = ac.dot(ap);
    if (d1 <= 0 && d2 <= 0) return target.copy(a);
    const bp = p.clone().sub(b);
    const d3 = ab.dot(bp);
    const d4 = ac.dot(bp);
    if (d3 >= 0 && d4 <= d3) return target.copy(b);
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return target.copy(a).addScaledVector(ab, d1 / (d1 - d3));
    const cp = p.clone().sub(c);
    const d5 = ab.dot(cp);
    const d6 = ac.dot(cp);
    if (d6 >= 0 && d5 <= d6) return target.copy(c);
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return target.copy(a).addScaledVector(ac, d2 / (d2 - d6));
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return target.copy(b).addScaledVector(c.clone().sub(b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
    const denominator = 1 / (va + vb + vc);
    return target.copy(a).addScaledVector(ab, vb * denominator).addScaledVector(ac, vc * denominator);
}

// Where a ball touches the ground of a terrain: the points of the ground nearest to its middle that are
// within its radius, one for every side it leans on (in a gully there are two). `center` is counted from
// the middle of the terrain. A ball whose middle is under the ground is pushed straight up.
function ballOnTerrain(data: TerrainData, center: THREE.Vector3, radius: number): { point: THREE.Vector3; normal: THREE.Vector3 }[] {
    const rows = data.heights.length - 1;
    const columns = data.heights[0].length - 1;
    const u = center.x / data.cell + columns / 2;
    const v = center.z / data.cell + rows / 2;
    const span = radius / data.cell;
    const touches: { point: THREE.Vector3; normal: THREE.Vector3; depth: number }[] = [];
    const corner = (i: number, j: number) => new THREE.Vector3((i - columns / 2) * data.cell, data.heights[j][i], (j - rows / 2) * data.cell);
    const nearest = new THREE.Vector3();
    for (let j = Math.max(0, Math.floor(v - span)); j <= Math.min(rows - 1, Math.floor(v + span)); j++) {
        for (let i = Math.max(0, Math.floor(u - span)); i <= Math.min(columns - 1, Math.floor(u + span)); i++) {
            const a = corner(i, j);
            const d = corner(i + 1, j + 1);
            // The two triangles of the cell, cut the way terrain.ts cuts it
            for (const other of [corner(i + 1, j), corner(i, j + 1)]) {
                nearest.copy(nearestOnTriangle(center, a, d, other, nearest));
                const distance = nearest.distanceTo(center);
                if (distance >= radius) continue;
                // Neighbor triangles share the point on their common edge: it is one touch, not two
                if (touches.some((touch) => touch.point.distanceToSquared(nearest) < 1e-8)) continue;
                const normal = distance > 1e-6 ? center.clone().sub(nearest).divideScalar(distance) : new THREE.Vector3(0, 1, 0);
                touches.push({ point: nearest.clone(), normal, depth: radius - distance });
            }
        }
    }
    const under = terrainHeight(data, center.x, center.z);
    if (under !== null && under > center.y) return [{ point: new THREE.Vector3(center.x, under, center.z), normal: new THREE.Vector3(0, 1, 0) }];
    return touches;
}

// What the narrowphase of the library is called with for a ball and a field of heights
type BallOnHeights = (
    ball: CANNON.Sphere, field: CANNON.Heightfield, ballAt: CANNON.Vec3, fieldAt: CANNON.Vec3, ballTurn: CANNON.Quaternion, fieldTurn: CANNON.Quaternion,
    ballBody: CANNON.Body, fieldBody: CANNON.Body, first?: CANNON.Shape, second?: CANNON.Shape, justTest?: boolean,
) => boolean | void;

// The parts of the narrowphase of the library that a test of our own has to use
interface Narrowphase {
    sphereHeightfield: BallOnHeights;
    result: CANNON.ContactEquation[];
    frictionResult: CANNON.FrictionEquation[];
    createContactEquation: (a: CANNON.Body, b: CANNON.Body, first: CANNON.Shape, second: CANNON.Shape, firstOverride?: CANNON.Shape, secondOverride?: CANNON.Shape) => CANNON.ContactEquation;
    createFrictionEquationsFromContact: (contact: CANNON.ContactEquation, result: CANNON.FrictionEquation[]) => void;
}

// A ball on a terrain is tested here, not by the library. The library takes the ground as a pillar under
// every triangle and looks at the corners of a pillar before its top: a ball that comes down right over a
// height of the grid hangs on that corner as on a spike and never rolls off, and one that rolls over the
// edges between the triangles is slowed and pushed aside by them.
function installBallOnTerrain(world: CANNON.World) {
    const narrowphase = world.narrowphase as unknown as Narrowphase;
    const usual = narrowphase.sphereHeightfield;
    const center = new THREE.Vector3();
    narrowphase.sphereHeightfield = function ballOnHeights(this: Narrowphase, ball, field, ballAt, fieldAt, ballTurn, fieldTurn, ballBody, fieldBody, first, second, justTest) {
        const data = (field as unknown as { terrain?: TerrainData }).terrain;
        if (!data) return usual.call(this, ball, field, ballAt, fieldAt, ballTurn, fieldTurn, ballBody, fieldBody, first, second, justTest);
        // The body of a terrain is at the middle of it, and is never turned
        center.set(ballAt.x - fieldBody.position.x, ballAt.y - fieldBody.position.y, ballAt.z - fieldBody.position.z);
        const touches = ballOnTerrain(data, center, ball.radius);
        if (justTest) return touches.length > 0;
        for (const { point, normal } of touches) {
            const contact = this.createContactEquation(ballBody, fieldBody, ball, field, first, second);
            // From the ball into the ground
            contact.ni.set(-normal.x, -normal.y, -normal.z);
            contact.ri.set(ballAt.x - ballBody.position.x - normal.x * ball.radius, ballAt.y - ballBody.position.y - normal.y * ball.radius, ballAt.z - ballBody.position.z - normal.z * ball.radius);
            contact.rj.set(point.x, point.y, point.z);
            this.result.push(contact);
            this.createFrictionEquationsFromContact(contact, this.frictionResult);
        }
        return undefined;
    };
}

export class Physics {
    private registry: Registry;

    private world: CANNON.World;

    // By the entity object; a terrain by its mesh, so that an entity may have a Collider next to it
    private tracked = new Map<THREE.Object3D, Tracked>();

    // The props of the grounds, by the mesh of the terrain
    private props = new Map<THREE.Object3D, Props>();

    constructor(registry: Registry) {
        this.registry = registry;
        this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -registry.settings.gravity, 0) });
        // What has come to rest stays at rest until something moving touches it: a stack does not creep
        this.world.allowSleep = true;
        installBallOnTerrain(this.world);
        // The library clears the forces after every small step, and tells only the world that one begins
        this.world.addEventListener("preStep", () => {
            for (const entry of this.tracked.values()) for (const force of entry.forces) force();
        });
    }

    // Number of bodies the physics moves, as of the last step
    get count() {
        return [...this.tracked.values()].filter((entry) => entry.marker).length;
    }

    // The physical body of an entity object; null if it has no Body component (or the scene has not made a step yet)
    handle(object: THREE.Object3D): BodyHandle | null {
        const entry = this.tracked.get(object);
        if (!entry?.marker) return null;
        const { body } = entry;
        return {
            get velocity() {
                return new THREE.Vector3(body.velocity.x, body.velocity.y, body.velocity.z);
            },
            setVelocity: (x, y, z) => {
                body.velocity.set(x, y, z);
                body.wakeUp();
            },
            push: (x, y, z) => {
                body.applyImpulse(new CANNON.Vec3(x, y, z));
                body.wakeUp();
            },
            setSpin: (x, y, z) => {
                body.angularVelocity.set(x, y, z);
                body.wakeUp();
            },
        };
    }

    // What the body of a terrain depends on, besides its heights (those come with a new mesh)
    private groundKey(mesh: THREE.Object3D) {
        return String(layerOf((mesh.userData.terrain as TerrainMarker).layer));
    }

    // Colliders of layers that are set not to collide do not touch in the physics either: a layer is a bit
    private filter(layer: string) {
        const layers = [DEFAULT_LAYER, ...this.registry.settings.layers].slice(0, 31);
        const index = Math.max(0, layers.indexOf(layer));
        let mask = 0;
        layers.forEach((other, i) => {
            if (this.registry.layersCollide(layer, other)) mask |= 1 << i;
        });
        return { group: 1 << index, mask };
    }

    private create(object: THREE.Object3D, collider: THREE.Object3D, marker: THREE.Object3D | null, shape: string): Tracked {
        const c = collider.userData.collider as ColliderFields;
        const b = marker?.userData.body as BodyFields | undefined;
        collider.matrixWorld.decompose(position, quaternion, scale);

        // What is not a body takes the friction and the bounce of the body that touches it: the two are multiplied
        const material = new CANNON.Material({ friction: b ? b.friction : 1, restitution: b ? b.bounce : 1 });
        const { group, mask } = this.filter(layerOf(c.layer));
        const body = new CANNON.Body({
            mass: b ? b.mass : 0,
            type: b ? CANNON.Body.DYNAMIC : CANNON.Body.KINEMATIC,
            material,
            linearDamping: b ? b.damping : 0,
            angularDamping: b ? b.damping : 0,
            fixedRotation: b?.lockRotation ?? false,
            collisionFilterGroup: group,
            collisionFilterMask: mask,
            // Only what the physics moves may fall asleep: a sleeping body pushes nothing, and what a behavior
            // moves (a player who stood still for a moment) must push the bodies in its way when it goes on
            allowSleep: !!b,
            sleepSpeedLimit: 0.15,
            sleepTimeLimit: 0.5,
        });
        // The collider may stand aside from the middle of the entity
        const offset = new CANNON.Vec3(collider.position.x * Math.abs(scale.x), collider.position.y * Math.abs(scale.y), collider.position.z * Math.abs(scale.z));
        this.addShapes(body, c, scale, offset);
        const entry: Tracked = { body, object, collider, marker, shape, position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), sunk: 0, flow: new THREE.Vector3(), forces: [] };
        if (b && !b.gravity) {
            // Its own pull upwards, as strong as the gravity of the world
            entry.forces.push(() => body.applyForce(new CANNON.Vec3(0, -this.world.gravity.y * body.mass, 0)));
        }
        if (b && b.buoyancy > 0) {
            // The water lifts what is in it, and slows it down: to a stop, or to the speed the water runs with
            entry.forces.push(() => {
                if (entry.sunk <= 0) return;
                body.applyForce(new CANNON.Vec3(0, -this.world.gravity.y * body.mass * b.buoyancy * entry.sunk, 0));
                const keep = Math.max(0, 1 - WATER_DRAG * entry.sunk * STEP);
                const { flow } = entry;
                body.velocity.set(flow.x + (body.velocity.x - flow.x) * keep, body.velocity.y * keep, flow.z + (body.velocity.z - flow.z) * keep);
                body.angularVelocity.scale(keep, body.angularVelocity);
            });
        }
        object.getWorldPosition(entry.position);
        object.getWorldQuaternion(entry.quaternion);
        body.position.set(entry.position.x, entry.position.y, entry.position.z);
        body.quaternion.set(entry.quaternion.x, entry.quaternion.y, entry.quaternion.z, entry.quaternion.w);
        this.world.addBody(body);
        return entry;
    }

    // The shape of a collider, as big as `size` makes it, `offset` away from the middle of the body
    private addShapes(body: CANNON.Body, c: ColliderFields, size: THREE.Vector3, offset: CANNON.Vec3) {
        if (c.shape === "sphere") {
            body.addShape(new CANNON.Sphere(c.radius * Math.max(size.x, size.y, size.z)), offset);
        } else if (c.shape === "capsule") {
            // A cylinder with a ball at each end
            const radius = c.radius * Math.max(size.x, size.z);
            const half = Math.max(0, (c.height * size.y) / 2 - radius);
            if (half > 0) body.addShape(new CANNON.Cylinder(radius, radius, half * 2, 12), offset);
            body.addShape(new CANNON.Sphere(radius), new CANNON.Vec3(offset.x, offset.y + half, offset.z));
            if (half > 0) body.addShape(new CANNON.Sphere(radius), new CANNON.Vec3(offset.x, offset.y - half, offset.z));
        } else {
            body.addShape(new CANNON.Box(new CANNON.Vec3((c.sizeX * size.x) / 2, (c.sizeY * size.y) / 2, (c.sizeZ * size.z) / 2)), offset);
        }
    }

    // The props of a ground, by the squares they reach into
    private propsOf(mesh: THREE.Object3D): Props {
        const { data } = mesh.userData.terrain as TerrainMarker;
        const known = this.props.get(mesh);
        if (known && known.scatter === data.scatter) return known;
        if (known) for (const body of known.live.values()) this.world.removeBody(body);
        const props: Props = { scatter: data.scatter, squares: new Map(), live: new Map() };
        for (const { fields, matrix } of data.scatter?.length ? scatterColliders(this.registry, data) : []) {
            const prop: Prop = { fields: fields as unknown as ColliderFields, position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3() };
            matrix.decompose(prop.position, prop.quaternion, prop.scale);
            // As far as the collider can reach from its middle, whatever its shape
            const c = prop.fields;
            const reach = Math.hypot(Math.max(c.sizeX, c.radius * 2) * prop.scale.x, Math.max(c.sizeY, c.height, c.radius * 2) * prop.scale.y, Math.max(c.sizeZ, c.radius * 2) * prop.scale.z) / 2;
            for (let x = prop.position.x - reach; x < prop.position.x + reach + PROP_SQUARE; x += PROP_SQUARE) {
                for (let z = prop.position.z - reach; z < prop.position.z + reach + PROP_SQUARE; z += PROP_SQUARE) {
                    const key = square(Math.min(x, prop.position.x + reach), Math.min(z, prop.position.z + reach));
                    const list = props.squares.get(key);
                    if (!list) props.squares.set(key, [prop]);
                    else if (!list.includes(prop)) list.push(prop);
                }
            }
        }
        this.props.set(mesh, props);
        return props;
    }

    // The props near what the physics moves get bodies, those that nothing is near any more lose theirs
    private wakeProps(dt: number) {
        for (const [mesh, ground] of this.tracked) {
            if (!mesh.userData.terrain) continue;
            const props = this.propsOf(mesh);
            if (props.squares.size === 0) continue;
            const near = new Set<Prop>();
            for (const entry of this.tracked.values()) {
                if (!entry.marker) continue;
                const { body } = entry;
                // Where the body is and where it can get in this frame, from the middle of the terrain
                const reach = body.boundingRadius + body.velocity.length() * dt + 1;
                const x = body.position.x - ground.position.x;
                const z = body.position.z - ground.position.z;
                for (let sx = Math.floor((x - reach) / PROP_SQUARE); sx <= Math.floor((x + reach) / PROP_SQUARE); sx++) {
                    for (let sz = Math.floor((z - reach) / PROP_SQUARE); sz <= Math.floor((z + reach) / PROP_SQUARE); sz++) {
                        for (const prop of props.squares.get(square(sx * PROP_SQUARE, sz * PROP_SQUARE)) ?? []) near.add(prop);
                    }
                }
            }
            for (const [prop, body] of props.live) {
                if (near.has(prop)) continue;
                this.world.removeBody(body);
                props.live.delete(prop);
            }
            for (const prop of near) {
                if (props.live.has(prop)) continue;
                const { group, mask } = this.filter(layerOf(prop.fields.layer));
                const body = new CANNON.Body({
                    mass: 0,
                    type: CANNON.Body.STATIC,
                    material: new CANNON.Material({ friction: 1, restitution: 1 }),
                    collisionFilterGroup: group,
                    collisionFilterMask: mask,
                });
                this.addShapes(body, prop.fields, prop.scale, new CANNON.Vec3());
                body.position.set(ground.position.x + prop.position.x, ground.position.y + prop.position.y, ground.position.z + prop.position.z);
                body.quaternion.set(prop.quaternion.x, prop.quaternion.y, prop.quaternion.z, prop.quaternion.w);
                this.world.addBody(body);
                props.live.set(prop, body);
            }
        }
    }

    // How many props have a body now: only those near what the physics moves
    get liveProps() {
        let count = 0;
        for (const props of this.props.values()) count += props.live.size;
        return count;
    }

    // The ground of a Terrain component: a field of heights that stands still
    private createGround(mesh: THREE.Object3D): Tracked {
        const { data, layer } = mesh.userData.terrain as TerrainMarker;
        // The entity (a piece of a World lies one group deeper); the ground is where its mesh is
        const object = groundEntity(mesh);
        const { group, mask } = this.filter(layerOf(layer));
        const body = new CANNON.Body({
            mass: 0,
            type: CANNON.Body.KINEMATIC,
            material: new CANNON.Material({ friction: 1, restitution: 1 }),
            collisionFilterGroup: group,
            collisionFilterMask: mask,
            allowSleep: false,
        });
        // The library has the heights as columns along its X, each going along its Y, with Z up, from a
        // corner. Laid down, its Y is the -Z of the world: so a column is read from the far row to the near
        // one, and the corner is the one of the lowest x and the highest z. It cuts a cell in two the same
        // way the mesh does (see terrain.ts).
        const rows = data.heights.length;
        const columns = data.heights[0].length;
        const heights: number[][] = [];
        for (let i = 0; i < columns; i++) {
            heights.push(Array.from({ length: rows }, (_, k) => data.heights[rows - 1 - k][i]));
        }
        const [width, depth] = terrainSize(data);
        const field = new CANNON.Heightfield(heights, { elementSize: data.cell });
        // For the test of a ball on it (see installBallOnTerrain)
        (field as unknown as { terrain: TerrainData }).terrain = data;
        body.addShape(
            field,
            new CANNON.Vec3(-width / 2, 0, depth / 2),
            new CANNON.Quaternion().setFromEuler(-Math.PI / 2, 0, 0),
        );
        const entry: Tracked = { body, object, collider: mesh, marker: null, shape: "", position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), sunk: 0, flow: new THREE.Vector3(), forces: [] };
        mesh.getWorldPosition(entry.position);
        // Never turned, whatever the entity says: the collisions of the behaviors see it the same way
        body.position.set(entry.position.x, entry.position.y, entry.position.z);
        this.world.addBody(body);
        return entry;
    }

    // One frame of physics for the entity objects under `root`. `active` tells whether an entity takes part.
    // Returns the bodies that have fallen below the bottom of the world (settings.bottom): whoever runs the
    // scene removes them.
    step(root: THREE.Object3D, dt: number, active: (object: THREE.Object3D) => boolean): THREE.Object3D[] {
        root.updateMatrixWorld();
        this.world.gravity.set(0, -this.registry.settings.gravity, 0);

        // The bodies follow the scene: new colliders get theirs, changed ones are made anew, gone ones are removed
        const present = new Set<THREE.Object3D>();
        let dynamic = 0;
        root.traverse((collider) => {
            if (collider.userData.terrain && collider.parent && active(collider.parent)) {
                present.add(collider);
                const entry = this.tracked.get(collider);
                if (entry && entry.shape === this.groundKey(collider)) return;
                if (entry) this.world.removeBody(entry.body);
                const made = this.createGround(collider);
                made.shape = this.groundKey(collider);
                this.tracked.set(collider, made);
                return;
            }
            const fields = collider.userData.collider as ColliderFields | undefined;
            const object = collider.parent;
            if (!fields?.solid || !object || !active(object)) return;
            const marker = object.children.find((child) => child.userData.body) ?? null;
            if (marker) dynamic++;
            present.add(object);
            collider.matrixWorld.decompose(position, quaternion, scale);
            const shape = JSON.stringify([fields, marker?.userData.body, collider.position.toArray(), scale.toArray().map((n) => Math.round(n * 1000))]);
            const entry = this.tracked.get(object);
            if (entry && entry.shape === shape && entry.collider === collider && entry.marker === marker) return;
            if (entry) this.world.removeBody(entry.body);
            const made = this.create(object, collider, marker, shape);
            // Made anew (a field was edited during Play): it keeps moving as it did
            if (entry && marker) {
                made.body.velocity.copy(entry.body.velocity);
                made.body.angularVelocity.copy(entry.body.angularVelocity);
            }
            this.tracked.set(object, made);
        });
        for (const [object, entry] of this.tracked) {
            if (present.has(object)) continue;
            this.world.removeBody(entry.body);
            this.tracked.delete(object);
            // A ground that is gone takes its props with it
            for (const body of this.props.get(object)?.live.values() ?? []) this.world.removeBody(body);
            this.props.delete(object);
        }
        // Nothing for the physics to move: the scene is as it was without it
        if (dynamic === 0 || dt <= 0) return [];
        const fallen: THREE.Object3D[] = [];

        for (const entry of this.tracked.values()) {
            const { body, object } = entry;
            // A ground is where its mesh is: a piece of a World stands aside from its entity
            const placed = entry.collider.userData.terrain ? entry.collider : object;
            placed.getWorldPosition(position);
            placed.getWorldQuaternion(quaternion);
            const moved = position.distanceToSquared(entry.position) > 1e-10 || Math.abs(quaternion.dot(entry.quaternion)) < 1 - 1e-9;
            if (entry.marker) {
                // How much of it is in the water: by how deep its lowest point is
                if ((entry.marker.userData.body as BodyFields).buoyancy > 0) {
                    // As tall as it stands now: a raft lies flat, a pole may stand on its end
                    body.updateAABB();
                    const tall = body.aabb.upperBound.y - body.aabb.lowerBound.y;
                    const deep = submergedAt(root, position.set(body.position.x, body.aabb.lowerBound.y, body.position.z), active);
                    entry.sunk = tall > 0 ? Math.min(1, deep / tall) : 0;
                    if (entry.sunk > 0) flowAt(root, position, entry.flow, active);
                    else entry.flow.set(0, 0, 0);
                    // What floats is never at rest for the physics: the water under it may be gone
                    if (entry.sunk > 0) body.wakeUp();
                    object.getWorldPosition(position);
                }
                // A behavior has put the body elsewhere: it goes on from there
                if (moved) {
                    body.position.set(position.x, position.y, position.z);
                    body.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
                    body.wakeUp();
                }
            } else {
                // What a behavior moves gets there during the step, at the speed it moves with: that is what
                // pushes the bodies in its way. A jump of more than a meter is not a move: it is just there.
                const jumped = position.distanceToSquared(entry.position) > 1;
                if (jumped) {
                    body.position.set(position.x, position.y, position.z);
                    body.velocity.set(0, 0, 0);
                } else {
                    body.position.set(entry.position.x, entry.position.y, entry.position.z);
                    body.velocity.set((position.x - entry.position.x) / dt, (position.y - entry.position.y) / dt, (position.z - entry.position.z) / dt);
                }
                if (!entry.collider.userData.terrain) body.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
                entry.position.copy(position);
                entry.quaternion.copy(quaternion);
            }
        }

        this.wakeProps(dt);
        this.world.step(STEP, dt, 5);

        for (const entry of this.tracked.values()) {
            const { body, object } = entry;
            if (!entry.marker) {
                // It has arrived: it does not keep sliding on in the next small step
                body.velocity.set(0, 0, 0);
                continue;
            }
            entry.position.set(body.position.x, body.position.y, body.position.z);
            entry.quaternion.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
            if (entry.position.y < this.registry.settings.bottom) fallen.push(object);
            // The place of the body is in the world, the place of the object is in its parent
            object.position.copy(entry.position);
            object.quaternion.copy(entry.quaternion);
            if (object.parent) {
                object.parent.worldToLocal(object.position);
                object.quaternion.premultiply(object.parent.getWorldQuaternion(quaternion).invert());
            }
            object.updateMatrixWorld(true);
        }
        return fallen;
    }
}
