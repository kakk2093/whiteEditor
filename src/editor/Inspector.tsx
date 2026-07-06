import { useEffect, useState } from "react";
import { sceneStore } from "./core/SceneStore";

export default function Inspector() {
    const [selected, setSelected] = useState(sceneStore.selected);

    useEffect(() => {
        const unsubscribe = sceneStore.subscribe(() => {
            setSelected(sceneStore.selected);
        });
        return unsubscribe;
    }, []);

    if (!selected) {
        return (
            <div style={{ width: 250, padding: 10, color: "#999", height: "100%", flexShrink: 0 }}>
                <h3>Inspector</h3>
                No selection
            </div>
        );
    }

    const getNumValue = (val: any) => {
        return typeof val === 'number' ? val.toFixed(2) : '0.00';
    };

    const handleChange = (axis: "x" | "y" | "z", property: "position" | "rotation" | "scale", value: number) => {
        if (selected && selected[property]) {
            (selected[property][axis] as any) = value;
            sceneStore.updateObject();
        }
    };

    return (
        <div
            style={{
                width: 250,
                background: "#1e1e1e",
                color: "#fff",
                padding: 10,
                overflowY: "auto",
                height: "100%",
                flexShrink: 0
            }}
        >
            <h3>Inspector</h3>
            <p style={{ fontSize: 12, color: "#999" }}>Name: {selected?.name || "Unknown"}</p>

            {/* POSITION */}
            <div style={{ marginBottom: 20 }}>
                <h4>Position</h4>
                <div style={{ display: "flex", gap: 5, marginBottom: 5 }}>
                    <label style={{ flex: 1 }}>X</label>
                    <input
                        type="number"
                        step={0.1}
                        value={getNumValue(selected?.position?.x)}
                        onChange={(e) => handleChange("x", "position", Number(e.target.value))}
                        style={{ flex: 2 }}
                    />
                </div>
                <div style={{ display: "flex", gap: 5, marginBottom: 5 }}>
                    <label style={{ flex: 1 }}>Y</label>
                    <input
                        type="number"
                        step={0.1}
                        value={getNumValue(selected?.position?.y)}
                        onChange={(e) => handleChange("y", "position", Number(e.target.value))}
                        style={{ flex: 2 }}
                    />
                </div>
                <div style={{ display: "flex", gap: 5 }}>
                    <label style={{ flex: 1 }}>Z</label>
                    <input
                        type="number"
                        step={0.1}
                        value={getNumValue(selected?.position?.z)}
                        onChange={(e) => handleChange("z", "position", Number(e.target.value))}
                        style={{ flex: 2 }}
                    />
                </div>
            </div>

            {/* ROTATION */}
            <div style={{ marginBottom: 20 }}>
                <h4>Rotation</h4>
                <div style={{ display: "flex", gap: 5, marginBottom: 5 }}>
                    <label style={{ flex: 1 }}>X</label>
                    <input
                        type="number"
                        step={0.1}
                        value={getNumValue(selected?.rotation?.x)}
                        onChange={(e) => handleChange("x", "rotation", Number(e.target.value))}
                        style={{ flex: 2 }}
                    />
                </div>
                <div style={{ display: "flex", gap: 5, marginBottom: 5 }}>
                    <label style={{ flex: 1 }}>Y</label>
                    <input
                        type="number"
                        step={0.1}
                        value={getNumValue(selected?.rotation?.y)}
                        onChange={(e) => handleChange("y", "rotation", Number(e.target.value))}
                        style={{ flex: 2 }}
                    />
                </div>
                <div style={{ display: "flex", gap: 5 }}>
                    <label style={{ flex: 1 }}>Z</label>
                    <input
                        type="number"
                        step={0.1}
                        value={getNumValue(selected?.rotation?.z)}
                        onChange={(e) => handleChange("z", "rotation", Number(e.target.value))}
                        style={{ flex: 2 }}
                    />
                </div>
            </div>

            {/* SCALE */}
            <div style={{ marginBottom: 20 }}>
                <h4>Scale</h4>
                <div style={{ display: "flex", gap: 5, marginBottom: 5 }}>
                    <label style={{ flex: 1 }}>X</label>
                    <input
                        type="number"
                        step={0.1}
                        value={getNumValue(selected?.scale?.x)}
                        onChange={(e) => handleChange("x", "scale", Number(e.target.value))}
                        style={{ flex: 2 }}
                    />
                </div>
                <div style={{ display: "flex", gap: 5, marginBottom: 5 }}>
                    <label style={{ flex: 1 }}>Y</label>
                    <input
                        type="number"
                        step={0.1}
                        value={getNumValue(selected?.scale?.y)}
                        onChange={(e) => handleChange("y", "scale", Number(e.target.value))}
                        style={{ flex: 2 }}
                    />
                </div>
                <div style={{ display: "flex", gap: 5 }}>
                    <label style={{ flex: 1 }}>Z</label>
                    <input
                        type="number"
                        step={0.1}
                        value={getNumValue(selected?.scale?.z)}
                        onChange={(e) => handleChange("z", "scale", Number(e.target.value))}
                        style={{ flex: 2 }}
                    />
                </div>
            </div>
        </div>
    );
}