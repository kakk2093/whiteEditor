import type * as THREE from "three";

// A mistake in the GLSL of an effect, a surface or a sky is found by the video driver when the shader is
// first used. three.js then prints the whole shader, a few hundred lines of which the project wrote ten.
// Here the message is cut down to what the author can act on: whose code it is and the line in that code.

// Marks the code a project wrote inside a bigger shader, so that a mistake in it can be traced back to it.
// `what` is how the message will call it: 'effect "scanlines"'.
export function marked(what: string, code: string) {
    return `//<white ${what}>\n${code}\n//</white>`;
}

// What the driver says about one shader, line by line, each traced to the marked code it is in
function describe(gl: WebGLRenderingContext | WebGL2RenderingContext, shader: WebGLShader): string[] {
    const log = gl.getShaderInfoLog(shader) ?? "";
    const source = (gl.getShaderSource(shader) ?? "").split("\n");
    const found: string[] = [];
    for (const line of log.split("\n")) {
        // "ERROR: 0:123: 'x' : undeclared identifier"
        const match = /^ERROR: \d+:(\d+): (.*)$/.exec(line.trim());
        if (!match) continue;
        const number = Number(match[1]);
        let where = `line ${number} of the whole shader (${(source[number - 1] ?? "").trim()})`;
        for (let i = Math.min(number, source.length) - 1; i >= 0; i--) {
            if (source[i].startsWith("//</white>") && i < number - 1) break;
            const opening = /^\/\/<white (.*)>$/.exec(source[i]);
            if (opening) {
                // A mistake at the very end of the code is told at the line after it
                where = `${opening[1]}, line ${Math.max(1, number - i - 1)}`;
                break;
            }
        }
        found.push(`${where}: ${match[2]}`);
    }
    return found;
}

export function shaderErrorMessage(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    program: WebGLProgram,
    vertexShader: WebGLShader,
    fragmentShader: WebGLShader
) {
    const found = [...describe(gl, fragmentShader), ...describe(gl, vertexShader)];
    if (found.length === 0) {
        const log = gl.getShaderInfoLog(fragmentShader) || gl.getShaderInfoLog(vertexShader) || gl.getProgramInfoLog(program) || "does not link";
        return `Shader error: ${log.trim()}`;
    }
    // One mistake often brings a dozen after it; the first ones are the cause
    const shown = found.slice(0, 4);
    return `Shader error in ${shown.join("; in ")}${found.length > shown.length ? `; and ${found.length - shown.length} more` : ""}`;
}

// The renderer tells `report` about every shader that does not compile, in a few words
export function watchShaderErrors(renderer: THREE.WebGLRenderer, report: (message: string) => void = (message) => console.error(message)) {
    renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) => {
        report(shaderErrorMessage(gl, program, vertexShader, fragmentShader));
    };
}
