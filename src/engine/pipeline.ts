import * as THREE from "three";
import type { EffectDef, EffectEntry, ResolvedLook } from "./look";
import { paramDefaults } from "./Registry";
import type { Registry } from "./Registry";
import { uniformDeclaration, uniformNames, uniformValues } from "./shaderParams";
import { Surfaces } from "./surface";

// Draws a scene through a look: with the surfaces of the look in its materials, into a (possibly smaller)
// picture, through the screen effects of the look one after another, and onto the canvas. The editor viewport, Play and the built game all draw with this
// class, so a look is the same everywhere. Without a look it is a plain renderer.render().

const VERTEX = `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// What every effect shader starts with; the effect's own code (defining effect()) follows
const HEADER = `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform vec2 resolution;
uniform float time;
uniform float cameraNear;
uniform float cameraFar;
varying vec2 vUv;

vec4 texel(vec2 uv) { return texture2D(tColor, uv); }
float depthAt(vec2 uv) {
    float d = texture2D(tDepth, uv).x;
    return (cameraNear * cameraFar) / (cameraFar - d * (cameraFar - cameraNear));
}
vec3 normalAt(vec2 uv) { return texture2D(tNormal, uv).xyz * 2.0 - 1.0; }
vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
`;

const FOOTER = `
void main() {
    gl_FragColor = effect(vUv, texture2D(tColor, vUv));
}`;

// The last step: tone mapping, linear -> sRGB, onto the canvas
const OUTPUT = `
uniform sampler2D tColor;
uniform int toneMapping;
uniform float exposure;
varying vec2 vUv;
vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
    vec4 color = texture2D(tColor, vUv);
    vec3 c = max(color.rgb, 0.0) * exposure;
    if (toneMapping == 1) c = c / (1.0 + c);
    if (toneMapping == 2) c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
    gl_FragColor = vec4(toSRGB(clamp(c, 0.0, 1.0)), color.a);
}`;

const TONE_MAPPINGS = ["none", "reinhard", "aces"];

interface Pass {
    def: EffectDef;
    material: THREE.ShaderMaterial;
}

function createTarget(depth: boolean) {
    // Half floats: the picture stays linear between the effects, and bytes would band in the dark
    const target = new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: depth,
    });
    if (depth) target.depthTexture = new THREE.DepthTexture(1, 1);
    return target;
}

export class RenderPipeline {
    private renderer: THREE.WebGLRenderer;

    private look: ResolvedLook | null = null;

    private passes: Pass[] = [];

    // What `passes` was compiled from; a look that only changed its numbers keeps the shaders
    private signature = "";

    private needsNormal = false;

    // The scene as the camera sees it, with its depth
    private sceneTarget = createTarget(true);

    private normalTarget = createTarget(true);

    // The effects read one and write the other, in turns
    private targets = [createTarget(false), createTarget(false)];

    private normalMaterial = new THREE.MeshNormalMaterial();

    private outputMaterial = new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: OUTPUT,
        uniforms: { tColor: { value: null }, toneMapping: { value: 0 }, exposure: { value: 1 } },
        depthTest: false,
        depthWrite: false,
    });

    private quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));

    private quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    private surfaces: Surfaces;

    private time = 0;

    constructor(renderer: THREE.WebGLRenderer) {
        this.renderer = renderer;
        this.surfaces = new Surfaces(renderer);
        this.quad.frustumCulled = false;
    }

    // `look` is a resolved look (resolveLook) or null for none; `registry` is where its effects are defined.
    // Cheap to call again with the same look: shaders are compiled only when the list of effects changes.
    setLook(look: ResolvedLook | null, registry: Registry) {
        this.look = look;
        this.surfaces.set(look?.surfaces ?? [], registry);
        const used: { entry: EffectEntry; def: EffectDef }[] = [];
        for (const entry of look?.effects ?? []) {
            if (entry.enabled === false) continue;
            const def = registry.getEffect(entry.effect);
            if (def) used.push({ entry, def });
            else console.warn(`Unknown effect "${entry.effect}"`);
        }

        const signature = JSON.stringify(used.map(({ def }) => [def.name, def.shader, def.params]));
        if (signature !== this.signature) {
            this.signature = signature;
            this.passes.forEach((pass) => pass.material.dispose());
            this.passes = used.map(({ def }) => {
                const params = def.params ?? {};
                const declarations = Object.entries(params).map(([name, d]) => uniformDeclaration(d, uniformNames(name, d))).join("\n");
                const uniforms: Record<string, THREE.IUniform> = {
                    tColor: { value: null },
                    tDepth: { value: null },
                    tNormal: { value: null },
                    resolution: { value: new THREE.Vector2(1, 1) },
                    time: { value: 0 },
                    cameraNear: { value: 0.1 },
                    cameraFar: { value: 1000 },
                };
                for (const [name, d] of Object.entries(params)) {
                    for (const uniform of uniformNames(name, d)) uniforms[uniform] = { value: null };
                }
                const material = new THREE.ShaderMaterial({
                    vertexShader: VERTEX,
                    fragmentShader: `${HEADER}\n${declarations}\n${def.shader}\n${FOOTER}`,
                    uniforms,
                    depthTest: false,
                    depthWrite: false,
                });
                return { def, material };
            });
        }

        used.forEach(({ entry, def }, i) => {
            const params = def.params ?? {};
            const values = { ...paramDefaults(params), ...entry };
            for (const [name, d] of Object.entries(params)) {
                const uniformValue = uniformValues(d, values[name]);
                uniformNames(name, d).forEach((uniform, n) => {
                    this.passes[i].material.uniforms[uniform].value = uniformValue[n];
                });
            }
        });
        this.needsNormal = used.some(({ def }) => def.inputs?.includes("normal"));
    }

    private drawQuad(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
        this.quad.material = material;
        this.renderer.setRenderTarget(target);
        this.renderer.render(this.quad, this.quadCamera);
    }

    // dt (seconds) moves the `time` the effects see
    render(scene: THREE.Scene, camera: THREE.Camera, dt = 0) {
        const { renderer, look } = this;
        this.time += dt;

        const size = renderer.getDrawingBufferSize(new THREE.Vector2());
        const width = Math.max(1, Math.round(size.x / Math.max(1, look?.pixelSize ?? 1)));
        const height = Math.max(1, Math.round(size.y / Math.max(1, look?.pixelSize ?? 1)));
        this.surfaces.prepare(scene, camera, width, height, this.time);

        // Nothing to do to the picture: draw straight onto the canvas, exactly as without a pipeline
        if (!look || (look.pixelSize <= 1 && this.passes.length === 0 && look.toneMapping === "none" && look.exposure === 1)) {
            renderer.setRenderTarget(null);
            renderer.render(scene, camera);
            return;
        }

        for (const target of [this.sceneTarget, this.normalTarget, ...this.targets]) {
            if (target.width !== width || target.height !== height) target.setSize(width, height);
        }

        renderer.setRenderTarget(this.sceneTarget);
        renderer.render(scene, camera);

        if (this.needsNormal) {
            const { background, overrideMaterial } = scene;
            const clearColor = renderer.getClearColor(new THREE.Color());
            const clearAlpha = renderer.getClearAlpha();
            // Moved vertices and flat faces must be in this picture too
            this.surfaces.patch(this.normalMaterial);
            // Where there is no surface the "normal" looks at the camera
            scene.background = null;
            scene.overrideMaterial = this.normalMaterial;
            renderer.setClearColor(0x8080ff, 1);
            renderer.setRenderTarget(this.normalTarget);
            renderer.render(scene, camera);
            scene.background = background;
            scene.overrideMaterial = overrideMaterial;
            renderer.setClearColor(clearColor, clearAlpha);
        }

        const perspective = camera as THREE.PerspectiveCamera;
        let source = this.sceneTarget;
        this.passes.forEach((pass, i) => {
            const u = pass.material.uniforms;
            u.tColor.value = source.texture;
            u.tDepth.value = this.sceneTarget.depthTexture;
            u.tNormal.value = this.normalTarget.texture;
            u.resolution.value.set(width, height);
            u.time.value = this.time;
            u.cameraNear.value = perspective.near;
            u.cameraFar.value = perspective.far;
            const target = this.targets[i % 2];
            this.drawQuad(pass.material, target);
            source = target;
        });

        this.outputMaterial.uniforms.tColor.value = source.texture;
        this.outputMaterial.uniforms.toneMapping.value = Math.max(0, TONE_MAPPINGS.indexOf(look.toneMapping));
        this.outputMaterial.uniforms.exposure.value = look.exposure;
        this.drawQuad(this.outputMaterial, null);
    }

    dispose() {
        this.surfaces.restore();
        this.passes.forEach((pass) => pass.material.dispose());
        [this.sceneTarget, this.normalTarget, ...this.targets].forEach((target) => {
            target.depthTexture?.dispose();
            target.dispose();
        });
        this.normalMaterial.dispose();
        this.outputMaterial.dispose();
        this.quad.geometry.dispose();
    }
}
