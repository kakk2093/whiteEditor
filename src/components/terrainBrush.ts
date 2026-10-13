import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { brushRegion, brushTerrain, DEFAULT_PALETTE, eraseScatter, generateTerrain, generatorOf, plantScatter, updateScatter, fillTerrainGeometry, forgetTerrainRange, isPainted, rayTerrain, terrainHeight } from "../engine";
import type { TerrainData, TerrainMarker, TerrainRegion } from "../engine";
import { strokeTerrain } from "../editor/core/actions";
import { EDITOR_LAYER, sceneStore } from "../editor/core/SceneStore";

// The brush of "Edit Terrain": while it is on, a ring on the ground of the selected terrain follows the
// mouse, and holding the left button works the ground under it: raises, lowers, smooths, levels or paints
// it. Shift turns "raise" into "lower" and back. A stroke changes a copy of the ground, which the meshes
// show at once; when the button goes up, the copy becomes the terrain (one step of undo) and is written to
// its file.
//
// The copy shares with the ground it was made from every row of heights the stroke has not touched: a row is
// copied the first time the brush reaches it. So a stroke on a big ground starts at once, and the steps of
// undo, each of which keeps a whole ground, keep only what the strokes have changed.

// Points of the ring
const RING = 64;

// "smooth" and "flatten" get this much of the way there in a second at strength 1
const SETTLE = 1.5;

export class TerrainBrush {
    // Lives in the scene of the editor, on the layer of its tools
    readonly group = new THREE.Group();

    // true from a press that began a stroke until the next press: that click must not select something else
    grabbed = false;

    private ring: THREE.LineLoop;

    private raycaster = new THREE.Raycaster();

    private camera: THREE.Camera;

    private dom: HTMLElement;

    private controls: OrbitControls;

    // Where the mouse is over the view, -1 to 1; null while it is elsewhere
    private mouse: THREE.Vector2 | null = null;

    private shift = false;

    // The stroke in progress: the terrain as it was, the copy being worked, the meshes that show it
    private stroke: {
        name: string;
        before: TerrainData;
        data: TerrainData;
        meshes: THREE.Mesh[];
        // The height "flatten" levels to: the one under the brush when the stroke began
        level: number;
        changed: boolean;
        // The rows of heights and of colors that are the stroke's own by now, by their number
        heights: Set<number>;
        colors: Set<number>;
        // All of the ground the stroke has reached so far
        region: TerrainRegion | null;
        // "plant": the part of a prop that is due, carried over from frame to frame
        due: number;
    } | null = null;

