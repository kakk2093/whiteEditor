import * as THREE from "three";

// A rectangle on the screen in the units of the camera: x and y from -1 to 1, y up
export interface ScreenRect {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

const box = new THREE.Box3();
const corner = new THREE.Vector3();

// Whether the box, as the camera sees it, touches the rectangle
function touches(camera: THREE.Camera, rect: ScreenRect) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < 8; i++) {
        corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
        // A corner behind the camera has no place on the screen
        corner.applyMatrix4(camera.matrixWorldInverse);
        if (corner.z > 0) continue;
        corner.applyMatrix4(camera.projectionMatrix);
        minX = Math.min(minX, corner.x);
        minY = Math.min(minY, corner.y);
        maxX = Math.max(maxX, corner.x);
        maxY = Math.max(maxY, corner.y);
    }
    return minX <= rect.maxX && maxX >= rect.minX && minY <= rect.maxY && maxY >= rect.minY;
}

// Whether the rectangle touches something the entity itself draws. Each part is tried by its own box: one box
// around all of them would take a prefab instance by the empty space between its parts. The entities under
// this one are not a part of it: a parent must not get selected just because its child is in the frame.
function inRect(entity: THREE.Object3D, camera: THREE.Camera, rect: ScreenRect) {
    const visit = (obj: THREE.Object3D, helper: boolean): boolean => {
        if (!obj.visible) return false;
        if (obj !== entity && obj.userData.entityId) return false;
        helper = helper || !!obj.userData.editorHelper;
        const geometry = (obj as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
        // Of the editor's own marks only the clickable ones count: the outline of a collider is not
        if (geometry && (!helper || (obj as THREE.Mesh).isMesh)) {
            if (!geometry.boundingBox) geometry.computeBoundingBox();
            if (geometry.boundingBox && !geometry.boundingBox.isEmpty()) {
                box.copy(geometry.boundingBox).applyMatrix4(obj.matrixWorld);
                if (touches(camera, rect)) return true;
            }
        }
        return obj.children.some((child) => visit(child, helper));
    };
    return visit(entity, false);
}

// The ids of the entities under `root` that the rectangle on the screen touches, in the order of the tree.
// Like in Unity, what is hidden behind another object is selected too.
export function entitiesInRect(root: THREE.Object3D, camera: THREE.Camera, rect: ScreenRect): string[] {
    root.updateMatrixWorld();
    camera.updateMatrixWorld();
    const ids: string[] = [];
    const visit = (obj: THREE.Object3D) => {
        if (!obj.visible) return;
        if (obj.userData.entityId && inRect(obj, camera, rect)) ids.push(obj.userData.entityId);
        for (const child of obj.children) visit(child);
    };
    for (const child of root.children) visit(child);
    return ids;
}
