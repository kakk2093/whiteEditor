import * as THREE from "three";
import type { ZoneFields } from "./environment";
import { defaultBiome } from "./generate";
import type { BiomeData } from "./generate";
import type { Registry } from "./Registry";
import { terrainHeight } from "./terrain";
import type { TerrainMarker } from "./terrain";

// The air of a biome: a land may have its own fog and light (and look), seen while the camera is over it —
// the haze of a swamp, the clear cold air of the mountains. It may color the sky of the scene too. A biome says so in its "air" fields; where the
// biome lies is what the map of the terrain says. It works as a zone does (see environment.ts), only a weak
// one: a Zone component, water or a river the camera is in comes first.

// Seconds the air of one land takes to become the air of the next
const AIR_BLEND = 2;

// Meters over the ground up to which the air of a land is its own: higher up it is the air of the scene
const AIR_HEIGHT = 40;

// What a biome with air changes of the environment; null if it has none of its own
export function biomeAir(biome: BiomeData | undefined): ZoneFields | null {
    if (!biome?.air) return null;
    const land = { ...defaultBiome, ...biome };
    return {
        sizeX: 0,
        sizeY: 0,
        sizeZ: 0,
        blend: AIR_BLEND,
        background: land.fogColor,
        ambientColor: land.ambientColor,
        ambientIntensity: land.ambientIntensity,
        fog: true,
        fogColor: land.fogColor,
        fogNear: land.fogNear,
        fogFar: land.fogFar,
        look: land.look,
        ...(land.sky ? { skyTop: land.skyTop, skyHorizon: land.skyHorizon, skyGround: land.skyGround } : {}),
    };
}

const local = new THREE.Vector3();
const middle = new THREE.Vector3();

// The object that gives the air of the biomes of a terrain; it goes under the mesh of the terrain
export function createBiomeAir(registry: Registry, mesh: THREE.Object3D): THREE.Object3D {
    const marker = new THREE.Object3D();
    marker.userData.zoneWeak = true;
    marker.userData.zoneOf = (point: THREE.Vector3): ZoneFields | null => {
        // As the ground is now: a brush may have changed it in place
        const { data } = mesh.userData.terrain as TerrainMarker;
        if (!data.biomeMap || !data.biomes) return null;
        local.copy(point).sub(mesh.getWorldPosition(middle));
        const ground = terrainHeight(data, local.x, local.z);
        if (ground === null || local.y > ground + AIR_HEIGHT) return null;
        const i = Math.round(local.x / data.cell + (data.heights[0].length - 1) / 2);
        const j = Math.round(local.z / data.cell + (data.heights.length - 1) / 2);
        return biomeAir(registry.getBiome(data.biomes[data.biomeMap[j]?.[i]]));
    };
    return marker;
}
