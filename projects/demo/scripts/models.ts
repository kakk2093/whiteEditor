import * as THREE from "three";
import { defineModel } from "white-engine";

// Every defineModel() exported from a file in scripts/ shows up in the editor.

export const box = defineModel({
    name: "box",
    label: "Box",
    params: {
        width: { type: "number", default: 1, min: 0.01, step: 0.1 },
        height: { type: "number", default: 1, min: 0.01, step: 0.1 },
        depth: { type: "number", default: 1, min: 0.01, step: 0.1 },
        color: { type: "color", default: "#00ff00" },
    },
    create: (p) =>
        new THREE.Mesh(
            new THREE.BoxGeometry(p.width, p.height, p.depth),
            new THREE.MeshStandardMaterial({ color: p.color })
        ),
});

export const sphere = defineModel({
    name: "sphere",
    label: "Sphere",
    params: {
        radius: { type: "number", default: 0.5, min: 0.01, step: 0.05 },
        color: { type: "color", default: "#ff0000" },
    },
    create: (p) =>
        new THREE.Mesh(
            new THREE.SphereGeometry(p.radius, 32, 32),
            new THREE.MeshStandardMaterial({ color: p.color })
        ),
});
