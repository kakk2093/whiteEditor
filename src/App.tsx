import { useEffect } from "react";
import type { CSSProperties } from "react";
import Viewport from "./components/Viewport";
import { assetChangedOnDisk, foldersChangedOnDisk, init, reloadScripts, save } from "./editor/core/actions";
import { onAssetChanged, onFoldersChanged, onScriptsChanged } from "./editor/core/project";
import { sceneStore } from "./editor/core/SceneStore";
import { useSceneStore } from "./editor/core/useSceneStore";
import Console, { ConsoleButton } from "./editor/Console";
import ContextMenuHost from "./editor/ContextMenuHost";
import Hierarchy from "./editor/Hierarchy";
import { useLayout } from "./editor/layout";
import { Splitter } from "./editor/Splitter";
import Inspector from "./editor/Inspector";
import ProjectPanel from "./editor/ProjectPanel";
import SettingsWindow from "./editor/SettingsWindow";
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

    // In the Game view the keys belong to the scripts of the running scene; an open window keeps them too
    if (sceneStore.gameKeys || sceneStore.settingsPage) return;

    const target = e.target as HTMLElement;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;

    const id = sceneStore.selectedId;
    if ((e.ctrlKey || e.metaKey) && (e.code === "KeyZ" || e.code === "KeyY")) {
        e.preventDefault();
        if (e.code === "KeyY" || e.shiftKey) sceneStore.redo();
        else sceneStore.undo();
    } else if ((e.ctrlKey || e.metaKey) && e.code === "KeyD") {
        e.preventDefault();
        sceneStore.duplicateSelected();
    } else if ((e.ctrlKey || e.metaKey) && e.code === "KeyG") {
        e.preventDefault();
        sceneStore.groupSelected();
    } else if (e.ctrlKey || e.metaKey || e.altKey || sceneStore.flying) {
        // While the right mouse button is held, the letter keys fly the camera (see Viewport)
        return;
    } else if (e.code === "F2") {
        e.preventDefault();
        sceneStore.startRename();
    } else if (e.code === "KeyX") {
        sceneStore.setGizmoSpace(sceneStore.gizmoSpace === "world" ? "local" : "world");
    } else if (e.code === "KeyF") {
        sceneStore.focus();
    } else if (e.code === "KeyW") {
        sceneStore.setGizmoMode("translate");
    } else if (e.code === "KeyE") {
        sceneStore.setGizmoMode("rotate");
    } else if (e.code === "KeyR") {
        sceneStore.setGizmoMode("scale");
    } else if (e.code === "Delete" && id) {
        sceneStore.removeSelected();
    } else if (e.code === "Escape") {
        sceneStore.select(null);
    }
}

// true if the keys and the clipboard belong to something else: a field being typed in, or the running game
function busy(e: Event) {
    return sceneStore.gameKeys || ["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement).tagName);
}

// Ctrl+C / Ctrl+X: the selected objects go to the clipboard as text, the JSON of a scene file
function onCopy(e: ClipboardEvent) {
    // Selected text on the page is copied as usual
    if (busy(e) || !window.getSelection()?.isCollapsed) return;
    const text = sceneStore.copySelected();
    if (!text) return;
    e.clipboardData?.setData("text/plain", text);
    e.preventDefault();
    if (e.type === "cut") sceneStore.removeSelected();
}

// Ctrl+V: objects from the clipboard, whoever put them there (this editor, another tab, a text editor)
function onPaste(e: ClipboardEvent) {
    if (busy(e)) return;
    if (sceneStore.paste(e.clipboardData?.getData("text/plain") || sceneStore.clipboard)) e.preventDefault();
}

export default function App() {
    const store = useSceneStore();
    const [layout, setLayout] = useLayout();

    useEffect(() => {
        init();
        const offScripts = onScriptsChanged(reloadScripts);
        const offAssets = onAssetChanged(assetChangedOnDisk);
        const offFolders = onFoldersChanged(foldersChangedOnDisk);
        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("copy", onCopy);
        window.addEventListener("cut", onCopy);
        window.addEventListener("paste", onPaste);
        return () => {
            offScripts();
            offAssets();
            offFolders();
            window.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("copy", onCopy);
            window.removeEventListener("cut", onCopy);
            window.removeEventListener("paste", onPaste);
        };
    }, []);

    return (
        <div
            className="app"
            // The sizes of the panels, which editor.css reads
            style={{ "--left-width": `${layout.left}px`, "--right-width": `${layout.right}px`, "--bottom-height": `${layout.bottom}px`, "--tree-width": `${layout.tree}px` } as CSSProperties}
            // The editor has its own right-click menus; text fields keep the browser one for copy and paste
            onContextMenu={(e) => {
                if (!["INPUT", "TEXTAREA"].includes((e.target as HTMLElement).tagName)) e.preventDefault();
            }}
        >
            <Toolbar />
            {store.project ? (
                <div className="main">
                    <Hierarchy />
                    <Splitter side="left" layout={layout} onChange={setLayout} />
                    <div className="center">
                        <Viewport />
                        <Splitter side="bottom" layout={layout} onChange={setLayout} />
                        <ProjectPanel layout={layout} onLayout={setLayout} />
                    </div>
                    <Splitter side="right" layout={layout} onChange={setLayout} />
                    <Inspector />
                </div>
            ) : (
                <Welcome />
            )}
            {store.project && store.consoleOpen && <Console />}
            <div className="statusbar">
                <ConsoleButton />
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
            <SettingsWindow />
            <ContextMenuHost />
        </div>
    );
}
