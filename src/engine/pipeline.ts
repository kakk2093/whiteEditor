import * as THREE from "three";
import type { EffectDef, EffectEntry, ResolvedLook } from "./look";
import { paramDefaults } from "./Registry";
import type { Registry } from "./Registry";
import { marked } from "./shaderErrors";
import { uniformDeclaration, uniformNames, uniformValues } from "./shaderParams";
import { SkyBaker } from "./sky";
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
uniform vec2 viewScale;
uniform vec2 scroll;
varying vec2 vUv;

vec4 texel(vec2 uv) { return texture2D(tColor, uv); }
float depthAt(vec2 uv) {
    // Without the slope of the texture: an effect may read the depth in a loop, where the slope is not known
    float d = texture2DLodEXT(tDepth, uv, 0.0).x;
    // An orthographic camera keeps depth as it is, a perspective one squeezes the far part
    if (cameraOrtho) return cameraNear + d * (cameraFar - cameraNear);
    return (cameraNear * cameraFar) / (cameraFar - d * (cameraFar - cameraNear));
}
vec3 normalAt(vec2 uv) { return texture2D(tNormal, uv).xyz * 2.0 - 1.0; }
// Where the surface seen at a point of the screen is, in meters from the camera: x to the right, y up, z
// towards the viewer (what is in front of the camera has a negative z). The same space normalAt() is in.
vec3 positionAt(vec2 uv) {
    float d = depthAt(uv);
    vec2 side = (uv * 2.0 - 1.0) * viewScale;
    return vec3(cameraOrtho ? side : side * d, -d);
}
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

// The glow of the materials: the light of the glowing surfaces (tGlow: they alone, the rest black) is blurred,
// along x and then along y, in a picture of half the size, and added to the picture of the scene.
// One pass of the blur: nine samples along `step` (a part of the picture per sample), weighted as a bell.
const GLOW_BLUR = `
uniform sampler2D tGlow;
uniform vec2 step;
varying vec2 vUv;
void main() {
    vec3 sum = texture2D(tGlow, vUv).rgb * 0.2270270;
    sum += (texture2D(tGlow, vUv + step).rgb + texture2D(tGlow, vUv - step).rgb) * 0.1945946;
    sum += (texture2D(tGlow, vUv + step * 2.0).rgb + texture2D(tGlow, vUv - step * 2.0).rgb) * 0.1216216;
    sum += (texture2D(tGlow, vUv + step * 3.0).rgb + texture2D(tGlow, vUv - step * 3.0).rgb) * 0.0540541;
    sum += (texture2D(tGlow, vUv + step * 4.0).rgb + texture2D(tGlow, vUv - step * 4.0).rgb) * 0.0162162;
    gl_FragColor = vec4(sum, 1.0);
}`;

const GLOW = `
uniform sampler2D tColor;
uniform sampler2D tGlow;
uniform float strength;
varying vec2 vUv;
void main() {
    vec4 color = texture2D(tColor, vUv);
    gl_FragColor = vec4(color.rgb + texture2D(tGlow, vUv).rgb * strength, color.a);
}`;

// Lays one blurred glow onto the others (drawn with additive blending)
const GLOW_SUM = `
uniform sampler2D tGlow;
varying vec2 vUv;
void main() {
    gl_FragColor = vec4(texture2D(tGlow, vUv).rgb, 1.0);
}`;

// How far the glow of a material spreads unless it says otherwise ("glowRadius"), in percent of the height
// of the picture
const GLOW_RADIUS = 3;

// Every radius is a drawing of the scene and a blur of its own: materials with more radii than this share
// the nearest one
const MAX_GLOW_RADII = 4;

const glowRadiusOf = (material: THREE.Material) => {
    const radius = Number(material.userData.glowRadius ?? GLOW_RADIUS);
    return radius > 0 ? Math.round(radius * 10) / 10 : GLOW_RADIUS;
};

const nearest = (list: number[], value: number) => list.reduce((best, one) => (Math.abs(one - value) < Math.abs(best - value) ? one : best));

const TONE_MAPPINGS = ["none", "reinhard", "aces"];

// Writes the depth of the picture of the scene into the depth of the canvas, and no color: what is drawn
// over the picture afterwards is hidden by what stands in front of it
const DEPTH_COPY = `
uniform sampler2D tDepth;
uniform vec2 offset;
varying vec2 vUv;
void main() {
    gl_FragDepth = texture2D(tDepth, vUv + offset).r;
    gl_FragColor = vec4(0.0);
}`;

// The layer the text of the world is on for the moment it is drawn alone, over the finished picture
const TEXT_LAYER = 30;

interface Pass {
    def: EffectDef;
    material: THREE.ShaderMaterial;
}

