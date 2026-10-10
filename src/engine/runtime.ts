import * as THREE from "three";
import { paramDefaults } from "./Registry";
import type { BehaviorDef, BehaviorSelf, Registry } from "./Registry";
import type { ComponentData, Params } from "./types";

interface Instance {
    def: BehaviorDef;
    // The script component the behavior was created from
    component: ComponentData;
    // component.params that self.params was made of; another object means the params were edited
    source: unknown;
    self: BehaviorSelf;
    started: boolean;
    // Set after start() or update() threw: the behavior is left alone from then on
    failed: boolean;
}

// Runs the behaviors (script components) of a built scene.
// Game side:
//   const level = loadScene(registry, json); scene.add(level);
//   const runtime = new Runtime(registry, level); runtime.start();
//   every frame: runtime.update(dt);
export class Runtime {
    // Seconds since start()
    time = 0;

    // Called with a readable message when a behavior throws; the error itself goes to the console
    onError: (message: string) => void = () => {};

    private instances: Instance[] = [];

    private registry: Registry;

    private root: THREE.Object3D;

    constructor(registry: Registry, root: THREE.Object3D) {
        this.registry = registry;
        this.root = root;
        root.traverse((obj) => this.attach(obj));
    }

    // Number of behaviors in the scene
    get count() {
        return this.instances.length;
    }

    // Creates the behaviors of one entity object that do not exist yet
    private attach(obj: THREE.Object3D) {
        for (const component of (obj.userData.scripts ?? []) as ComponentData[]) {
            if (this.instances.some((i) => i.self.object === obj && i.component === component)) continue;

            const name = component.script as string;
            const def = this.registry.getBehavior(name);
            if (!def) {
                console.warn(`Unknown behavior "${name}"`);
                continue;
            }
            const self: BehaviorSelf = { object: obj, params: {}, state: undefined, root: this.root, registry: this.registry, time: this.time };
            // `source` differs from any component.params, so the first step fills self.params
            this.instances.push({ def, component, source: null, self, started: false, failed: false });
        }
    }

    // The script components of the object were added or removed while the scene is running (the editor does
    // that during Play). New behaviors start on the next update.
    refresh(obj: THREE.Object3D) {
        const scripts = (obj.userData.scripts ?? []) as ComponentData[];
        this.instances = this.instances.filter((i) => i.self.object !== obj || scripts.includes(i.component));
        this.attach(obj);
    }

    // An inactive entity is hidden with its children, and their behaviors wait until it is shown
    private isActive(obj: THREE.Object3D) {
        for (let o: THREE.Object3D | null = obj; o; o = o.parent) {
            if (!o.visible) return false;
            if (o === this.root) return true;
        }
        // Removed from the scene
        return false;
    }

    // Starts the behavior if it has not started yet, then updates it when `dt` is given
    private step(instance: Instance, dt?: number) {
        const { def, component, self } = instance;
        if (instance.failed || !this.isActive(self.object)) return;

        // Params are read from the component, so a value edited during Play applies at once
        if (instance.source !== component.params) {
            instance.source = component.params;
            self.params = { ...paramDefaults(def.params ?? {}), ...(component.params as Params | undefined) };
        }

        try {
            if (!instance.started) {
                instance.started = true;
                self.state = def.start?.(self);
            }
            if (dt !== undefined) def.update?.(self, dt);
        } catch (e) {
            instance.failed = true;
            console.error(e);
            const message = e instanceof Error ? e.message : String(e);
            this.onError(`Script "${def.name}" on "${self.object.name}" stopped: ${message}`);
        }
    }

    start() {
        // A plain loop: a behavior may add objects, and with them instances, while this runs
        for (let i = 0; i < this.instances.length; i++) this.step(this.instances[i]);
    }

    update(dt: number) {
        this.time += dt;
        for (let i = 0; i < this.instances.length; i++) {
            const instance = this.instances[i];
            instance.self.time = this.time;
            this.step(instance, dt);
        }
    }
}
