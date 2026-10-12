import { defineSurface } from "white-engine";

// Every defineSurface() exported from a file in scripts/ can be added to a look (its "surfaces" list).
// A surface changes how the objects themselves are drawn: `vertex` moves their vertices on the screen,
// `fragment` changes the lit color. Each param is a uniform with the same name.

// Everything leans slowly from side to side, like plants in a current
export const sway = defineSurface({
    name: "sway",
    label: "Sway",
    params: {
        amount: { type: "number", default: 0.02, min: 0, max: 0.2, step: 0.005 },
        speed: { type: "number", default: 2, min: 0, step: 0.1 },
    },
    vertex: `
vec4 surfaceVertex(vec4 clip) {
    return clip + vec4(sin(time * speed + clip.y) * amount * clip.w, 0.0, 0.0, 0.0);
}`,
});

// Hand-drawn animation: every vertex is a little off, and off in another way a few times a second,
// so the outlines "boil" like in a cartoon drawn frame by frame
export const boil = defineSurface({
    name: "boil",
    label: "Boil",
    params: {
        // How far a vertex strays, in pixels of the picture
        amount: { type: "number", default: 1.5, min: 0, max: 10, step: 0.25 },
        // New drawings per second
        rate: { type: "number", default: 8, min: 0, max: 30, step: 1 },
    },
    vertex: `
float boilHash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
vec4 surfaceVertex(vec4 clip) {
    float frame = floor(time * rate);
    vec3 p = (modelMatrix * vec4(position, 1.0)).xyz;
    vec2 off = vec2(boilHash(p + frame), boilHash(p.zxy - frame)) - 0.5;
    return clip + vec4(off * amount * 2.0 / resolution * clip.w, 0.0, 0.0);
}`,
});
