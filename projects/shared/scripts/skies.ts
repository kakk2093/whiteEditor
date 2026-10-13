import { defineSky } from "white-engine";

// Every defineSky() exported from a file in scripts/ can be the sky of a scene (environment: "skyShader").
// The shader defines sky(dir): dir is where one looks (length 1, y up), the result the color there.
// Each param is a uniform with the same name; skyTop, skyHorizon and skyGround are the colors of the scene.

// The three colors of the scene with a sun in them and, if asked for, bands of cloud
export const sun = defineSky({
    name: "sun",
    label: "Sun",
    params: {
        // How high the sun stands, degrees above the horizon; where around — "skyRotation" of the scene
        sunHeight: { type: "number", default: 35, min: -20, max: 90, step: 1 },
        // Degrees across
        sunSize: { type: "number", default: 4, min: 0.5, max: 30, step: 0.5 },
        sunColor: { type: "color", default: "#fff2c8" },
        // Above 1 the sun is brighter than white: it shines in the reflections and catches the glow effect
        sunBrightness: { type: "number", default: 6, min: 0, max: 50, step: 0.5 },
        // The glow of the sky around the sun
        halo: { type: "number", default: 0.35, min: 0, max: 2, step: 0.05 },
        clouds: { type: "number", default: 0, min: 0, max: 1, step: 0.05 },
        cloudColor: { type: "color", default: "#ffffff" },
    },
    shader: `
float skyHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float skyNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(skyHash(i), skyHash(i + vec2(1.0, 0.0)), f.x), mix(skyHash(i + vec2(0.0, 1.0)), skyHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
vec3 sky(vec3 dir) {
    vec3 color = dir.y >= 0.0 ? mix(skyHorizon, skyTop, sqrt(dir.y)) : mix(skyHorizon, skyGround, min(1.0, -dir.y * 8.0));
    float height = radians(sunHeight);
    // Ahead (-z) until the scene turns its sky
    vec3 toSun = vec3(0.0, sin(height), -cos(height));
    float angle = degrees(acos(clamp(dot(dir, toSun), -1.0, 1.0)));
    color += sunColor * halo * exp(-angle / 12.0) * step(0.0, dir.y);
    if (clouds > 0.0 && dir.y > 0.02) {
        // Clouds lie on a flat ceiling: far ones crowd towards the horizon
        vec2 at = dir.xz / dir.y * 1.5;
        float cover = skyNoise(at) * 0.6 + skyNoise(at * 2.3) * 0.3 + skyNoise(at * 5.1) * 0.1;
        float cloud = smoothstep(1.0 - clouds, 1.0 - clouds * 0.6, cover) * smoothstep(0.02, 0.2, dir.y);
        color = mix(color, cloudColor, cloud);
    }
    float disc = 1.0 - smoothstep(sunSize * 0.5 - 0.15, sunSize * 0.5 + 0.15, angle);
    return mix(color, sunColor * sunBrightness, disc * step(-0.01, dir.y));
}`,
});

// A dark sky with stars; the three colors of the scene give its tint
export const stars = defineSky({
    name: "stars",
    label: "Stars",
    params: {
        // How many stars: a part of the cells of the sky that have one
        density: { type: "number", default: 0.15, min: 0, max: 1, step: 0.05 },
        brightness: { type: "number", default: 2, min: 0, max: 10, step: 0.1 },
        // Degrees across
        size: { type: "number", default: 0.35, min: 0.05, max: 2, step: 0.05 },
    },
    shader: `
float starHash(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}
vec3 sky(vec3 dir) {
    vec3 color = dir.y >= 0.0 ? mix(skyHorizon, skyTop, sqrt(dir.y)) : mix(skyHorizon, skyGround, min(1.0, -dir.y * 8.0));
    // The sky is cut into cells; some of them have a star somewhere inside
    float cells = 60.0;
    vec3 cell = floor(dir * cells);
    vec3 star = normalize((cell + 0.2 + 0.6 * vec3(starHash(cell), starHash(cell + 1.7), starHash(cell + 3.1))) / cells);
    float has = step(1.0 - density, starHash(cell + 9.3));
    float angle = degrees(acos(clamp(dot(dir, star), -1.0, 1.0)));
    float light = has * (1.0 - smoothstep(size * 0.25, size * 0.5, angle)) * (0.4 + 0.6 * starHash(cell + 5.5));
    return color + vec3(light * brightness) * step(0.0, dir.y);
}`,
});
