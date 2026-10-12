import * as CANNON from "cannon-es";
import * as THREE from "three";
import type { Registry } from "./Registry";
import { DEFAULT_LAYER, layerOf } from "./settings";

// Real physics, by the cannon-es library: things fall, roll, push each other and bounce. All of the library
// is used in this file only.
//
// An entity with a Body component (and a solid Collider, which is its shape) is a dynamic body: the physics
// moves it. Every other solid collider is something the bodies run into, standing still or moved by a
// behavior (self.move): a floor, a wall, the player. Triggers are not a part of it.

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
    // The entity object, and the marker objects its body was made from
    object: THREE.Object3D;
    collider: THREE.Object3D;
    marker: THREE.Object3D | null;
    // What the shape depends on; another value means the body is made anew
    shape: string;
    // Where the physics has put the object (dynamic) or where it was seen last (the rest), in the world
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
}

// The steps the physics makes, however long a frame is
const STEP = 1 / 60;

const position = new THREE.Vector3();
const quaternion = new THREE.Quaternion();
const scale = new THREE.Vector3();

export class Physics {
    private registry: Registry;

    private world: CANNON.World;

    // By the entity object
    private tracked = new Map<THREE.Object3D, Tracked>();

    constructor(registry: Registry) {
        this.registry = registry;
        this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -registry.settings.gravity, 0) });
        // What has come to rest stays at rest until something moving touches it: a stack does not creep
        this.world.allowSleep = true;
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
            sleepSpeedLimit: 0.15,
            sleepTimeLimit: 0.5,
        });
        // The collider may stand aside from the middle of the entity
        const offset = new CANNON.Vec3(collider.position.x * Math.abs(scale.x), collider.position.y * Math.abs(scale.y), collider.position.z * Math.abs(scale.z));
        if (c.shape === "sphere") {
            body.addShape(new CANNON.Sphere(c.radius * Math.max(scale.x, scale.y, scale.z)), offset);
        } else if (c.shape === "capsule") {
            // A cylinder with a ball at each end
            const radius = c.radius * Math.max(scale.x, scale.z);
            const half = Math.max(0, (c.height * scale.y) / 2 - radius);
            if (half > 0) body.addShape(new CANNON.Cylinder(radius, radius, half * 2, 12), offset);
            body.addShape(new CANNON.Sphere(radius), new CANNON.Vec3(offset.x, offset.y + half, offset.z));
            if (half > 0) body.addShape(new CANNON.Sphere(radius), new CANNON.Vec3(offset.x, offset.y - half, offset.z));
        } else {
            body.addShape(new CANNON.Box(new CANNON.Vec3((c.sizeX * scale.x) / 2, (c.sizeY * scale.y) / 2, (c.sizeZ * scale.z) / 2)), offset);
        }
        if (b && !b.gravity) {
            // Its own pull upwards, as strong as the gravity of the world
            body.addEventListener("preStep", () => body.applyForce(new CANNON.Vec3(0, -this.world.gravity.y * body.mass, 0)));
        }

        const entry: Tracked = { body, object, collider, marker, shape, position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
        object.getWorldPosition(entry.position);
        object.getWorldQuaternion(entry.quaternion);
        body.position.set(entry.position.x, entry.position.y, entry.position.z);
        body.quaternion.set(entry.quaternion.x, entry.quaternion.y, entry.quaternion.z, entry.quaternion.w);
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
        }
        // Nothing for the physics to move: the scene is as it was without it
        if (dynamic === 0 || dt <= 0) return [];
        const fallen: THREE.Object3D[] = [];

        for (const entry of this.tracked.values()) {
            const { body, object } = entry;
            object.getWorldPosition(position);
            object.getWorldQuaternion(quaternion);
            const moved = position.distanceToSquared(entry.position) > 1e-10 || Math.abs(quaternion.dot(entry.quaternion)) < 1 - 1e-9;
            if (entry.marker) {
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
                body.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
                entry.position.copy(position);
                entry.quaternion.copy(quaternion);
            }
        }

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
