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
