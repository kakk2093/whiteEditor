import * as THREE from "three";

// Particles: sparks, smoke, dust, rain. An entity with a Particles component is an emitter: it keeps making
// small flat dots that fly off, change their color and size, and die. They live in the world, not in the
// emitter: an emitter that moves leaves a trail.

// The fields of the Particles component, defaults filled in (see components.ts)
export interface ParticleFields {
    playing: boolean;
    rate: number;
    max: number;
    lifetime: number;
    speed: number;
    spread: number;
    radius: number;
    gravity: number;
    size: number;
    sizeEnd: number;
    color: string;
    colorEnd: string;
    opacity: number;
    fade: boolean;
    shape: string;
    additive: boolean;
}

// What a behavior gets from self.particles(): the emitter of an entity
export interface ParticleHandle {
    // Throws out this many at once: an explosion, a puff of dust under the feet
    emit: (count: number) => void;
    // The steady stream of the emitter (its `rate`) is on
    playing: boolean;
}

interface Emitter {
    fields: ParticleFields;
    // Per particle: how fast it flies, how long it has lived and how long it will
    velocity: Float32Array;
    age: Float32Array;
    life: Float32Array;
    // The slot the next particle takes; when all are taken the oldest goes
    next: number;
    // Particles of the stream that are due but not whole yet
    owed: number;
    from: THREE.Color;
    to: THREE.Color;
}

const SHAPES = ["square", "circle", "soft"];

const VERTEX = `
attribute vec4 aColor;
attribute float aSize;
uniform float uScale;
varying vec4 vColor;
void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // Sizes are in meters: farther is smaller, except for a camera without perspective
    gl_PointSize = aSize * uScale / (projectionMatrix[3][3] == 1.0 ? 1.0 : -mv.z);
}`;

const FRAGMENT = `
uniform int uShape;
varying vec4 vColor;
void main() {
    float d = distance(gl_PointCoord, vec2(0.5));
    float alpha = vColor.a;
    if (uShape == 1 && d > 0.5) discard;
    if (uShape == 2) alpha *= smoothstep(0.5, 0.0, d);
    if (alpha <= 0.0) discard;
    gl_FragColor = vec4(vColor.rgb, alpha);
    #include <colorspace_fragment>
}`;

const emitterOf = (object: THREE.Object3D) => object.userData.particles as Emitter | undefined;

// The three.js object of a Particles component
export function createParticles(fields: ParticleFields): THREE.Points {
    const count = Math.max(1, Math.round(fields.max));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(count * 4), 4));
    geometry.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(count), 1));

    const material = new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        uniforms: { uScale: { value: 1 }, uShape: { value: Math.max(0, SHAPES.indexOf(fields.shape)) } },
        transparent: true,
        depthWrite: false,
        blending: fields.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    const points = new THREE.Points(geometry, material);
    // The particles are all over the world, not where the emitter is
    points.frustumCulled = false;
    points.updateMatrixWorld = () => {
        points.matrixWorld.identity();
    };
    // They are not surfaces: a look that draws outlines by the normals does not see them
    points.userData.skipNormal = true;
    points.raycast = () => {};
    points.onBeforeRender = (renderer, _scene, camera) => {
        // Pixels per meter at a distance of one meter, for the picture that is being drawn now
        material.uniforms.uScale.value = (renderer.getCurrentViewport(new THREE.Vector4()).w * camera.projectionMatrix.elements[5]) / 2;
    };

    const emitter: Emitter = {
        fields,
        velocity: new Float32Array(count * 3),
        age: new Float32Array(count),
        life: new Float32Array(count),
        next: 0,
        owed: 0,
        from: new THREE.Color(fields.color),
        to: new THREE.Color(fields.colorEnd),
    };
    points.userData.particles = emitter;
    return points;
}

const origin = new THREE.Vector3();
const up = new THREE.Vector3();
const side = new THREE.Vector3();
const forward = new THREE.Vector3();

