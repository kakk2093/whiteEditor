import * as THREE from "three";
import type { TerrainData, TerrainMarker, TerrainRegion } from "../engine";
import { EDITOR_LAYER, sceneStore } from "../editor/core/SceneStore";

// The map of the biomes of the selected terrain, shown in color over its ground: every biome has a color of
// its own, ground that is no one's shows as it is. On while the store asks for it (`biomeView`) or while the
// Biome brush is in hand.
//
// It is a second mesh on the layer of the editor that shares the positions (and the index) of the mesh of
// the ground, so it follows whatever a brush does to the ground by itself; only the colors are its own.

// The colors of the biomes, by their place in the list of the ground; more biomes than colors go round
export const BIOME_COLORS = ["#4caf50", "#2196f3", "#ff9800", "#e91e63", "#9c27b0", "#00bcd4", "#ffeb3b", "#795548", "#f44336", "#3f51b5"];

export function biomeColor(k: number) {
    return BIOME_COLORS[k % BIOME_COLORS.length];
}

// How much of the ground shows through the color
const OPACITY = 0.55;

export class BiomeView {
    // Lives in the scene of the editor
    readonly group = new THREE.Group();

    private mesh: THREE.Mesh | null = null;

    // What the colors were last written from
    private shown: { geometry: THREE.BufferGeometry; flat: boolean; data: TerrainData | null; map: number[][] | null } | null = null;

    private material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });

    // The ground whose map is to be shown now, if any
    private target() {
        if (sceneStore.playing || sceneStore.gameView) return null;
        if (!sceneStore.biomeView && !(sceneStore.terrainEdit && sceneStore.brush.tool === "biome")) return null;
        const mesh = sceneStore.terrainTarget?.mesh;
        const marker = mesh?.userData.terrain as TerrainMarker | undefined;
        return mesh && marker?.data.biomeMap ? { mesh, marker, map: marker.data.biomeMap } : null;
    }

    private clear() {
        if (!this.mesh) return;
        // The positions and the index belong to the mesh of the ground: they must not be freed with this one
        this.mesh.geometry.deleteAttribute("position");
        this.mesh.geometry.setIndex(null);
        this.mesh.geometry.dispose();
        this.mesh.removeFromParent();
        this.mesh = null;
        this.shown = null;
    }

    // Writes the colors of the rows `fromJ` to `toJ` of the map (all of them without a region)
    private fill(data: TerrainData, flat: boolean, region?: TerrainRegion) {
        const map = data.biomeMap;
        if (!this.mesh || !map) return;
        const rows = map.length;
        const columns = map[0].length;
        const attribute = this.mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
        const colors = attribute.array as Float32Array;
        const palette = (data.biomes ?? []).map((_, k) => new THREE.Color(biomeColor(k)));
        const put = (n: number, i: number, j: number) => {
            const color = palette[map[j][i]];
            colors[n] = color?.r ?? 0;
            colors[n + 1] = color?.g ?? 0;
            colors[n + 2] = color?.b ?? 0;
            colors[n + 3] = color ? OPACITY : 0;
        };
        let start = 0;
        let count = colors.length;
        if (!flat) {
            const fromJ = region?.fromJ ?? 0;
            const toJ = region?.toJ ?? rows - 1;
            for (let j = fromJ; j <= toJ; j++) {
                for (let i = 0; i < columns; i++) put((j * columns + i) * 4, i, j);
            }
            start = fromJ * columns * 4;
            count = (toJ - fromJ + 1) * columns * 4;
        } else {
            // Six vertices to a cell, in the order of terrainGeometry()
            const fromJ = Math.max(0, (region?.fromJ ?? 0) - 1);
            const toJ = Math.min(rows - 2, region?.toJ ?? rows - 2);
            for (let j = fromJ; j <= toJ; j++) {
                for (let i = 0; i < columns - 1; i++) {
                    let n = (j * (columns - 1) + i) * 24;
                    for (const [ci, cj] of [[i, j], [i + 1, j + 1], [i + 1, j], [i, j], [i, j + 1], [i + 1, j + 1]]) {
                        put(n, ci, cj);
                        n += 4;
                    }
                }
            }
            start = fromJ * (columns - 1) * 24;
            count = Math.max(0, toJ - fromJ + 1) * (columns - 1) * 24;
        }
        attribute.clearUpdateRanges();
        if (region) attribute.addUpdateRange(start, count);
        attribute.needsUpdate = true;
    }

    // A brush has changed the map within this part of the ground
    paint(region: TerrainRegion) {
        const target = this.target();
        // Another map (the first biome of a ground, the copy of a stroke): frame() writes all of it
        if (!target || !this.shown || this.shown.map !== target.map || this.shown.geometry !== target.mesh.geometry) return;
        this.fill(target.marker.data, target.marker.flat, region);
    }

    // Call every frame, before the scene is drawn
    frame() {
        const target = this.target();
        if (!target) {
            this.clear();
            return;
        }
        const { mesh, marker, map } = target;
        if (!this.shown || this.shown.geometry !== mesh.geometry || this.shown.flat !== marker.flat) {
            this.clear();
            const geometry = new THREE.BufferGeometry();
            const positions = mesh.geometry.getAttribute("position");
            geometry.setAttribute("position", positions);
            geometry.setIndex(mesh.geometry.getIndex());
            geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(positions.count * 4), 4));
            this.mesh = new THREE.Mesh(geometry, this.material);
            this.mesh.layers.set(EDITOR_LAYER);
            // The ground is there to be seen whatever the camera looks at, and a click goes through to it
            this.mesh.frustumCulled = false;
            this.mesh.raycast = () => {};
            this.group.add(this.mesh);
            this.shown = { geometry: mesh.geometry, flat: marker.flat, data: null, map: null };
        }
        if (this.shown.data !== marker.data || this.shown.map !== map) {
            this.fill(marker.data, marker.flat);
            this.shown.data = marker.data;
            this.shown.map = map;
        }
        mesh.getWorldPosition(this.mesh!.position);
    }

    dispose() {
        this.clear();
        this.material.dispose();
        this.group.removeFromParent();
    }
}
