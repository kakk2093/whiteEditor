import { defineEffect } from "white-engine";

// Every defineEffect() exported from a file in scripts/ can be added to a look (Project panel, Looks tab).
// The shader defines effect(uv, color): uv is the place on the screen (0..1), color the picture there so far.
// Each param is a uniform with the same name.

// Dark horizontal lines, like an old monitor
export const scanlines = defineEffect({
    name: "scanlines",
    label: "Scanlines",
    params: {
        strength: { type: "number", default: 0.25, min: 0, max: 1, step: 0.05 },
        // Height of one line in pixels of the picture
        size: { type: "number", default: 2, min: 1, max: 8, step: 1 },
    },
    shader: `
vec4 effect(vec2 uv, vec4 color) {
    float line = step(0.5, fract(uv.y * resolution.y / size));
    return vec4(color.rgb * (1.0 - strength * line), color.a);
}`,
});

// Slow waves across the picture, for an underwater scene
export const wobble = defineEffect({
    name: "wobble",
    label: "Wobble",
    params: {
        amount: { type: "number", default: 0.004, min: 0, max: 0.05, step: 0.001 },
        speed: { type: "number", default: 1.5, min: 0, step: 0.1 },
    },
    shader: `
vec4 effect(vec2 uv, vec4 color) {
    vec2 offset = vec2(sin(uv.y * 30.0 + time * speed), cos(uv.x * 30.0 + time * speed)) * amount;
    return texel(uv + offset);
}`,
});

// Ink on paper: the darker the picture, the more layers of hatching; the colors stay as a light wash
export const hatch = defineEffect({
    name: "hatch",
    label: "Hatching",
    params: {
        paper: { type: "color", default: "#f2ead8" },
        ink: { type: "color", default: "#1c1a26" },
        // Distance between the strokes in pixels of the picture
        spacing: { type: "number", default: 6, min: 2, max: 32, step: 1 },
        // Width of a stroke, as a part of the spacing
        thickness: { type: "number", default: 0.3, min: 0.05, max: 1, step: 0.05 },
        // Brightness that stays clean paper; higher means more hatching
        light: { type: "number", default: 0.8, min: 0.1, max: 2, step: 0.05 },
        // How much of the color of the scene is washed over the paper
        wash: { type: "number", default: 0.5, min: 0, max: 1, step: 0.05 },
    },
    shader: `
float hatchStroke(vec2 p, float angle) {
    float across = dot(p, vec2(cos(angle), sin(angle))) / spacing;
    return step(1.0 - thickness, abs(fract(across) - 0.5) * 2.0);
}
vec4 effect(vec2 uv, vec4 color) {
    vec3 c = toSRGB(clamp(color.rgb, 0.0, 1.0));
    float lum = dot(c, vec3(0.299, 0.587, 0.114)) / light;
    vec2 p = uv * resolution;
    float strokes = 0.0;
    if (lum < 0.75) strokes = max(strokes, hatchStroke(p, 0.785));
    if (lum < 0.5) strokes = max(strokes, hatchStroke(p, -0.785));
    if (lum < 0.25) strokes = max(strokes, hatchStroke(p + spacing * 0.5, 0.0));
    vec3 hue = c / max(max(c.r, max(c.g, c.b)), 0.05);
    // Color params arrive linear; the mixing is done in sRGB, as the eye sees it
    vec3 page = toSRGB(paper) * mix(vec3(1.0), hue, wash);
    return vec4(toLinear(mix(page, toSRGB(ink), strokes)), color.a);
}`,
});
