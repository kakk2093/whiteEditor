import { useEffect, useState } from "react";
import { sceneStore } from "./core/SceneStore";

export default function Hierarchy() {
    const [objects, setObjects] = useState(sceneStore.objects);
    const [selected, setSelected] = useState(sceneStore.selected);

    useEffect(() => {
        const unsubscribe = sceneStore.subscribe(() => {
            setObjects([...sceneStore.objects]);
            setSelected(sceneStore.selected);
        });
        return unsubscribe;
    }, []);

    return (
        <div style={{ width: 250, background: "#1e1e1e", color: "#fff", overflowY: "auto", height: "100%", flexShrink: 0 }}>
            <h3 style={{ padding: 10 }}>Hierarchy</h3>

            <div style={{ padding: 10, display: "flex", gap: 5, flexWrap: "wrap" }}>
                <button
                    onClick={() => sceneStore.createCube()}
                    style={{
                        padding: "8px 12px",
                        background: "#0e639c",
                        color: "#fff",
                        border: "none",
                        cursor: "pointer",
                        borderRadius: 4
                    }}
                >
                    Add Cube
                </button>
                <button
                    onClick={() => sceneStore.createSphere()}
                    style={{
                        padding: "8px 12px",
                        background: "#0e639c",
                        color: "#fff",
                        border: "none",
                        cursor: "pointer",
                        borderRadius: 4
                    }}
                >
                    Add Sphere
                </button>
            </div>

            <div style={{ padding: 10 }}>
                {objects.map((obj) => (
                    <div
                        key={obj.uuid}
                        onClick={() => sceneStore.select(obj)}
                        style={{
                            padding: "8px 10px",
                            cursor: "pointer",
                            background: selected === obj ? "#0e639c" : "transparent",
                            marginBottom: 2,
                            borderRadius: 3,
                            fontSize: 13,
                            userSelect: "none"
                        }}
                    >
                        {obj.name}
                    </div>
                ))}
                {objects.length === 0 && (
                    <p style={{ color: "#666", fontSize: 12 }}>No objects</p>
                )}
            </div>
        </div>
    );
}