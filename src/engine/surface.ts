import * as THREE from "three";
import type { SurfaceEntry } from "./look";
import { paramDefaults } from "./Registry";
import type { ParamDef, Registry } from "./Registry";
import { uniformDeclaration, uniformNames, uniformValues } from "./shaderParams";

// A surface is what a look adds to the materials of the scene: things a screen effect cannot do, because
// they happen while an object is drawn (moving its vertices, changing how light falls on it). The look lists
// surfaces next to its effects; the pipeline puts them into every material it draws, those of code models
// included, and takes them out again when the look is gone.

export interface SurfaceDef {
    kind: "surface";
    name: string;
    label?: string;
    params?: Record<string, ParamDef>;
    // Switches of the three.js shaders to turn on, e.g. "FLAT_SHADED"
    defines?: string[];
    // GLSL that defines: vec4 surfaceVertex(vec4 clip)
    //   clip  where the vertex lands on the screen, in clip space (divide xy by w for -1..1)
    // The attributes and uniforms of three.js are there too: position, normal, uv, modelMatrix, viewMatrix...
    vertex?: string;
    // GLSL that defines: vec3 surfaceColor(vec3 color, vec3 albedo)
    //   color   the lit color of the pixel, linear RGB
    //   albedo  the color of the material itself there, before light
    fragment?: string;
    // In both: every param is a uniform of the same name (as in defineEffect), plus
    //   vec2 resolution   size of the picture in pixels (after pixelSize);   float time   seconds
    // Two surfaces of one look share a shader, so helper functions need names of their own.
}

// Used by project scripts:
// export const dim = defineSurface({ name: "dim", fragment: `vec3 surfaceColor(vec3 color, vec3 albedo) { return color * 0.5; }` })
export function defineSurface(def: Omit<SurfaceDef, "kind">): SurfaceDef {
    return { kind: "surface", ...def };
}

export function isSurfaceDef(value: unknown): value is SurfaceDef {
    return typeof value === "object" && value !== null && (value as SurfaceDef).kind === "surface";
}

// The PS1 wobble: vertices land only on whole pixels, so everything trembles a little as it moves
const vertexSnap = defineSurface({
    name: "vertexSnap",
    label: "Vertex Snap",
    params: {
        // The step of the grid in pixels of the picture (after pixelSize)
        size: { type: "number", default: 1, min: 0.5, max: 16, step: 0.5 },
    },
    vertex: `
vec4 surfaceVertex(vec4 clip) {
    if (clip.w <= 0.0) return clip;
    vec2 grid = resolution / size * 0.5;
    return vec4(floor(clip.xy / clip.w * grid + 0.5) / grid * clip.w, clip.zw);
}`,
});

// Light in a few flat bands instead of a smooth falloff
const toon = defineSurface({
    name: "toon",
    label: "Toon Shading",
    params: {
        steps: { type: "number", default: 3, min: 1, max: 8, step: 1 },
        // How much light counts as fully lit: the bands are spread from 0 to this
        range: { type: "number", default: 1, min: 0.05, step: 0.05 },
        // Width of the blend between two bands, as a part of a band; 0 is a hard edge
        softness: { type: "number", default: 0.05, min: 0, max: 1, step: 0.05 },
    },
    fragment: `
vec3 surfaceColor(vec3 color, vec3 albedo) {
    const vec3 W = vec3(0.2126, 0.7152, 0.0722);
    float light = dot(color, W) / max(dot(albedo, W), 0.02);
    if (light <= 0.0) return color;
    // Bands of equal size to the eye, not in linear light
    float v = sqrt(light / range) * steps;
    float band = (floor(v) + smoothstep(0.0, max(softness, 0.0001), fract(v))) / steps;
    return color * (band * band * range / light);
}`,
});

// Every triangle is lit as a flat face, whatever normals the geometry has
const flat = defineSurface({
    name: "flat",
    label: "Flat Faces",
    defines: ["FLAT_SHADED"],
});

// Known to every project; a project surface with the same name replaces the built-in one
export const builtinSurfaces: SurfaceDef[] = [vertexSnap, toon, flat];

// The code of the surfaces for one of the two shaders. All of them end up in the same shader, so the names
// each one uses (its params, its function) are renamed apart with #define for the length of its code.
function stageCode(used: SurfaceDef[], stage: "vertex" | "fragment", fn: string) {
    let code = "uniform vec2 surface_resolution;\nuniform float surface_time;\n";
    const calls: string[] = [];
    used.forEach((def, i) => {
        const source = def[stage];
        if (!source) return;
        const names: Record<string, string> = { resolution: "surface_resolution", time: "surface_time", [fn]: `surface${i}_${stage}` };
        for (const [param, d] of Object.entries(def.params ?? {})) {
            const own = uniformNames(param, d);
            if (own.length === 0) continue;
            for (const name of own) names[name] = `surface${i}_${name}`;
            code += `${uniformDeclaration(d, own.map((name) => names[name]))}\n`;
        }
        const renamed = Object.entries(names);
        code += `${renamed.map(([from, to]) => `#define ${from} ${to}`).join("\n")}\n${source}\n${renamed.map(([from]) => `#undef ${from}`).join("\n")}\n`;
        calls.push(names[fn]);
    });
    return { code, calls };
}

interface Saved {
    onBeforeCompile: THREE.Material["onBeforeCompile"];
    customProgramCacheKey: THREE.Material["customProgramCacheKey"];
    onDispose: () => void;
}

