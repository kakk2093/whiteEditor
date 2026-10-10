import { useEffect } from "react";
import Viewport from "./components/Viewport";
import { assetChangedOnDisk, init, reloadScripts, save } from "./editor/core/actions";
import { onAssetChanged, onScriptsChanged } from "./editor/core/project";
import { sceneStore } from "./editor/core/SceneStore";
import { useSceneStore } from "./editor/core/useSceneStore";
import ContextMenuHost from "./editor/ContextMenuHost";
import Hierarchy from "./editor/Hierarchy";
import Inspector from "./editor/Inspector";
import ProjectPanel from "./editor/ProjectPanel";
import Toolbar from "./editor/Toolbar";
import Welcome from "./editor/Welcome";
import "./editor/editor.css";

// Editor-wide shortcuts; ignored while typing in a field
function onKeyDown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyS") {
        e.preventDefault();
        save();
        return;
    }

    if ((e.ctrlKey || e.metaKey) && e.code === "KeyP") {
        e.preventDefault();
        if (!sceneStore.project) return;
        if (e.shiftKey) sceneStore.togglePause();
        else if (e.altKey) sceneStore.step();
        else if (sceneStore.playing) sceneStore.requestStop();
        else sceneStore.play();
        return;
    }

    // In the Game view the keys belong to the scripts of the running scene
    if (sceneStore.gameView) return;

    const target = e.target as HTMLElement;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;

    const id = sceneStore.selectedId;
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyD") {
        e.preventDefault();
        const copy = id && sceneStore.duplicate(id);
        if (copy) sceneStore.select(copy.id);
    } else if (e.ctrlKey || e.metaKey || e.altKey || sceneStore.flying) {
        // While the right mouse button is held, the letter keys fly the camera (see Viewport)
        return;
    } else if (e.code === "KeyF") {
        sceneStore.focus();
    } else if (e.code === "KeyW") {
        sceneStore.setGizmoMode("translate");
    } else if (e.code === "KeyE") {
        sceneStore.setGizmoMode("rotate");
    } else if (e.code === "KeyR") {
        sceneStore.setGizmoMode("scale");
    } else if (e.code === "Delete" && id) {
        sceneStore.removeEntity(id);
    } else if (e.code === "Escape") {
        sceneStore.select(null);
    }
}

export default function App() {
    const store = useSceneStore();

    useEffect(() => {
        init();
        const offScripts = onScriptsChanged(reloadScripts);
        const offAssets = onAssetChanged(assetChangedOnDisk);
        window.addEventListener("keydown", onKeyDown);
        return () => {
            offScripts();
            offAssets();
            window.removeEventListener("keydown", onKeyDown);
        };
    }, []);

    return (
        <div
            className="app"
            // The editor has its own right-click menus; text fields keep the browser one for copy and paste
            onContextMenu={(e) => {
                if (!["INPUT", "TEXTAREA"].includes((e.target as HTMLElement).tagName)) e.preventDefault();
            }}
        >
            <Toolbar />
            {store.project ? (
                <div className="main">
                    <Hierarchy />
                    <div className="center">
                        <Viewport />
                        <ProjectPanel />
                    </div>
                    <Inspector />
                </div>
            ) : (
                <Welcome />
            )}
            <div className="statusbar">
                <span className="message">{store.status}</span>
                <span><kbd>RMB</kbd>+<kbd>WASD</kbd> fly</span>
                <span><kbd>F</kbd> focus</span>
                <span><kbd>W</kbd> move</span>
                <span><kbd>E</kbd> rotate</span>
                <span><kbd>R</kbd> scale</span>
                <span><kbd>Del</kbd> delete</span>
                <span><kbd>Ctrl</kbd>+<kbd>D</kbd> duplicate</span>
                <span><kbd>Ctrl</kbd>+<kbd>S</kbd> save</span>
                <span><kbd>Ctrl</kbd>+<kbd>P</kbd> play</span>
            </div>
            <ContextMenuHost />
        </div>
    );
}
