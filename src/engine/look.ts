import type { ParamDef, Registry } from "./Registry";
import type { ParamValue } from "./types";

// A look is a render style: looks/<name>.json in the project. A scene picks one in its environment
// ("look": "PixelArt"), and the viewport, Play and the built game all draw through it (see pipeline.ts).

// One effect of a look: { "effect": "outline", "thickness": 2 }. A missing param means its default,
// "enabled": false switches the effect off without removing it.
export interface EffectEntry {
    effect: string;
    enabled?: boolean;
    [param: string]: ParamValue | undefined;
}

// One surface of a look: { "surface": "toon", "steps": 3 }; same rules as for an effect
export interface SurfaceEntry {
    surface: string;
    enabled?: boolean;
    [param: string]: ParamValue | undefined;
}

export interface LookSettings {
    // The scene is drawn in a picture this many times smaller and scaled up with hard pixels; 1 = full size
    pixelSize: number;
    toneMapping: string;
    exposure: number;
    // With an orthographic camera and pixelSize above 1: the camera moves by whole pixels of the picture, so
    // what stands still does not flicker while it moves; the rest of the move is made by shifting the picture
    pixelSnap: boolean;
}

export interface LookData extends Partial<LookSettings> {
    // Name of another look this one is built on: it takes that look's settings and effects, changes the
    // ones it names again and adds its own
    extends?: string;
    // What is added to the materials of the scene (see surface.ts), applied in this order
    surfaces?: SurfaceEntry[];
    // Screen effects, applied in this order
    effects?: EffectEntry[];
}

export const lookFields: Record<keyof LookSettings, ParamDef> = {
    pixelSize: { type: "number", default: 1, min: 1, max: 16, step: 1 },
    toneMapping: { type: "select", default: "none", options: ["none", "reinhard", "aces"] },
    exposure: { type: "number", default: 1, min: 0, step: 0.1 },
    pixelSnap: { type: "boolean", default: true },
};

// A look with everything it extends folded in
export interface ResolvedLook extends LookSettings {
    surfaces: SurfaceEntry[];
    effects: EffectEntry[];
}

// A screen effect: a piece of fragment shader with params. Built-in ones are below; a project adds its own
// by exporting defineEffect() from a file in scripts/.
export interface EffectDef {
    kind: "effect";
    name: string;
    label?: string;
    params?: Record<string, ParamDef>;
    // What the shader reads besides the picture; "normal" costs one more drawing of the scene
    inputs?: ("depth" | "normal")[];
    // GLSL that defines: vec4 effect(vec2 uv, vec4 color)
    //   uv     where the pixel is, 0..1
    //   color  the picture at that pixel so far, linear RGB
    // Every param is a uniform of the same name: number -> float, boolean -> bool, color -> vec3 (linear),
    // select -> int (index of the option), colors -> vec3 name[32] (linear) with int nameCount;
    // so a param cannot be called uv, color or like anything below.
    // Also available:
    //   vec4 texel(vec2 uv)      the picture at another place
    //   float depthAt(vec2 uv)   distance from the camera (from its plane) in meters (needs inputs: ["depth"])
    //   vec3 normalAt(vec2 uv)   surface direction relative to the camera (needs inputs: ["normal"])
    //   vec2 resolution          size of the picture in pixels;   float time   seconds
    //   vec2 scroll              how far a pixel-snapped camera has moved, in pixels of the picture: a pattern
    //                            made from "uv * resolution + scroll" stays on the world (zero without pixel snap)
    //   vec3 toSRGB(vec3), vec3 toLinear(vec3)
    shader: string;
}

// Used by project scripts:
// export const invert = defineEffect({ name: "invert", shader: `vec4 effect(vec2 uv, vec4 color) { return vec4(1.0 - color.rgb, color.a); }` })
export function defineEffect(def: Omit<EffectDef, "kind">): EffectDef {
    return { kind: "effect", ...def };
}

export function isEffectDef(value: unknown): value is EffectDef {
    return typeof value === "object" && value !== null && (value as EffectDef).kind === "effect";
}

// Dark lines where the depth or the surface direction changes sharply: silhouettes and edges
const outline = defineEffect({
    name: "outline",
    label: "Outline",
    inputs: ["depth", "normal"],
    params: {
        lineColor: { type: "color", default: "#101018" },
        // In pixels of the picture (after pixelSize)
        thickness: { type: "number", default: 1, min: 0.5, max: 4, step: 0.5 },
        // How big a jump in depth, relative to the distance, makes a line
        depth: { type: "number", default: 0.15, min: 0, step: 0.01 },
        // How big a turn of the surface makes a line; 2 switches edge lines off
        normal: { type: "number", default: 0.9, min: 0, max: 2, step: 0.05 },
        opacity: { type: "number", default: 1, min: 0, max: 1, step: 0.05 },
    },
    shader: `
vec4 effect(vec2 uv, vec4 color) {
    vec2 px = thickness / resolution;
    float d = depthAt(uv);
    float dd = abs(depthAt(uv + vec2(px.x, 0.0)) - d) + abs(depthAt(uv - vec2(px.x, 0.0)) - d)
        + abs(depthAt(uv + vec2(0.0, px.y)) - d) + abs(depthAt(uv - vec2(0.0, px.y)) - d);
    vec3 n = normalAt(uv);
    float dn = distance(normalAt(uv + vec2(px.x, 0.0)), n) + distance(normalAt(uv - vec2(px.x, 0.0)), n)
        + distance(normalAt(uv + vec2(0.0, px.y)), n) + distance(normalAt(uv - vec2(0.0, px.y)), n);
    float edge = max(step(depth * d, dd), step(normal, dn));
    return vec4(mix(color.rgb, lineColor, edge * opacity), color.a);
}`,
});

