import * as THREE from "three";

type Listener = () => void;

class SceneStore {
    scene: THREE.Scene;

    objects: THREE.Object3D[] = [];

    selected: THREE.Object3D | null = null;

    private listeners: Listener[] = [];

    constructor() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x222222);
        
        // Initialize initial cube
        this.createCube();
    }

    subscribe(fn: Listener) {
        this.listeners.push(fn);
        return () => {
            this.listeners = this.listeners.filter(l => l !== fn);
        };
    }

    private notify() {
        this.listeners.forEach((fn) => fn());
    }

    addObject(obj: THREE.Object3D) {
        this.objects.push(obj);
        this.scene.add(obj);
        this.notify();
    }

    removeObject(obj: THREE.Object3D) {
        const index = this.objects.indexOf(obj);
        if (index > -1) {
            this.objects.splice(index, 1);
            this.scene.remove(obj);
            if (this.selected === obj) {
                this.selected = null;
            }
            this.notify();
        }
    }

    select(obj: THREE.Object3D | null) {
        this.selected = obj;
        this.notify();
    }

    updateObject() {
        this.notify();
    }

    createCube() {
        const cube = new THREE.Mesh(
            new THREE.BoxGeometry(),
            new THREE.MeshStandardMaterial({ color: 0x00ff00 })
        );
        cube.name = `Cube_${Date.now()}`;
        this.addObject(cube);
        return cube;
    }

    createSphere() {
        const sphere = new THREE.Mesh(
            new THREE.SphereGeometry(0.5, 32, 32),
            new THREE.MeshStandardMaterial({ color: 0xff0000 })
        );
        sphere.name = `Sphere_${Date.now()}`;
        this.addObject(sphere);
        return sphere;
    }
}

export const sceneStore = new SceneStore();