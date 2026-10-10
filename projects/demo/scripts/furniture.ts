import * as THREE from "three";
import { defineModel } from "white-engine";

export const desk = defineModel({
    name: "desk",
    label: "Desk",
    params: {
        length: { type: "number", default: 1.8, min: 0.4, step: 0.1 },
        width: { type: "number", default: 0.7, min: 0.3, step: 0.05 },
        color: { type: "color", default: "#d9d4c8" },
    },
    create: (p) => {
        const group = new THREE.Group();

        const top = new THREE.Mesh(
            new THREE.BoxGeometry(p.width, 0.04, p.length),
            new THREE.MeshStandardMaterial({ color: p.color })
        );
        top.position.y = 0.74;
        group.add(top);

        const legMat = new THREE.MeshStandardMaterial({ color: "#181818" });
        const legX = p.width / 2 - 0.05;
        const legZ = p.length / 2 - 0.15;
        for (const x of [-legX, legX]) {
            for (const z of [-legZ, legZ]) {
                const leg = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.73, 0.04), legMat);
                leg.position.set(x, 0.365, z);
                group.add(leg);
            }
        }
        return group;
    },
});
