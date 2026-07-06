import * as THREE from "three";

export class GameObject {
    id: string;
    name: string;
    object3D: THREE.Object3D;

    constructor(name: string, object3D: THREE.Object3D) {
        this.id = crypto.randomUUID();
        this.name = name;
        this.object3D = object3D;
        this.object3D.name = name;
    }
}