// Puts `count` new particles where the emitter is now
export function emitParticles(points: THREE.Object3D, count: number) {
    const emitter = emitterOf(points);
    const place = points.parent;
    if (!emitter || !place) return;
    const { fields } = emitter;
    const positions = (points as THREE.Points).geometry.getAttribute("position") as THREE.BufferAttribute;
    const total = emitter.age.length;

    place.updateWorldMatrix(true, false);
    origin.setFromMatrixPosition(place.matrixWorld);
    // They fly along the "up" of the emitter, within `spread` degrees of it
    side.setFromMatrixColumn(place.matrixWorld, 0).normalize();
    up.setFromMatrixColumn(place.matrixWorld, 1).normalize();
    forward.setFromMatrixColumn(place.matrixWorld, 2).normalize();
    const widest = THREE.MathUtils.degToRad(Math.min(180, Math.max(0, fields.spread)));

    for (let n = 0; n < count; n++) {
        const i = emitter.next;
        emitter.next = (emitter.next + 1) % total;

        const tilt = Math.acos(1 - Math.random() * (1 - Math.cos(widest)));
        const turn = Math.random() * Math.PI * 2;
        const across = Math.sin(tilt);
        const speed = fields.speed * (0.7 + Math.random() * 0.6);
        const dx = up.x * Math.cos(tilt) + (side.x * Math.cos(turn) + forward.x * Math.sin(turn)) * across;
        const dy = up.y * Math.cos(tilt) + (side.y * Math.cos(turn) + forward.y * Math.sin(turn)) * across;
        const dz = up.z * Math.cos(tilt) + (side.z * Math.cos(turn) + forward.z * Math.sin(turn)) * across;
        emitter.velocity.set([dx * speed, dy * speed, dz * speed], i * 3);

        // Anywhere within `radius` of the emitter
        const away = fields.radius * Math.cbrt(Math.random());
        const a = Math.random() * Math.PI * 2;
        const b = Math.acos(2 * Math.random() - 1);
        positions.setXYZ(i, origin.x + away * Math.sin(b) * Math.cos(a), origin.y + away * Math.cos(b), origin.z + away * Math.sin(b) * Math.sin(a));

        emitter.age[i] = 0;
        emitter.life[i] = Math.max(0.01, fields.lifetime * (0.7 + Math.random() * 0.6));
    }
}

// One frame for every emitter under `root`: new particles appear, the living ones move on, the old ones go.
// `active` tells whether an entity takes part; an emitter that does not keeps what it has, frozen.
export function updateParticles(root: THREE.Object3D, dt: number, active: (object: THREE.Object3D) => boolean = () => true) {
    root.traverse((points) => {
        const emitter = emitterOf(points);
        if (!emitter || !points.parent || !active(points.parent)) return;
        const { fields, velocity, age, life } = emitter;
        const geometry = (points as THREE.Points).geometry;
        const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
        const colors = geometry.getAttribute("aColor") as THREE.BufferAttribute;
        const sizes = geometry.getAttribute("aSize") as THREE.BufferAttribute;

        if (fields.playing) {
            emitter.owed += fields.rate * dt;
            const whole = Math.floor(emitter.owed);
            emitter.owed -= whole;
            if (whole > 0) emitParticles(points, Math.min(whole, age.length));
        }

        for (let i = 0; i < age.length; i++) {
            if (life[i] <= 0) continue;
            age[i] += dt;
            const t = age[i] / life[i];
            if (t >= 1) {
                // Dead: nothing of it is drawn
                life[i] = 0;
                sizes.setX(i, 0);
                colors.setW(i, 0);
                continue;
            }
            velocity[i * 3 + 1] -= fields.gravity * dt;
            positions.setXYZ(
                i,
                positions.getX(i) + velocity[i * 3] * dt,
                positions.getY(i) + velocity[i * 3 + 1] * dt,
                positions.getZ(i) + velocity[i * 3 + 2] * dt
            );
            sizes.setX(i, fields.size + (fields.sizeEnd - fields.size) * t);
            colors.setXYZW(
                i,
                emitter.from.r + (emitter.to.r - emitter.from.r) * t,
                emitter.from.g + (emitter.to.g - emitter.from.g) * t,
                emitter.from.b + (emitter.to.b - emitter.from.b) * t,
                fields.opacity * (fields.fade ? 1 - t : 1)
            );
        }
        positions.needsUpdate = true;
        colors.needsUpdate = true;
        sizes.needsUpdate = true;
    });
}

// The emitter of an entity object, for a behavior; null if it has no Particles component
export function particlesOf(object: THREE.Object3D): ParticleHandle | null {
    const points = object.children.find((child) => emitterOf(child));
    const emitter = points && emitterOf(points);
    if (!points || !emitter) return null;
    return {
        emit: (count) => emitParticles(points, Math.min(Math.max(0, Math.round(count)), emitter.age.length)),
        get playing() {
            return emitter.fields.playing;
        },
        set playing(on: boolean) {
            emitter.fields.playing = on;
        },
    };
}
