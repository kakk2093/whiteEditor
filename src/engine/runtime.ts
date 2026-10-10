import * as THREE from "three";
import { paramDefaults } from "./Registry";
import type { BehaviorDef, BehaviorSelf, Registry } from "./Registry";
import type { ComponentData, Params } from "./types";

interface Instance {
    def: BehaviorDef;
    self: BehaviorSelf;
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
        this.collect(root);
    }

    // Number of behaviors that are running
    get count() {
        return this.instances.length;
    }

    // An inactive entity is hidden with its children, and their behaviors do not run either
    private collect(obj: THREE.Object3D) {
        if (!obj.visible) return;
        for (const component of (obj.userData.scripts ?? []) as ComponentData[]) {
            const name = component.script as string;
            const def = this.registry.getBehavior(name);
            if (!def) {
                console.warn(`Unknown behavior "${name}"`);
                continue;
            }
            const params = { ...paramDefaults(def.params ?? {}), ...(component.params as Params | undefined) };
            const self: BehaviorSelf = { object: obj, params, state: undefined, root: this.root, registry: this.registry, time: 0 };
            this.instances.push({ def, self, failed: false });
        }
        obj.children.forEach((child) => this.collect(child));
    }

    private run(instance: Instance, step: () => void) {
        if (instance.failed) return;
        try {
            step();
        } catch (e) {
            instance.failed = true;
            console.error(e);
            const message = e instanceof Error ? e.message : String(e);
            this.onError(`Script "${instance.def.name}" on "${instance.self.object.name}" stopped: ${message}`);
        }
    }

    start() {
        for (const instance of this.instances) {
            this.run(instance, () => {
                instance.self.state = instance.def.start?.(instance.self);
            });
        }
    }

    update(dt: number) {
        this.time += dt;
        for (const instance of this.instances) {
            instance.self.time = this.time;
            this.run(instance, () => instance.def.update?.(instance.self, dt));
        }
    }
}
