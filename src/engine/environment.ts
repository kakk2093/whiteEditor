import * as THREE from "three";
import type { ParamDef, Registry } from "./Registry";
import type { SkyState } from "./sky";
import type { Params } from "./types";

// Scene-wide rendering settings (Unity keeps these in the Lighting window)
export interface EnvironmentData {
    background: string;
    // A sky instead of the plain background: three colors, from straight up down to the horizon and below it
    sky: boolean;
    skyTop: string;
    skyHorizon: string;
    skyGround: string;
    // An image from assets/ wrapped around the scene instead of the three colors: a panorama, twice as wide
    // as it is high (equirectangular); "" for none
    skyImage: string;
    // A sky made by code instead of the three colors: the name of a defineSky() of scripts/; "" for none.
    // An image, if one is named too, wins.
    skyShader: string;
    // The params of that sky
    skyParams: Params;
    // Turns the sky around the vertical axis, degrees: where its sun or the middle of its image stands
    skyRotation: number;
    // How much the sky (the plain background, without one) lights the surfaces and is mirrored in the smooth
    // and the metal ones: the environment map of the scene. 0: none
    skyLight: number;
    ambientColor: string;
    ambientIntensity: number;
    fog: boolean;
    fogColor: string;
    fogNear: number;
    fogFar: number;
    // Name of a look asset: the render style of the scene, "" = none (see look.ts)
    look: string;
}

// "skyParams" is not here: its fields are the params of the sky the scene names
export const environmentFields: Record<Exclude<keyof EnvironmentData, "skyParams">, ParamDef> = {
    background: { type: "color", default: "#222222", when: { sky: [false] } },
    sky: { type: "boolean", default: false },
    skyTop: { type: "color", default: "#2f6fc4", when: { sky: [true] } },
    skyHorizon: { type: "color", default: "#bfd9ee", when: { sky: [true] } },
    skyGround: { type: "color", default: "#6b6156", when: { sky: [true] } },
    skyImage: { type: "asset", kind: "texture", default: "", when: { sky: [true] } },
    skyShader: { type: "asset", kind: "sky", default: "", when: { sky: [true] } },
    skyRotation: { type: "number", default: 0, step: 5, when: { sky: [true] } },
    skyLight: { type: "number", default: 0, min: 0, step: 0.1 },
    ambientColor: { type: "color", default: "#ffffff" },
    ambientIntensity: { type: "number", default: 1, min: 0, step: 0.1 },
    fog: { type: "boolean", default: false },
    fogColor: { type: "color", default: "#222222" },
    fogNear: { type: "number", default: 5, min: 0, step: 1 },
    fogFar: { type: "number", default: 50, min: 0, step: 1 },
    look: { type: "asset", kind: "look", default: "" },
};

export const defaultEnvironment = {
    ...Object.fromEntries(Object.entries(environmentFields).map(([key, def]) => [key, def.default])),
    skyParams: {},
} as unknown as EnvironmentData;

const AMBIENT_NAME = "__ambient";

// How many rows the picture of the sky has, from straight down to straight up
const SKY_ROWS = 128;

// As many columns when the picture also lights the scene: three.js makes the light from a picture that has a width
const SKY_COLUMNS = 256;

// The sky as a picture wrapped around the scene: one column, three.js stretches it all the way round
function createSky(colors: string[], columns: number) {
    const [top, horizon, ground] = colors.map((color) => new THREE.Color(color));
    const data = new Uint8Array(SKY_ROWS * columns * 4);
    const color = new THREE.Color();
    const written = new THREE.Color();
    for (let row = 0; row < SKY_ROWS; row++) {
        // -1 straight down, 0 the horizon, 1 straight up
        const height = (row / (SKY_ROWS - 1)) * 2 - 1;
        // The sky pales towards the horizon slowly; the ground darkens right under it
        if (height >= 0) color.lerpColors(horizon, top, height ** 0.5);
        else color.lerpColors(horizon, ground, Math.min(1, -height * 8));
        // The colors are mixed as numbers of light and written the way a picture keeps them
        written.copy(color).convertLinearToSRGB();
        const pixel = [...[written.r, written.g, written.b].map((c) => Math.round(THREE.MathUtils.clamp(c, 0, 1) * 255)), 255];
        for (let column = 0; column < columns; column++) data.set(pixel, (row * columns + column) * 4);
    }
    return wrapAround(new THREE.DataTexture(data, columns, SKY_ROWS));
}

function wrapAround(texture: THREE.Texture) {
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
}

