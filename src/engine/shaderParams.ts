import * as THREE from "three";
import type { ParamDef } from "./Registry";

// How the params of an effect or a surface become uniforms of its shader:
//   number -> float, boolean -> bool, color -> vec3 (linear), select -> int (index of the option),
//   colors -> vec3 name[MAX_COLORS] (linear) and int nameCount (how many of them are set)

// A list of colors cannot be longer: the size of a uniform array is fixed in the shader
export const MAX_COLORS = 32;

// Names of the uniforms the param `name` becomes; none for what has no place in a shader
export function uniformNames(name: string, def: ParamDef): string[] {
    switch (def.type) {
        case "number":
        case "boolean":
        case "color":
        case "select":
            return [name];
        case "colors":
            return [name, `${name}Count`];
        default:
            return [];
    }
}

// The GLSL declarations; `names` are those of uniformNames(), possibly renamed
export function uniformDeclaration(def: ParamDef, names: string[]) {
    switch (def.type) {
        case "number":
            return `uniform float ${names[0]};`;
        case "boolean":
            return `uniform bool ${names[0]};`;
        case "color":
            return `uniform vec3 ${names[0]};`;
        case "select":
            return `uniform int ${names[0]};`;
        case "colors":
            return `uniform vec3 ${names[0]}[${MAX_COLORS}];\nuniform int ${names[1]};`;
        default:
            return "";
    }
}

// The values of those uniforms, in the same order
export function uniformValues(def: ParamDef, value: unknown): unknown[] {
    switch (def.type) {
        case "number":
        case "boolean":
            return [value];
        case "color":
            // Hex colors are sRGB; shaders work in linear
            return [new THREE.Color(typeof value === "string" ? value : def.default)];
        case "select":
            return [Math.max(0, def.options.indexOf(value as string))];
        case "colors": {
            const list = (Array.isArray(value) ? value : def.default).slice(0, MAX_COLORS);
            const colors = Array.from({ length: MAX_COLORS }, (_, i) => new THREE.Color(list[i] ?? "#000000"));
            return [colors, list.length];
        }
        default:
            return [];
    }
}