// `smooth`: read between its pixels (what a blur wants), not pixel by pixel
function createTarget(depth: boolean, smooth = false) {
    // Half floats: the picture stays linear between the effects, and bytes would band in the dark
    const target = new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType,
        minFilter: smooth ? THREE.LinearFilter : THREE.NearestFilter,
        magFilter: smooth ? THREE.LinearFilter : THREE.NearestFilter,
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

    // An effect reads the depth of the scene
    private needsDepth = false;

    // The scene as the camera sees it, with its depth
    private sceneTarget = createTarget(true);

    private normalTarget = createTarget(true);

    // The effects read one and write the other, in turns
    private targets = [createTarget(false), createTarget(false)];

    private normalMaterial = new THREE.MeshNormalMaterial();

    private depthCopy = new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: DEPTH_COPY,
        uniforms: { tDepth: { value: null }, offset: { value: new THREE.Vector2() } },
        colorWrite: false,
        depthFunc: THREE.AlwaysDepth,
    });

    // The glowing surfaces alone, and the picture with their glow added
    private glowTarget = createTarget(true);

    private litTarget = createTarget(false);

    // What stands for a material in the picture of the glow: black for one that does not glow
    private darkMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });

    private glowMaterials = new Map<THREE.Material, THREE.MeshBasicMaterial>();

    // The blur of the glow goes from one to the other and back, at half the size of the picture
    private blurTargets = [createTarget(false, true), createTarget(false, true)];

    private blurPass = new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: GLOW_BLUR,
        uniforms: { tGlow: { value: null }, step: { value: new THREE.Vector2() } },
        depthTest: false,
        depthWrite: false,
    });

    // Where the glows of several radii are added up, at the size of the blur
    private glowSumTarget = createTarget(false, true);

    private glowSumPass = new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: GLOW_SUM,
        uniforms: { tGlow: { value: null } },
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
    });

    private glowPass = new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: GLOW,
        uniforms: { tColor: { value: null }, tGlow: { value: null }, strength: { value: 1 } },
        depthTest: false,
        depthWrite: false,
    });

    // A sky made by code ("skyShader" of the environment) is drawn into its picture before the scene
    private sky: SkyBaker;

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
        this.sky = new SkyBaker(renderer);
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
                    viewScale: { value: new THREE.Vector2(1, 1) },
                    scroll: { value: new THREE.Vector2() },
                };
                for (const [name, d] of Object.entries(params)) {
                    for (const uniform of uniformNames(name, d)) uniforms[uniform] = { value: null };
                }
                const material = new THREE.ShaderMaterial({
                    vertexShader: VERTEX,
                    fragmentShader: `${HEADER}\n${declarations}\n${marked(`effect "${def.name}"`, def.shader)}\n${FOOTER}`,
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
        this.needsDepth = used.some(({ def }) => def.inputs?.includes("depth"));
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

    // The radii of the glow of the materials the camera draws ("glow" above zero); empty if nothing glows
    private glowRadii(scene: THREE.Scene, camera: THREE.Camera) {
        const radii: number[] = [];
        scene.traverseVisible((object) => {
            const mesh = object as THREE.Mesh;
            if (!mesh.isMesh || !mesh.layers.test(camera.layers)) return;
            for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
                if (!(material.userData.glow > 0)) continue;
                const radius = glowRadiusOf(material);
                if (!radii.includes(radius) && radii.length < MAX_GLOW_RADII) radii.push(radius);
            }
        });
        return radii;
    }

    // The material that stands for another one in the picture of the glow of one radius
    private glowOf(material: THREE.Material, radius: number, radii: number[]) {
        const source = material as THREE.MeshStandardMaterial;
        if (!(material.userData.glow > 0) || !source.emissive || nearest(radii, glowRadiusOf(material)) !== radius) return this.darkMaterial;
        let own = this.glowMaterials.get(material);
        if (!own) {
            own = new THREE.MeshBasicMaterial();
            this.glowMaterials.set(material, own);
            const forget = () => {
                material.removeEventListener("dispose", forget);
                this.glowMaterials.get(material)?.dispose();
                this.glowMaterials.delete(material);
            };
            material.addEventListener("dispose", forget);
        }
        own.color.copy(source.emissive).multiplyScalar(source.emissiveIntensity * material.userData.glow);
        own.side = material.side;
        return own;
    }

    // The glow of the materials (their "glow" field), in any look and without one: draws the scene once more
    // with the glowing surfaces in the color of their light and everything else black (so what stands in
    // front hides the light), then adds that picture, spread, to `source`. Returns the target with the sum.
    // Materials that spread their light differently ("glowRadius") are drawn and blurred apart: once per radius.
    private drawGlow(scene: THREE.Scene, camera: THREE.Camera, source: THREE.WebGLRenderTarget, width: number, height: number, radii: number[]) {
        const { renderer } = this;
        const swapped: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
        const hidden: THREE.Object3D[] = [];
        scene.traverseVisible((object) => {
            const mesh = object as THREE.Mesh;
            // Particles, lines and what else is not a surface neither glows nor hides the glow
            const drawn = mesh.isMesh || (object as THREE.Line).isLine || (object as THREE.Points).isPoints || (object as THREE.Sprite).isSprite;
            if (!drawn || !object.layers.test(camera.layers)) return;
            if (!mesh.isMesh || object.userData.skipNormal) hidden.push(object);
            else swapped.push([mesh, mesh.material]);
        });
        hidden.forEach((object) => (object.visible = false));

        const { background } = scene;
        const { autoClear } = renderer;
        const clearColor = renderer.getClearColor(new THREE.Color());
        const clearAlpha = renderer.getClearAlpha();
        scene.background = null;
        renderer.setClearColor(0x000000, 1);

        const [first, second] = this.blurTargets;
        for (const target of [...this.blurTargets, this.glowSumTarget]) {
            const w = Math.max(1, Math.round(width / 2));
            const h = Math.max(1, Math.round(height / 2));
            if (target.width !== w || target.height !== h) target.setSize(w, h);
        }
        const blur = this.blurPass.uniforms;
        radii.forEach((radius, i) => {
            for (const [mesh, material] of swapped) {
                mesh.material = Array.isArray(material) ? material.map((one) => this.glowOf(one, radius, radii)) : this.glowOf(material, radius, radii);
            }
            renderer.setRenderTarget(this.glowTarget);
            renderer.render(scene, camera);

            // The blur: along x and along y, again and again, each time twice as wide, so the light fades out
            // softly. The widest pass sets the radius; a wider glow takes more passes, not sparser samples.
            // `reach`: how far apart the nine samples of that pass are, as a part of the height of the picture.
            const reach = radius / 100 / 4;
            const passes = 2 + Math.max(0, Math.ceil(Math.log2(radius / GLOW_RADIUS)));
            let from: THREE.WebGLRenderTarget = this.glowTarget;
            for (let pass = passes - 1; pass >= 0; pass--) {
                const wide = reach / 2 ** pass;
                blur.tGlow.value = from.texture;
                (blur.step.value as THREE.Vector2).set((wide * height) / width, 0);
                this.drawQuad(this.blurPass, first);
                blur.tGlow.value = first.texture;
                (blur.step.value as THREE.Vector2).set(0, wide);
                this.drawQuad(this.blurPass, second);
                from = second;
            }

            if (radii.length > 1) {
                this.glowSumPass.uniforms.tGlow.value = second.texture;
                renderer.autoClear = i === 0;
                this.drawQuad(this.glowSumPass, this.glowSumTarget);
                renderer.autoClear = autoClear;
            }
        });

        scene.background = background;
        renderer.setClearColor(clearColor, clearAlpha);
        for (const [mesh, material] of swapped) mesh.material = material;
        hidden.forEach((object) => (object.visible = true));

        const u = this.glowPass.uniforms;
        u.tColor.value = source.texture;
        u.tGlow.value = (radii.length > 1 ? this.glowSumTarget : second).texture;
        // The blur spreads the light thin: this brings the halo back to about what a material asks for
        u.strength.value = 1.6;
        this.drawQuad(this.glowPass, this.litTarget);
        return this.litTarget;
    }

    // Lays the interface over what was drawn: after the effects, so they do not touch it, but in the big
    // pixels of the picture if the look has them (and does not say otherwise)
    drawUi(ui: UiLayer) {
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

    // The text of the world (Label components) over the finished picture, at the full size of the canvas:
    // in a look with big pixels it stays sharp. What stands in front of a text still hides it: the depth of
    // the picture that is drawn already goes to the canvas first (one rectangle, not the scene again), so the
    // edge of what hides a text has the big pixels of the picture. `texts` are hidden when this is called.
    private drawText(scene: THREE.Scene, camera: THREE.Camera, texts: THREE.Object3D[], offset: THREE.Vector2) {
        const { renderer } = this;
        const { autoClear } = renderer;
        const { background } = scene;
        renderer.autoClear = false;
        scene.background = null;
        this.depthCopy.uniforms.tDepth.value = this.sceneTarget.depthTexture;
        (this.depthCopy.uniforms.offset.value as THREE.Vector2).copy(offset);
        this.drawQuad(this.depthCopy, null);

        const masks = texts.map((text) => text.layers.mask);
        const seen = camera.layers.mask;
        for (const text of texts) {
            text.visible = true;
            text.layers.set(TEXT_LAYER);
        }
        camera.layers.set(TEXT_LAYER);
        renderer.render(scene, camera);
        camera.layers.mask = seen;
        texts.forEach((text, i) => (text.layers.mask = masks[i]));
        scene.background = background;
        renderer.autoClear = autoClear;
    }

    // dt (seconds) moves the `time` the effects see; `ui` is the interface of the game to draw on top
    render(scene: THREE.Scene, camera: THREE.Camera, dt = 0, ui?: UiLayer | null) {
        const { renderer, look } = this;
        this.time += dt;
        this.sky.update(scene);

        const size = renderer.getDrawingBufferSize(new THREE.Vector2());
        const width = Math.max(1, Math.round(size.x / Math.max(1, look?.pixelSize ?? 1)));
        const height = Math.max(1, Math.round(size.y / Math.max(1, look?.pixelSize ?? 1)));
        this.surfaces.prepare(scene, camera, width, height, this.time);

        // The glow of the materials does not wait for a look
        const glowRadii = this.glowRadii(scene, camera);
        const glows = glowRadii.length > 0;

        // Nothing to do to the picture: draw straight onto the canvas, exactly as without a pipeline
        if (!glows && (!look || (look.pixelSize <= 1 && this.passes.length === 0 && look.toneMapping === "none" && look.exposure === 1))) {
            renderer.setRenderTarget(null);
            renderer.render(scene, camera);
            if (ui) this.drawUi(ui);
            return;
        }

        // In big pixels a text is unreadable: unless the look asks for it, the text of the world is left out
        // of the picture and drawn over it at the end
        const texts: THREE.Object3D[] = [];
        if (look && look.pixelSize > 1 && !look.pixelText) {
            scene.traverseVisible((object) => {
                if (object.userData.label && object.layers.test(camera.layers)) texts.push(object);
            });
            texts.forEach((text) => (text.visible = false));
        }

        // A picture of full size keeps the smooth edges it has when drawn straight onto the canvas. Not when an
        // effect reads the depth: the depth of a smoothed picture does not reach its texture.
        const samples = (look?.pixelSize ?? 1) <= 1 && !this.needsDepth ? 4 : 0;
        if (this.sceneTarget.samples !== samples) {
            this.sceneTarget.samples = samples;
            this.sceneTarget.dispose();
        }
        for (const target of [this.sceneTarget, this.normalTarget, this.glowTarget, this.litTarget, ...this.targets]) {
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
        let source = this.sceneTarget;
        if (glows) source = this.drawGlow(scene, camera, source, width, height, glowRadii);
        snap?.restore();

        const perspective = camera as THREE.PerspectiveCamera;
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
            // Half of what the camera sees, across and up: in meters (orthographic) or per meter of distance
            const ortho = camera as THREE.OrthographicCamera;
            if (ortho.isOrthographicCamera) (u.viewScale.value as THREE.Vector2).set((ortho.right - ortho.left) / 2 / ortho.zoom, (ortho.top - ortho.bottom) / 2 / ortho.zoom);
            else {
                const up = Math.tan(THREE.MathUtils.degToRad(perspective.fov) / 2) / (perspective.zoom || 1);
                (u.viewScale.value as THREE.Vector2).set(up * (perspective.aspect || width / height), up);
            }
            (u.scroll.value as THREE.Vector2).copy(snap?.scroll ?? new THREE.Vector2());
            const target = this.targets[i % 2];
            this.drawQuad(pass.material, target);
            source = target;
        });

        this.outputMaterial.uniforms.tColor.value = source.texture;
        this.outputMaterial.uniforms.toneMapping.value = Math.max(0, TONE_MAPPINGS.indexOf(look?.toneMapping ?? "none"));
        this.outputMaterial.uniforms.exposure.value = look?.exposure ?? 1;
        (this.outputMaterial.uniforms.offset.value as THREE.Vector2).copy(snap?.offset ?? new THREE.Vector2());
        this.drawQuad(this.outputMaterial, null);
        if (texts.length > 0) this.drawText(scene, camera, texts, this.outputMaterial.uniforms.offset.value as THREE.Vector2);
        if (ui) this.drawUi(ui);
    }

    dispose() {
        this.surfaces.restore();
        this.passes.forEach((pass) => pass.material.dispose());
        this.darkMaterial.dispose();
        this.glowMaterials.forEach((material) => material.dispose());
        this.glowMaterials.clear();
        this.glowPass.dispose();
        this.glowSumPass.dispose();
        this.depthCopy.dispose();
        this.sky.dispose();
        this.blurPass.dispose();
        [this.sceneTarget, this.normalTarget, this.glowTarget, this.litTarget, this.glowSumTarget, ...this.blurTargets, ...this.targets].forEach((target) => {
            target.depthTexture?.dispose();
            target.dispose();
        });
        this.normalMaterial.dispose();
        this.outputMaterial.dispose();
        this.overlayMaterial.dispose();
        this.quad.geometry.dispose();
    }
}
