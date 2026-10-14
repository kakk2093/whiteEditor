import * as THREE from "three";
import type { ZoneFields } from "./environment";
import { riverDepthAt, riverFlowAt } from "./river";
import type { RiverMarker } from "./river";

// Water: a level surface over a piece of the world — a lake, a marsh, the sea around an island. The entity
// stands at the surface; whatever of the ground is lower than it is under water. The water stops nothing:
// what walks goes along the bottom. While the camera is below the surface (and not deeper than `depth`),
// the scene looks as it does under water: its own fog, light and, if named, look. That part is a Zone
// (see environment.ts), made by the same component.
//
// What is in the water can be kept afloat: a behavior by self.swim(), a body of the physics by its
// `buoyancy`. The surface may have waves; they only show.

// The fields of the Water component, defaults filled in (see components.ts)
export interface WaterFields {
    sizeX: number;
    sizeZ: number;
    depth: number;
    color: string;
    opacity: number;
    underColor: string;
    visibility: number;
    underLight: number;
    look: string;
    waves: number;
    waveLength: number;
    waveSpeed: number;
}

// What the object of a Water component carries in userData.water
export interface WaterMarker {
    sizeX: number;
    sizeZ: number;
    depth: number;
}

export function createWater(f: WaterFields): THREE.Group {
    const group = new THREE.Group();
    const marker: WaterMarker = { sizeX: f.sizeX, sizeZ: f.sizeZ, depth: f.depth };
    group.userData.water = marker;

    // The surface: seen from above and from below, and it does not hide what is in the water
    const material = new THREE.MeshStandardMaterial({
        color: f.color,
        opacity: f.opacity,
        transparent: f.opacity < 1,
        roughness: 0.15,
        side: THREE.DoubleSide,
        depthWrite: f.opacity >= 1,
    });
    // With waves the surface is cut fine enough to show them: four pieces to a wave, within reason
    const pieces = (size: number) => (f.waves > 0 ? Math.min(MAX_PIECES, Math.max(1, Math.ceil(size / Math.max(0.25, f.waveLength / 4)))) : 1);
    const surface = new THREE.Mesh(new THREE.PlaneGeometry(f.sizeX, f.sizeZ, pieces(f.sizeX), pieces(f.sizeZ)).rotateX(-Math.PI / 2), material);
    surface.receiveShadow = true;
    if (f.waves > 0) {
        // The waves only show: the water is as deep as if it were level
        let drawn = -1;
        surface.onBeforeRender = () => {
            // A frame may draw the scene more than once
            const time = Math.round(performance.now() / 16) * 0.016;
            if (time === drawn) return;
            drawn = time;
            wave(surface.geometry, f, time);
        };
    }
    group.add(surface);

    // Under the surface: a zone as wide as the water and as deep as it is said to be
    const under = new THREE.Object3D();
    under.position.y = -f.depth / 2;
    const zone: ZoneFields = {
        sizeX: f.sizeX,
        sizeY: f.depth,
        sizeZ: f.sizeZ,
        blend: 0.25,
        // The sky is not seen from under water
        sky: false,
        background: f.underColor,
        ambientColor: "#ffffff",
        ambientIntensity: f.underLight,
        fog: true,
        fogColor: f.underColor,
        fogNear: 0.5,
        fogFar: f.visibility,
        look: f.look,
    };
    under.userData.zone = zone;
    group.add(under);
    return group;
}

// The most pieces a side of a surface with waves is cut into
const MAX_PIECES = 96;

// Puts the vertices of a surface where its waves are at a time: two trains of waves that cross each other
function wave(geometry: THREE.BufferGeometry, f: WaterFields, time: number) {
    const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
    const normals = geometry.getAttribute("normal") as THREE.BufferAttribute;
    const k = (Math.PI * 2) / Math.max(0.25, f.waveLength);
    const t = time * f.waveSpeed * Math.sqrt(k * 9.8);
    // From the trough to the crest it is `waves` meters where the two trains meet
    const first = f.waves * 0.3;
    const second = f.waves * 0.2;
    for (let n = 0; n < positions.count; n++) {
        const x = positions.getX(n);
        const z = positions.getZ(n);
        const a = k * (x * 0.8 + z * 0.6) + t;
        const b = k * 1.7 * (z * 0.85 - x * 0.53) + t * 1.3;
        positions.setY(n, first * Math.sin(a) + second * Math.sin(b));
        // The slope of the surface along x and along z
        const dx = first * Math.cos(a) * k * 0.8 - second * Math.cos(b) * k * 1.7 * 0.53;
        const dz = first * Math.cos(a) * k * 0.6 + second * Math.cos(b) * k * 1.7 * 0.85;
        const length = Math.hypot(dx, 1, dz);
        normals.setXYZ(n, -dx / length, 1 / length, -dz / length);
    }
    positions.needsUpdate = true;
    normals.needsUpdate = true;
}

const local = new THREE.Vector3();
const inverse = new THREE.Matrix4();
const scale = new THREE.Vector3();

// How deep under the surface of a water (or of a river) a point of the world is, meters; 0 if it is in no water (above it,
// beside it, or deeper than the water goes). `active` tells whether an entity object takes part.
export function submergedAt(root: THREE.Object3D, point: THREE.Vector3, active: (object: THREE.Object3D) => boolean = () => true): number {
    let deepest = 0;
    root.traverse((object) => {
        // A river of a terrain: its water follows its bed
        const river = object.userData.river as RiverMarker | undefined;
        if (river) {
            // The group of the rivers and the mesh of the terrain are between it and its entity
            const entity = object.parent?.parent?.parent;
            if (entity && !active(entity)) return;
            local.copy(point).applyMatrix4(inverse.copy(object.matrixWorld).invert());
            deepest = Math.max(deepest, riverDepthAt(river, local.x, local.y, local.z));
            return;
        }
        const water = object.userData.water as WaterMarker | undefined;
        if (!water || !object.parent || !active(object.parent)) return;
        local.copy(point).applyMatrix4(inverse.copy(object.matrixWorld).invert());
        if (Math.abs(local.x) > water.sizeX / 2 || Math.abs(local.z) > water.sizeZ / 2 || local.y > 0 || local.y < -water.depth) return;
        // In meters of the world, whatever the size of the entity
        deepest = Math.max(deepest, -local.y * scale.setFromMatrixScale(object.matrixWorld).y);
    });
    return deepest;
}

// The current at a point of the world: where the water of a river carries what is in it there, and how
// fast, meters per second. Written into `target`; false (and zero) where nothing carries: out of the water,
// in a Water, in a river that stands still.
export function flowAt(root: THREE.Object3D, point: THREE.Vector3, target: THREE.Vector3, active: (object: THREE.Object3D) => boolean = () => true): boolean {
    let found = false;
    target.set(0, 0, 0);
    root.traverse((object) => {
        const river = object.userData.river as RiverMarker | undefined;
        if (!river || found) return;
        const entity = object.parent?.parent?.parent;
        if (entity && !active(entity)) return;
        local.copy(point).applyMatrix4(inverse.copy(object.matrixWorld).invert());
        const flow = riverFlowAt(river, local.x, local.y, local.z);
        if (!flow) return;
        // The river turns with its terrain
        target.set(flow[0], 0, flow[1]).transformDirection(object.matrixWorld).multiplyScalar(river.flow);
        found = true;
    });
    return found;
}
