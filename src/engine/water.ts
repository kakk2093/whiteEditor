import * as THREE from "three";
import type { ZoneFields } from "./environment";

// Water: a level surface over a piece of the world — a lake, a marsh, the sea around an island. The entity
// stands at the surface; whatever of the ground is lower than it is under water. The water stops nothing:
// what walks goes along the bottom. While the camera is below the surface (and not deeper than `depth`),
// the scene looks as it does under water: its own fog, light and, if named, look. That part is a Zone
// (see environment.ts), made by the same component.

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
    const surface = new THREE.Mesh(new THREE.PlaneGeometry(f.sizeX, f.sizeZ).rotateX(-Math.PI / 2), material);
    surface.receiveShadow = true;
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

const local = new THREE.Vector3();
const inverse = new THREE.Matrix4();
const scale = new THREE.Vector3();

// How deep under the surface of a water a point of the world is, meters; 0 if it is in no water (above it,
// beside it, or deeper than the water goes). `active` tells whether an entity object takes part.
export function submergedAt(root: THREE.Object3D, point: THREE.Vector3, active: (object: THREE.Object3D) => boolean = () => true): number {
    let deepest = 0;
    root.traverse((object) => {
        const water = object.userData.water as WaterMarker | undefined;
        if (!water || !object.parent || !active(object.parent)) return;
        local.copy(point).applyMatrix4(inverse.copy(object.matrixWorld).invert());
        if (Math.abs(local.x) > water.sizeX / 2 || Math.abs(local.z) > water.sizeZ / 2 || local.y > 0 || local.y < -water.depth) return;
        // In meters of the world, whatever the size of the entity
        deepest = Math.max(deepest, -local.y * scale.setFromMatrixScale(object.matrixWorld).y);
    });
    return deepest;
}