// The editor viewport and the game both call this, so they look the same. `registry` gives the picture of
// the sky ("skyImage") and the sky made by code ("skyShader"); without it, and until the picture has
// arrived, the sky is its three colors.
export function applyEnvironment(scene: THREE.Scene, data: Partial<EnvironmentData> = {}, registry?: Registry) {
    const env = { ...defaultEnvironment, ...data };
    scene.userData.environment = env;

    // What is around the scene, as a picture: the sky, or the plain background when its light is asked for
    const lit = env.skyLight > 0;
    let image = env.sky && env.skyImage ? registry?.loadTexture(env.skyImage) ?? null : null;
    if (image instanceof Promise) {
        // Drawn again with the picture, unless the scene has got another environment in the meantime
        image.then(() => scene.userData.environment === env && applyEnvironment(scene, env, registry)).catch(() => console.warn(`Sky image "${env.skyImage}" could not be loaded`));
        image = null;
    }
    const colors = env.sky ? [env.skyTop, env.skyHorizon, env.skyGround] : [env.background, env.background, env.background];
    // The picture is kept while what it is made of stays the same
    const skyKey = env.sky || lit ? (image ? `image:${env.skyImage}` : [...colors, lit].join()) : "";
    const kept = scene.userData.sky as { key: string; texture: THREE.Texture } | undefined;
    if (kept && kept.key !== skyKey) {
        kept.texture.dispose();
        delete scene.userData.sky;
    }
    if (skyKey && !scene.userData.sky) {
        const texture = image ? wrapAround(new THREE.Texture(image)) : createSky(colors, lit ? SKY_COLUMNS : 1);
        if (image) texture.generateMipmaps = false;
        scene.userData.sky = { key: skyKey, texture };
    }
    const sky = (scene.userData.sky as { texture: THREE.Texture } | undefined)?.texture ?? null;
    scene.background = env.sky && sky ? sky : new THREE.Color(env.background);
    // three.js turns the picture into the light and the reflections of the standard materials
    scene.environment = lit ? sky : null;
    scene.environmentIntensity = env.skyLight;
    scene.backgroundRotation.set(0, THREE.MathUtils.degToRad(env.skyRotation), 0);
    scene.environmentRotation.copy(scene.backgroundRotation);

    // A sky made by code is drawn by whoever draws the scene (SkyBaker in the pipeline): it takes the place
    // of the picture above, which stays where nothing draws (a check without a browser)
    const named = env.sky && env.skyShader && !image && registry?.getSky(env.skyShader) ? env.skyShader : "";
    const state: SkyState | null = named && registry ? { def: () => registry.getSky(named), params: env.skyParams ?? {}, colors: [env.skyTop, env.skyHorizon, env.skyGround], lit } : null;
    scene.userData.skyShader = state;
    scene.fog = env.fog ? new THREE.Fog(env.fogColor, env.fogNear, env.fogFar) : null;

    let ambient = scene.children.find((c) => c.name === AMBIENT_NAME) as THREE.AmbientLight | undefined;
    if (!ambient) {
        ambient = new THREE.AmbientLight();
        ambient.name = AMBIENT_NAME;
        scene.add(ambient);
    }
    ambient.color.set(env.ambientColor);
    ambient.intensity = env.ambientIntensity;
}

// What a Zone component changes of the environment while the camera is inside it. Of the sky it can only
// say that it is not seen from inside (its "sky" field).
export const ZONE_KEYS = ["background", "ambientColor", "ambientIntensity", "fog", "fogColor", "fogNear", "fogFar", "look"] as const;

// The fields of a Zone component, defaults filled in (see components.ts)
export type ZoneFields = Pick<EnvironmentData, (typeof ZONE_KEYS)[number]> & { sizeX: number; sizeY: number; sizeZ: number; blend: number; sky?: boolean };

const local = new THREE.Vector3();
const inverse = new THREE.Matrix4();

// The zone a point of the world is in: the fields of the first active Zone component whose box holds it
export function zoneAt(root: THREE.Object3D, point: THREE.Vector3): ZoneFields | null {
    let found: ZoneFields | null = null;
    const visit = (object: THREE.Object3D) => {
        if (found || !object.visible) return;
        const zone = object.userData.zone as ZoneFields | undefined;
        if (zone) {
            // The box turns and grows with its entity
            local.copy(point).applyMatrix4(inverse.copy(object.matrixWorld).invert());
            if (Math.abs(local.x) <= zone.sizeX / 2 && Math.abs(local.y) <= zone.sizeY / 2 && Math.abs(local.z) <= zone.sizeZ / 2) found = zone;
            return;
        }
        object.children.forEach(visit);
    };
    visit(root);
    return found;
}

// The environment of the scene as a zone changes it; the look of the zone only if it names one
export function withZone(base: EnvironmentData, zone: ZoneFields | null): EnvironmentData {
    if (!zone) return base;
    const env = { ...base };
    if (zone.sky === false) env.sky = false;
    for (const key of ZONE_KEYS) {
        if (key === "look" && !zone.look) continue;
        (env as Record<string, unknown>)[key] = zone[key];
    }
    return env;
}

const colorA = new THREE.Color();
const colorB = new THREE.Color();

// A step from one environment towards another: `part` of the way (0..1) for the colors and the numbers.
// What cannot be in between (fog on or off, the look, the sky) is the target's at once.
export function blendEnvironment(from: EnvironmentData, to: EnvironmentData, part: number): EnvironmentData {
    if (part >= 1) return to;
    const result = { ...to } as Record<string, unknown>;
    for (const [key, def] of Object.entries(environmentFields) as [keyof EnvironmentData, ParamDef][]) {
        const a = from[key];
        const b = to[key];
        if (def.type === "number") {
            const value = (a as number) + ((b as number) - (a as number)) * part;
            // Close enough is there: it does not creep towards the target forever
            result[key] = Math.abs((b as number) - value) < 1e-3 ? b : value;
        } else if (def.type === "color" && a !== b) {
            colorA.set(a as string).lerp(colorB.set(b as string), part);
            const mixed = `#${colorA.getHexString()}`;
            result[key] = mixed === a ? b : mixed;
        }
    }
    return result as unknown as EnvironmentData;
}