// Fewer colors, with a dither pattern hiding the bands. With `colors` every pixel becomes the nearest
// color of that list; with an empty list each channel keeps only `levels` steps.
const palette = defineEffect({
    name: "palette",
    label: "Palette",
    params: {
        colors: { type: "colors", default: [] },
        levels: { type: "number", default: 5, min: 2, max: 32, step: 1 },
        dither: { type: "number", default: 0.3, min: 0, max: 1, step: 0.05 },
    },
    shader: `
float bayer4(vec2 p) {
    vec2 q = floor(mod(p, 4.0));
    float i = q.x + q.y * 4.0;
    float v = 0.0;
    if (i < 0.5) v = 0.0; else if (i < 1.5) v = 8.0; else if (i < 2.5) v = 2.0; else if (i < 3.5) v = 10.0;
    else if (i < 4.5) v = 12.0; else if (i < 5.5) v = 4.0; else if (i < 6.5) v = 14.0; else if (i < 7.5) v = 6.0;
    else if (i < 8.5) v = 3.0; else if (i < 9.5) v = 11.0; else if (i < 10.5) v = 1.0; else if (i < 11.5) v = 9.0;
    else if (i < 12.5) v = 15.0; else if (i < 13.5) v = 7.0; else if (i < 14.5) v = 13.0; else v = 5.0;
    return (v + 0.5) / 16.0 - 0.5;
}
vec4 effect(vec2 uv, vec4 color) {
    // Counted in sRGB, where equal steps look equal
    vec3 c = toSRGB(clamp(color.rgb, 0.0, 1.0));
    // With a pixel-snapped camera the pattern moves with the world, so it does not crawl over what stands still
    float pattern = bayer4(uv * resolution + scroll) * dither;
    if (colorsCount > 0) {
        // The pattern pushes a pixel between two colors of the list towards one or the other
        c += pattern * 0.25;
        vec3 nearest = c;
        float least = 1000.0;
        for (int i = 0; i < 32; i++) {
            if (i >= colorsCount) break;
            vec3 candidate = toSRGB(colors[i]);
            // Green differences are seen best, blue ones worst
            vec3 d = (c - candidate) * vec3(0.55, 0.77, 0.34);
            float distance2 = dot(d, d);
            if (distance2 < least) {
                least = distance2;
                nearest = candidate;
            }
        }
        return vec4(toLinear(nearest), color.a);
    }
    float steps = levels - 1.0;
    c = floor(c * steps + 0.5 + pattern) / steps;
    return vec4(toLinear(clamp(c, 0.0, 1.0)), color.a);
}`,
});

const grade = defineEffect({
    name: "grade",
    label: "Color Grade",
    params: {
        brightness: { type: "number", default: 1, min: 0, step: 0.05 },
        contrast: { type: "number", default: 1, min: 0, step: 0.05 },
        saturation: { type: "number", default: 1, min: 0, step: 0.05 },
        tint: { type: "color", default: "#ffffff" },
    },
    shader: `
vec4 effect(vec2 uv, vec4 color) {
    vec3 c = toSRGB(max(color.rgb, 0.0)) * brightness;
    c = (c - 0.5) * contrast + 0.5;
    float gray = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(gray), c, saturation);
    return vec4(toLinear(max(c, 0.0)) * tint, color.a);
}`,
});

const vignette = defineEffect({
    name: "vignette",
    label: "Vignette",
    params: {
        strength: { type: "number", default: 0.5, min: 0, max: 1, step: 0.05 },
        // Where the darkening starts, from the center (0) to the corners (1)
        radius: { type: "number", default: 0.6, min: 0, max: 1, step: 0.05 },
    },
    shader: `
vec4 effect(vec2 uv, vec4 color) {
    float d = distance(uv, vec2(0.5)) / 0.7071;
    return vec4(color.rgb * (1.0 - strength * smoothstep(radius, 1.0, d)), color.a);
}`,
});

// Known to every project; a project effect with the same name replaces the built-in one
export const builtinEffects: EffectDef[] = [outline, palette, grade, vignette];

// An entry named again in an extending look keeps its place in the list and gets the new params
function mergeEntries<E extends EffectEntry | SurfaceEntry>(base: E[], own: E[], key: "effect" | "surface"): E[] {
    const name = (entry: E) => (entry as Record<string, unknown>)[key];
    const merged = base.map((e) => ({ ...e }));
    for (const entry of own) {
        const inherited = merged.find((e) => name(e) === name(entry));
        if (inherited) Object.assign(inherited, entry);
        else merged.push({ ...entry });
    }
    return merged;
}

// The look with what it extends folded in; null if there is no such look
export function resolveLook(registry: Registry, name: string, seen: string[] = []): ResolvedLook | null {
    const data = registry.getLookData(name);
    if (!data || seen.includes(name)) return null;

    const base: ResolvedLook = (data.extends && resolveLook(registry, data.extends, [...seen, name])) || {
        pixelSize: lookFields.pixelSize.default as number,
        toneMapping: lookFields.toneMapping.default as string,
        exposure: lookFields.exposure.default as number,
        pixelSnap: lookFields.pixelSnap.default as boolean,
        surfaces: [],
        effects: [],
    };

    return {
        pixelSize: data.pixelSize ?? base.pixelSize,
        toneMapping: data.toneMapping ?? base.toneMapping,
        exposure: data.exposure ?? base.exposure,
        pixelSnap: data.pixelSnap ?? base.pixelSnap,
        surfaces: mergeEntries(base.surfaces, data.surfaces ?? [], "surface"),
        effects: mergeEntries(base.effects, data.effects ?? [], "effect"),
    };
}
