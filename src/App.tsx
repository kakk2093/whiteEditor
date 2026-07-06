import { useEffect, useState } from "react";

import { sceneStore } from "./editor/core/SceneStore";
import Hierarchy from "./editor/Hierarchy";
import Viewport from "./components/Viewport";
import Inspector from "./editor/Inspector";

export default function App() {
    const [, setTick] = useState(0);

    useEffect(() => {
        // Subscribe to scene changes
        const unsubscribe = sceneStore.subscribe(() => {
            setTick((t) => t + 1);
        });

        return unsubscribe;
    }, []);

    return (
        <div style={{ display: "flex", height: "100vh", background: "#121212", width: "100vw", overflow: "hidden" }}>
            <Hierarchy />
            <Viewport />
            <Inspector />
        </div>
    );
}