    constructor(camera: THREE.Camera, dom: HTMLElement, controls: OrbitControls) {
        this.camera = camera;
        this.dom = dom;
        this.controls = controls;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(RING * 3), 3));
        // Drawn over everything: behind a hill the ring would be lost
        this.ring = new THREE.LineLoop(geometry, new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, fog: false }));
        this.ring.layers.set(EDITOR_LAYER);
        this.ring.renderOrder = 1000;
        this.ring.frustumCulled = false;
        this.ring.visible = false;
        this.group.add(this.ring);
        // Before the camera controls hear of the press: a stroke must not turn the camera
        dom.addEventListener("pointerdown", this.onDown, true);
        dom.addEventListener("pointermove", this.onMove);
        dom.addEventListener("pointerleave", this.onLeave);
        dom.addEventListener("pointerup", this.onUp);
        dom.addEventListener("pointercancel", this.onUp);
    }

    // The terrain being edited: its asset and the mesh of the selected entity; null while the brush is off
    private target() {
        if (!sceneStore.terrainEdit || sceneStore.playing || sceneStore.gameView) return null;
        const target = sceneStore.terrainTarget;
        const data = target && sceneStore.registry.getTerrain(target.name);
        return target && data ? { ...target, data } : null;
    }

    // Where the mouse points on the ground, x and z from the middle of the terrain; null if not at it
    private point(data: TerrainData, mesh: THREE.Object3D) {
        if (!this.mouse) return null;
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const { origin, direction } = this.raycaster.ray;
        const middle = mesh.getWorldPosition(new THREE.Vector3());
        const from = origin.clone().sub(middle);
        const hit = rayTerrain(data, from, direction);
        return hit ? from.addScaledVector(direction, hit.distance) : null;
    }

    private place(e: PointerEvent) {
        const rect = this.dom.getBoundingClientRect();
        this.mouse = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
        this.shift = e.shiftKey;
    }

    private onDown = (e: PointerEvent) => {
        this.grabbed = false;
        if (e.button !== 0) return;
        const target = this.target();
        if (!target) return;
        this.place(e);
        const at = this.point(target.data, target.mesh);
        // A press past the ground turns the camera as usual
        if (!at) return;

        // The lists of rows are the stroke's own, the rows are not yet (see the top of the file)
        const data: TerrainData = { ...target.data, heights: [...target.data.heights], ...(target.data.colors ? { colors: [...target.data.colors] } : {}) };
        const colors = new Set<number>();
        // The first paint of a ground that had none: all of it is the first color of the usual palette
        if ((sceneStore.brush.tool === "paint" || (sceneStore.brush.tool === "generate" && (generatorOf(data).paint || generatorOf(data).biome))) && !isPainted(data)) {
            data.palette = data.palette?.length ? data.palette : [...DEFAULT_PALETTE];
            data.colors = data.heights.map((row) => row.map(() => 0));
            data.colors.forEach((_, j) => colors.add(j));
        }
        const meshes = sceneStore.terrainMeshes(target.name);
        for (const mesh of meshes) (mesh.userData.terrain as TerrainMarker).data = data;
        // The lists of the props are the stroke's own from the start: they are short
        const { tool } = sceneStore.brush;
        // A biome may add its colors to the palette, and is written into the map of the biomes
        if (tool === "generate") {
            if (data.palette) data.palette = [...data.palette];
            if (data.biomes) data.biomes = [...data.biomes];
            if (data.biomeMap) data.biomeMap = data.biomeMap.map((row) => [...row]);
        }
        if ((tool === "plant" || tool === "erase") && data.scatter) data.scatter = data.scatter.map((layer) => ({ prefab: layer.prefab, items: [...layer.items] }));
        // The first touch plants at once
        this.stroke = { name: target.name, before: target.data, data, meshes, level: at.y, changed: false, heights: new Set(), colors, region: null, due: 1 };
        this.grabbed = true;
        this.controls.enabled = false;
        this.dom.setPointerCapture(e.pointerId);
        // A click without a move is a touch too
        this.frame(1 / 30);
    };

    private onMove = (e: PointerEvent) => {
        this.place(e);
    };

    private onLeave = () => {
        if (!this.stroke) this.mouse = null;
    };

    private onUp = (e: PointerEvent) => {
        const { stroke } = this;
        if (!stroke) return;
        this.stroke = null;
        this.controls.enabled = !sceneStore.gameView;
        if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
        if (!stroke.changed) {
            for (const mesh of stroke.meshes) (mesh.userData.terrain as TerrainMarker).data = stroke.before;
            return;
        }
        // Centimeters are enough, and keep the file readable
        for (const j of stroke.heights) {
            const row = stroke.data.heights[j];
            for (let i = 0; i < row.length; i++) row[i] = Math.round(row[i] * 100) / 100;
        }
        forgetTerrainRange(stroke.data);
        if (stroke.region) this.show(stroke.meshes, stroke.data, stroke.region);
        strokeTerrain(stroke.name, stroke.before, stroke.data);
        // Painted for the first time: the material of the ground is another one from now on
        if (isPainted(stroke.data) !== isPainted(stroke.before)) sceneStore.setRegistry(sceneStore.registry);
    };

    // `region`: only that part of the ground has changed
    private show(meshes: THREE.Mesh[], data: TerrainData, region?: TerrainRegion) {
        for (const mesh of meshes) {
            fillTerrainGeometry(mesh.geometry, data, (mesh.userData.terrain as TerrainMarker).flat, region);
            // The props stand on the ground: they go up and down with it (and a biome puts its own)
            updateScatter(mesh, sceneStore.registry, data);
        }
    }

    // The props have changed, the ground has not
    private showProps(meshes: THREE.Mesh[], data: TerrainData) {
        for (const mesh of meshes) updateScatter(mesh, sceneStore.registry, data);
    }

    // Call every frame: the ring follows the mouse, a stroke in progress works the ground under it
    frame(dt: number) {
        const target = this.target();
        const data = this.stroke?.data ?? target?.data;
        const at = target && data ? this.point(data, target.mesh) : null;
        this.ring.visible = !!at;
        if (!target || !data || !at) return;
        const { tool, radius, strength, color } = sceneStore.brush;

        if (this.stroke && (tool === "plant" || tool === "erase")) {
            const { stroke } = this;
            const { prefab, spacing, sizeMin, sizeMax } = sceneStore.brush;
            // Shift turns planting into taking away what was planted of that prefab
            if (tool === "erase" || this.shift) {
                if (eraseScatter(data, at.x, at.z, radius, tool === "erase" ? undefined : prefab) > 0) stroke.changed = true;
            } else if (prefab) {
                // So many tries a second for every 100 square meters of the brush; the spacing does the rest
                stroke.due += strength * dt * Math.max(1, (Math.PI * radius * radius) / 100);
                const tries = Math.floor(stroke.due);
                stroke.due -= tries;
                if (tries > 0 && plantScatter(data, prefab, at.x, at.z, radius, tries, { spacing, sizeMin, sizeMax }) > 0) stroke.changed = true;
            }
            if (stroke.changed) this.showProps(stroke.meshes, data);
        } else if (this.stroke && tool !== "plant" && tool !== "erase") {
            const used = this.shift && tool === "raise" ? "lower" : this.shift && tool === "lower" ? "raise" : tool;
            const amount = used === "raise" || used === "lower" ? strength * dt : strength * SETTLE * dt;
            const region = brushRegion(data, at.x, at.z, radius);
            if (region) {
                // The rows the touch is about to change become the stroke's own
                const { stroke } = this;
                for (const [rows, owned] of [[used === "paint" ? undefined : data.heights, stroke.heights], [used === "paint" || used === "generate" ? data.colors : undefined, stroke.colors]] as const) {
                    for (let j = region.fromJ; rows && j <= region.toJ; j++) {
                        if (owned.has(j)) continue;
                        owned.add(j);
                        rows[j] = [...rows[j]];
                    }
                }
                const middle = target.mesh.getWorldPosition(new THREE.Vector3());
                const changed = used === "generate"
                    ? !!generateTerrain(data, generatorOf(data), middle, { x: at.x, z: at.z, radius, amount }, sceneStore.registry.getBiome(generatorOf(data).biome))
                    : brushTerrain(data, used, at.x, at.z, radius, amount, { level: stroke.level, color });
                if (changed) {
                    stroke.changed = true;
                    stroke.region = stroke.region
                        ? { fromI: Math.min(stroke.region.fromI, region.fromI), toI: Math.max(stroke.region.toI, region.toI), fromJ: Math.min(stroke.region.fromJ, region.fromJ), toJ: Math.max(stroke.region.toJ, region.toJ) }
                        : region;
                    this.show(stroke.meshes, data, region);
                }
            }
        }

        // The ring lies on the ground, a little over it
        const middle = target.mesh.getWorldPosition(new THREE.Vector3());
        const positions = this.ring.geometry.getAttribute("position") as THREE.BufferAttribute;
        for (let n = 0; n < RING; n++) {
            const angle = (n / RING) * Math.PI * 2;
            const x = at.x + Math.cos(angle) * radius;
            const z = at.z + Math.sin(angle) * radius;
            positions.setXYZ(n, middle.x + x, middle.y + (terrainHeight(data, x, z) ?? at.y) + 0.05, middle.z + z);
        }
        positions.needsUpdate = true;
    }

    dispose() {
        this.dom.removeEventListener("pointerdown", this.onDown, true);
        this.dom.removeEventListener("pointermove", this.onMove);
        this.dom.removeEventListener("pointerleave", this.onLeave);
        this.dom.removeEventListener("pointerup", this.onUp);
        this.dom.removeEventListener("pointercancel", this.onUp);
        this.group.removeFromParent();
        this.ring.geometry.dispose();
        (this.ring.material as THREE.Material).dispose();
    }
}
