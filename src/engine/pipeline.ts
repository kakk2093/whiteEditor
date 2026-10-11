import * as THREE from "three";
import type { EffectDef, EffectEntry, ResolvedLook } from "./look";
import { paramDefaults } from "./Registry";
import type { Registry } from "./Registry";
import { uniformDeclaration, uniformNames, uniformValues } from "./shaderParams";
import { Surfaces } from "./surface";
import type { UiLayer } from "./ui";

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
uniform bool cameraOrtho;
uniform vec2 scroll;
varying vec2 vUv;

vec4 texel(vec2 uv) { return texture2D(tColor, uv); }
float depthAt(vec2 uv) {
    float d = texture2D(tDepth, uv).x;
    // An orthographic camera keeps depth as it is, a perspective one squeezes the far part
    if (cameraOrtho) return cameraNear + d * (cameraFar - cameraNear);
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
uniform vec2 offset;
varying vec2 vUv;
vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
    vec4 color = texture2D(tColor, vUv + offset);
    vec3 c = max(color.rgb, 0.0) * exposure;
    if (toneMapping == 1) c = c / (1.0 + c);
    if (toneMapping == 2) c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
    gl_FragColor = vec4(toSRGB(clamp(c, 0.0, 1.0)), color.a);
}`;

// The interface of the game, laid over the finished picture: its canvas is in sRGB already
const OVERLAY = `
uniform sampler2D tUi;
varying vec2 vUv;
void main() {
    gl_FragColor = texture2D(tUi, vUv);
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
        uniforms: { tColor: { value: null }, toneMapping: { value: 0 }, exposure: { value: 1 }, offset: { value: new THREE.Vector2() } },
        depthTest: false,
        depthWrite: false,
    });

    private overlayMaterial = new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: OVERLAY,
        uniforms: { tUi: { value: null } },
        depthTest: false,
        depthWrite: false,
        transparent: true,
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
                    cameraOrtho: { value: false },
                    scroll: { value: new THREE.Vector2() },
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

    // Pixel snap. Moves an orthographic camera, for the length of one drawing, to the nearest place where the
    // pixels of the (small) picture fall on the same spots of the world as before: what stands still then keeps
    // its pixels while the camera moves. Returns how to put the camera back, and the part of the move that was
    // dropped, in the uv of the picture: the output shifts the picture by it, so the motion stays smooth.
    private snapCamera(camera: THREE.Camera, width: number, height: number) {
        const ortho = camera as THREE.OrthographicCamera;
        if (!ortho.isOrthographicCamera || !this.look?.pixelSnap || this.look.pixelSize <= 1) return null;

        camera.updateWorldMatrix(true, false);
        const position = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
        const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
        // The size of one pixel of the picture in the world
        const pixelX = (ortho.right - ortho.left) / ortho.zoom / width;
        const pixelY = (ortho.top - ortho.bottom) / ortho.zoom / height;
        const x = position.dot(right);
        const y = position.dot(up);
        const dx = Math.round(x / pixelX) * pixelX - x;
        const dy = Math.round(y / pixelY) * pixelY - y;

        const saved = camera.position.clone();
        const moved = position.addScaledVector(right, dx).addScaledVector(up, dy);
        camera.position.copy(camera.parent ? camera.parent.worldToLocal(moved) : moved);
        camera.updateMatrixWorld();
        return {
            // How far the camera is from the origin, in pixels of the picture (kept small: only its change
            // matters). A pattern drawn at "pixel + scroll" stays on the world instead of on the screen.
            scroll: new THREE.Vector2(Math.round(x / pixelX) % 4096, Math.round(y / pixelY) % 4096),
            offset: new THREE.Vector2(-dx / pixelX / width, -dy / pixelY / height),
            restore: () => {
                camera.position.copy(saved);
                camera.updateMatrixWorld();
            },
        };
    }

    // Lays the interface over what was drawn: after the effects, so they do not touch it, but in the big
    // pixels of the picture if the look has them (and does not say otherwise)
    private drawUi(ui: UiLayer) {
        const { renderer, look } = this;
        const area = renderer.getViewport(new THREE.Vector4()).multiplyScalar(renderer.getPixelRatio());
        const pixel = look && look.pixelUi ? Math.max(1, look.pixelSize) : 1;
        const texture = ui.draw(Math.max(1, Math.round(area.z / pixel)), Math.max(1, Math.round(area.w / pixel)));
        if (!texture) return;
        this.overlayMaterial.uniforms.tUi.value = texture;
        // Onto the picture, not instead of it
        const { autoClear } = renderer;
        renderer.autoClear = false;
        this.drawQuad(this.overlayMaterial, null);
        renderer.autoClear = autoClear;
    }

    // dt (seconds) moves the `time` the effects see; `ui` is the interface of the game to draw on top
    render(scene: THREE.Scene, camera: THREE.Camera, dt = 0, ui?: UiLayer | null) {
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
            if (ui) this.drawUi(ui);
            return;
        }

        for (const target of [this.sceneTarget, this.normalTarget, ...this.targets]) {
            if (target.width !== width || target.height !== height) target.setSize(width, height);
        }

        const snap = this.snapCamera(camera, width, height);
        renderer.setRenderTarget(this.sceneTarget);
        renderer.render(scene, camera);

        if (this.needsNormal) {
            const { background, overrideMaterial } = scene;
            const clearColor = renderer.getClearColor(new THREE.Color());
            const clearAlpha = renderer.getClearAlpha();
            // Moved vertices and flat faces must be in this picture too
            this.surfaces.patch(this.normalMaterial);
            // What is not a surface has no normal: it is left out of this picture
            const hidden: THREE.Object3D[] = [];
            scene.traverse((object) => {
                if (object.userData.skipNormal && object.visible) hidden.push(object);
            });
            hidden.forEach((object) => (object.visible = false));
            // Where there is no surface the "normal" looks at the camera
            scene.background = null;
            scene.overrideMaterial = this.normalMaterial;
            renderer.setClearColor(0x8080ff, 1);
            renderer.setRenderTarget(this.normalTarget);
            renderer.render(scene, camera);
            scene.background = background;
            scene.overrideMaterial = overrideMaterial;
            hidden.forEach((object) => (object.visible = true));
            renderer.setClearColor(clearColor, clearAlpha);
        }
        snap?.restore();

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
            u.cameraOrtho.value = (camera as THREE.OrthographicCamera).isOrthographicCamera === true;
            (u.scroll.value as THREE.Vector2).copy(snap?.scroll ?? new THREE.Vector2());
            const target = this.targets[i % 2];
            this.drawQuad(pass.material, target);
            source = target;
        });

        this.outputMaterial.uniforms.tColor.value = source.texture;
        this.outputMaterial.uniforms.toneMapping.value = Math.max(0, TONE_MAPPINGS.indexOf(look.toneMapping));
        this.outputMaterial.uniforms.exposure.value = look.exposure;
        (this.outputMaterial.uniforms.offset.value as THREE.Vector2).copy(snap?.offset ?? new THREE.Vector2());
        this.drawQuad(this.outputMaterial, null);
        if (ui) this.drawUi(ui);
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
        this.overlayMaterial.dispose();
        this.quad.geometry.dispose();
    }
}
