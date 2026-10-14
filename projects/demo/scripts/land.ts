import { defineGenerator } from "white-engine";

// Shapes of land made by code: a biome (or a terrain without one) names one in its "shape" field.

// Mountains with sharp crests: the usual hills, flattened, with ridges along the lines where a wide noise
// crosses its middle
export const ridges = defineGenerator({
    name: "ridges",
    label: "Ridges",
    params: {
        // Meters a crest rises over the land around it
        sharp: { type: "number", default: 30, min: 0, step: 1 },
        // Meters between crests, about
        width: { type: "number", default: 120, min: 10, step: 5 },
    },
    height: ({ x, z, hills, params, noise }) => {
        const crest = 1 - Math.abs(2 * noise(x / params.width, z / params.width, 3) - 1);
        return hills * 0.5 + crest * crest * params.sharp;
    },
});

// Steps: the usual hills cut into level terraces with short steep sides between them
export const terraces = defineGenerator({
    name: "terraces",
    label: "Terraces",
    params: {
        // Meters from one terrace up to the next
        step: { type: "number", default: 5, min: 0.5, step: 0.5 },
        // How much of that is the slope between two terraces: 0 is a wall, 1 leaves no level ground
        slope: { type: "number", default: 0.3, min: 0.05, max: 1, step: 0.05 },
    },
    height: ({ hills, params }) => {
        const level = Math.floor(hills / params.step);
        const part = Math.min(1, Math.max(0, (hills / params.step - level - 0.5) / params.slope + 0.5));
        return (level + part * part * (3 - 2 * part)) * params.step;
    },
});