// The surfaces of one look, put into the materials of what is being drawn
export class Surfaces {
    private renderer: THREE.WebGLRenderer;

    private used: SurfaceDef[] = [];

    // What the shaders were written from; a look that only changed its numbers keeps them
    private signature = "";

    // Shared by all patched materials, so a number changes everywhere at once
    private uniforms: Record<string, THREE.IUniform> = {
        surface_resolution: { value: new THREE.Vector2(1, 1) },
        surface_time: { value: 0 },
    };

    private patched = new Map<THREE.Material, Saved>();

    constructor(renderer: THREE.WebGLRenderer) {
        this.renderer = renderer;
    }

    get active() {
        return this.used.length > 0;
    }

    set(entries: SurfaceEntry[], registry: Registry) {
        const used: { entry: SurfaceEntry; def: SurfaceDef }[] = [];
        for (const entry of entries) {
            if (entry.enabled === false) continue;
            const def = registry.getSurface(entry.surface);
            if (def) used.push({ entry, def });
            else console.warn(`Unknown surface "${entry.surface}"`);
        }

        const signature = used.length === 0
            ? ""
            : JSON.stringify(used.map(({ def }) => [def.name, def.defines, def.vertex, def.fragment, def.params]));
        if (signature !== this.signature) {
            this.restore();
            this.signature = signature;
            this.used = used.map(({ def }) => def);
            const { surface_resolution, surface_time } = this.uniforms;
            this.uniforms = { surface_resolution, surface_time };
            used.forEach(({ def }, i) => {
                for (const [param, d] of Object.entries(def.params ?? {})) {
                    for (const name of uniformNames(param, d)) this.uniforms[`surface${i}_${name}`] = { value: null };
                }
            });
        }

        used.forEach(({ entry, def }, i) => {
            const params = def.params ?? {};
            const values = { ...paramDefaults(params), ...entry };
            for (const [name, d] of Object.entries(params)) {
                const uniformValue = uniformValues(d, values[name]);
                uniformNames(name, d).forEach((uniform, n) => {
                    this.uniforms[`surface${i}_${uniform}`].value = uniformValue[n];
                });
            }
        });
    }

    // Called before a picture is drawn: every material the camera is about to see gets the surfaces
    prepare(scene: THREE.Object3D, camera: THREE.Camera, width: number, height: number, time: number) {
        if (!this.active) return;
        (this.uniforms.surface_resolution.value as THREE.Vector2).set(width, height);
        this.uniforms.surface_time.value = time;

        scene.traverseVisible((object) => {
            const mesh = object as THREE.Mesh;
            if (!mesh.isMesh || !mesh.layers.test(camera.layers)) return;
            if (Array.isArray(mesh.material)) mesh.material.forEach((material) => this.patch(material));
            else this.patch(mesh.material);
        });
    }

    // Also for a material that replaces those of the scene for one drawing (the normals for the outlines),
    // so that its picture matches
    patch(material: THREE.Material) {
        if (!this.active || this.patched.has(material)) return;

        const { used, uniforms, signature } = this;
        const saved: Saved = {
            onBeforeCompile: material.onBeforeCompile,
            customProgramCacheKey: material.customProgramCacheKey,
            onDispose: () => this.patched.delete(material),
        };
        this.patched.set(material, saved);
        material.addEventListener("dispose", saved.onDispose);

        material.onBeforeCompile = (shader, renderer) => {
            saved.onBeforeCompile.call(material, shader, renderer);
            // Only the materials built from the shader chunks of three.js have these places
            if (!shader.vertexShader.includes("#include <project_vertex>")) return;

            const defines = used.flatMap((def) => def.defines ?? []).map((name) => `#define ${name}\n`).join("");
            const vertex = stageCode(used, "vertex", "surfaceVertex");
            shader.vertexShader = defines + shader.vertexShader
                .replace("void main() {", `${vertex.code}\nvoid main() {`)
                .replace(
                    "#include <project_vertex>",
                    `#include <project_vertex>\n${vertex.calls.map((fn) => `gl_Position = ${fn}( gl_Position );`).join("\n")}`
                );

            shader.fragmentShader = defines + shader.fragmentShader;
            if (shader.fragmentShader.includes("#include <opaque_fragment>")) {
                const fragment = stageCode(used, "fragment", "surfaceColor");
                shader.fragmentShader = shader.fragmentShader
                    .replace("void main() {", `${fragment.code}\nvoid main() {`)
                    .replace(
                        "#include <opaque_fragment>",
                        `${fragment.calls.map((fn) => `outgoingLight = ${fn}( outgoingLight, diffuseColor.rgb );`).join("\n")}\n#include <opaque_fragment>`
                    );
            }
            Object.assign(shader.uniforms, uniforms);
        };
        material.customProgramCacheKey = () => `${saved.customProgramCacheKey.call(material)}|${signature}`;
        material.needsUpdate = true;

        // three.js keeps the program of a shader it has seen before and then does not ask for the uniforms
        // again; give them to what it already holds for this material
        const held = this.renderer.properties.get(material) as { uniforms?: Record<string, THREE.IUniform> };
        if (held.uniforms) Object.assign(held.uniforms, uniforms);
    }

    // Takes the surfaces out of every material they were put into
    restore() {
        for (const [material, saved] of this.patched) {
            material.onBeforeCompile = saved.onBeforeCompile;
            material.customProgramCacheKey = saved.customProgramCacheKey;
            material.removeEventListener("dispose", saved.onDispose);
            material.needsUpdate = true;
        }
        this.patched.clear();
    }
}
