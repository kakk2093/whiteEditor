import * as THREE from "three";
import { paramDefaults } from "./Registry";
import type { ParamDef } from "./Registry";
import { marked } from "./shaderErrors";
import { uniformDeclaration, uniformNames, uniformValues } from "./shaderParams";
import type { Params } from "./types";

// A sky made by code: a piece of shader that gives the color of every direction. A scene picks one in its
// environment ("skyShader": "sun"), its params are "skyParams". A project adds its own by exporting
// defineSky() from a file in scripts/.
export interface SkyDef {
    kind: "sky";
    name: string;
    label?: string;
    params?: Record<string, ParamDef>;
    // GLSL that defines: vec3 sky(vec3 dir)
    //   dir     where one looks, a vector of length 1 in the world: y is up
    //   returns the color there, linear RGB; above 1 is brighter than white (a sun: it shows in the
    //           reflections and catches the "glow" effect)
    // Every param is a uniform of the same name, like those of an effect (see look.ts). Also available:
    //   vec3 skyTop, skyHorizon, skyGround   the three colors of the environment of the scene
    // There is no time: a sky stands still, and is drawn again only when its params or those colors change.
    shader: string;
}

// Used by project scripts:
// export const dusk = defineSky({ name: "dusk", shader: `vec3 sky(vec3 dir) { return mix(skyHorizon, skyTop, max(dir.y, 0.0)); }` })
export function defineSky(def: Omit<SkyDef, "kind">): SkyDef {
    return { kind: "sky", ...def };
}

export function isSkyDef(value: unknown): value is SkyDef {
    return typeof value === "object" && value !== null && (value as SkyDef).kind === "sky";
}

// What applyEnvironment leaves on a scene (scene.userData.skyShader) for whoever draws it
export interface SkyState {
    // Asked for at every drawing: a script edited while the editor is open gives another definition
    def: () => SkyDef | undefined;
    params: Params;
    // skyTop, skyHorizon, skyGround
    colors: string[];
    // The sky also lights the scene (skyLight above zero)
    lit: boolean;
}

// The sky is drawn onto the six sides of a cube around the scene; this is the size of a side, pixels
const SKY_SIZE = 1024;

// A box around the camera that draws the sides of the cube: every point of it is a direction
const VERTEX = `
varying vec3 vDir;
void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const HEADER = `
uniform vec3 skyTop;
uniform vec3 skyHorizon;
uniform vec3 skyGround;
varying vec3 vDir;`;

const FOOTER = `
void main() {
    gl_FragColor = vec4(max(sky(normalize(vDir)), 0.0), 1.0);
}`;

// Draws the sky of a scene onto a cube around it, and makes that cube its background (and its light).
// A cube, not one wide picture: three.js would make a cube out of such a picture once and keep showing
// that copy, whatever is drawn into the picture later. One per renderer; RenderPipeline calls update()
// before it draws.
export class SkyBaker {
    private renderer: THREE.WebGLRenderer;

    private target: THREE.WebGLCubeRenderTarget | null = null;

    private cubeCamera: THREE.CubeCamera | null = null;

    private material: THREE.ShaderMaterial | null = null;

    // What `material` was compiled from, and what the picture was drawn from
    private compiled = "";

    private drawn = "";

    private box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));

    private boxScene = new THREE.Scene();

    constructor(renderer: THREE.WebGLRenderer) {
        this.renderer = renderer;
        this.box.frustumCulled = false;
        this.boxScene.add(this.box);
    }

    update(scene: THREE.Scene) {
        const sky = scene.userData.skyShader as SkyState | null | undefined;
        if (!sky) return;
        const def = sky.def();
        if (!def) return;
        const params = def.params ?? {};

        if (!this.target || !this.cubeCamera) {
            // Half floats: a sun may be brighter than white
            this.target = new THREE.WebGLCubeRenderTarget(SKY_SIZE, { type: THREE.HalfFloatType, depthBuffer: false });
            this.cubeCamera = new THREE.CubeCamera(0.1, 10, this.target);
        }
        const compiled = JSON.stringify([def.name, def.shader, params]);
        if (compiled !== this.compiled || !this.material) {
            this.compiled = compiled;
            this.material?.dispose();
            const uniforms: Record<string, THREE.IUniform> = {
                skyTop: { value: new THREE.Color() },
                skyHorizon: { value: new THREE.Color() },
                skyGround: { value: new THREE.Color() },
            };
            for (const [name, d] of Object.entries(params)) {
                for (const uniform of uniformNames(name, d)) uniforms[uniform] = { value: null };
            }
            const declarations = Object.entries(params).map(([name, d]) => uniformDeclaration(d, uniformNames(name, d))).join("\n");
            this.material = new THREE.ShaderMaterial({
                vertexShader: VERTEX,
                fragmentShader: `${HEADER}\n${declarations}\n${marked(`sky "${def.name}"`, def.shader)}\n${FOOTER}`,
                uniforms,
                side: THREE.BackSide,
                depthTest: false,
                depthWrite: false,
            });
            this.drawn = "";
        }

        const drawn = JSON.stringify([compiled, sky.params, sky.colors]);
        if (drawn !== this.drawn) {
            this.drawn = drawn;
            const u = this.material.uniforms;
            const values = { ...paramDefaults(params), ...sky.params };
            (["skyTop", "skyHorizon", "skyGround"] as const).forEach((name, i) => (u[name].value as THREE.Color).set(sky.colors[i]));
            for (const [name, d] of Object.entries(params)) {
                const value = uniformValues(d, values[name]);
                uniformNames(name, d).forEach((uniform, n) => (u[uniform].value = value[n]));
            }
            this.box.material = this.material;
            this.cubeCamera.update(this.renderer, this.boxScene);
            // three.js makes the light of the scene out of the picture again when this number changes
            this.target.texture.pmremVersion++;
        }

        scene.background = this.target.texture;
        scene.environment = sky.lit ? this.target.texture : null;
    }

    dispose() {
        this.target?.dispose();
        this.material?.dispose();
        this.box.geometry.dispose();
    }
}
