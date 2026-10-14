import * as THREE from "three";
import { riverLevels, riverPath } from "../engine";
import type { RiverData } from "../engine";
import { EDITOR_LAYER } from "../editor/core/SceneStore";

// The rivers of the terrain being edited, shown over its ground while the River brush is in hand: the middle
// line of every river and a mark at each of its points. The brush tells which mark is picked and which one
// the mouse is over; it also moves them (see terrainBrush.ts).

// A point of a river: the number of the river in the list of the terrain, and of the point in it
export interface RiverMark {
    river: number;
    point: number;
}

// Meters the lines and the marks are over the water
const LIFT = 0.15;

const COLORS = {
    // The river the clicks go to, and the others
    line: new THREE.Color("#ffffff"),
    otherLine: new THREE.Color("#7fa8b8"),
    mark: new THREE.Color("#ffd54a"),
    otherMark: new THREE.Color("#8fb8c8"),
    picked: new THREE.Color("#ff5722"),
    hover: new THREE.Color("#ffffff"),
};

export class RiverView {
    // Lives in the scene of the editor, on the layer of its tools
    readonly group = new THREE.Group();

    // Drawn over everything: a river in a gorge would be lost behind its sides
    private lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, fog: false }));

    private marks = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ vertexColors: true, size: 11, sizeAttenuation: false, depthTest: false, transparent: true, fog: false }));

    // What is drawn now
    private shown = "";

    private rivers: RiverData[] | null = null;

    constructor() {
        for (const object of [this.lines, this.marks]) {
            object.layers.set(EDITOR_LAYER);
            object.frustumCulled = false;
            object.raycast = () => {};
            this.group.add(object);
        }
        this.lines.renderOrder = 1000;
        this.marks.renderOrder = 1001;
        this.group.visible = false;
    }

    // Where the marks of the rivers are in the world, river by river. `middle`: where the terrain stands.
    static places(rivers: RiverData[], middle: THREE.Vector3): THREE.Vector3[][] {
        return rivers.map((river) => {
            const levels = riverLevels(river);
            return river.points.map(([x, z], n) => new THREE.Vector3(middle.x + x, middle.y + levels[n] + LIFT, middle.z + z));
        });
    }

    // Call every frame. `rivers` null: nothing to show. `current`: the river the clicks go to and its picked
    // point (-1 for none); `hover`: the mark under the mouse.
    frame(rivers: RiverData[] | null, middle: THREE.Vector3, current: RiverMark, hover: RiverMark | null) {
        this.group.visible = !!rivers?.length;
        if (!rivers?.length) return;
        const shown = `${middle.toArray().join()} ${current.river} ${current.point} ${hover?.river} ${hover?.point}`;
        if (rivers === this.rivers && shown === this.shown) return;
        this.rivers = rivers;
        this.shown = shown;

        const positions: number[] = [];
        const colors: number[] = [];
        rivers.forEach((river, r) => {
            const color = r === current.river ? COLORS.line : COLORS.otherLine;
            const path = riverPath(river, 1);
            for (let n = 0; n < path.length - 1; n++) {
                for (const sample of [path[n], path[n + 1]]) {
                    positions.push(middle.x + sample.x, middle.y + sample.y + LIFT, middle.z + sample.z);
                    colors.push(color.r, color.g, color.b);
                }
            }
        });
        const marks: number[] = [];
        const markColors: number[] = [];
        RiverView.places(rivers, middle).forEach((places, r) => {
            places.forEach((place, n) => {
                const color = hover?.river === r && hover.point === n ? COLORS.hover : r !== current.river ? COLORS.otherMark : n === current.point ? COLORS.picked : COLORS.mark;
                marks.push(place.x, place.y, place.z);
                markColors.push(color.r, color.g, color.b);
            });
        });
        for (const [object, at, tint] of [[this.lines, positions, colors], [this.marks, marks, markColors]] as const) {
            object.geometry.setAttribute("position", new THREE.Float32BufferAttribute(at, 3));
            object.geometry.setAttribute("color", new THREE.Float32BufferAttribute(tint, 3));
        }
    }

    dispose() {
        for (const object of [this.lines, this.marks]) {
            object.geometry.dispose();
            (object.material as THREE.Material).dispose();
        }
        this.group.removeFromParent();
    }
}
