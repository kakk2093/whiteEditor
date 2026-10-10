import { useState } from "react";
import { closePrefab, newProject, newScene, openProject, openScene, save, saveSceneAs } from "./core/actions";
import { useSceneStore } from "./core/useSceneStore";
import { Icon, NameDialog } from "./ui";

type Dialog = "project" | "scene" | "saveAs" | null;

const NEW = "__new__";

export default function Toolbar() {
    const store = useSceneStore();
    const { project, projects, sceneName, scenes, editingPrefab } = store;
    const [dialog, setDialog] = useState<Dialog>(null);

    // A new scene exists only in the editor until it is saved
    const sceneOptions = scenes.includes(sceneName) ? scenes : [...scenes, sceneName];

    return (
        <div className="topbar">
            <span className="brand">whiteEditor</span>

            <span className="label">Project</span>
            <select
                className="select"
                value={project}
                title="Switch project"
                onChange={(e) => (e.target.value === NEW ? setDialog("project") : openProject(e.target.value))}
            >
                {!project && <option value="">—</option>}
                {projects.map((p) => (
                    <option key={p} value={p}>{p}</option>
                ))}
                <option value={NEW}>+ New project…</option>
            </select>

            {project && !editingPrefab && (
                <>
                    <span className="sep" />
                    <span className="label">Scene</span>
                    <select
                        className="select"
                        value={sceneName}
                        title="Switch scene"
                        onChange={(e) => (e.target.value === NEW ? setDialog("scene") : openScene(e.target.value))}
                    >
                        {sceneOptions.map((s) => (
                            <option key={s} value={s}>{s}</option>
                        ))}
                        <option value={NEW}>+ New scene…</option>
                    </select>
                    {store.dirty && <span className="dirty-dot" title="Unsaved changes" />}
                    <button className="btn primary" onClick={save} title="Save the scene (Ctrl+S)">
                        <Icon name="save" /> Save
                    </button>
                    <button className="btn" onClick={() => setDialog("saveAs")} title="Save the scene under another name">
                        Save As…
                    </button>
                </>
            )}

            {project && editingPrefab && (
                <>
                    <span className="sep" />
                    <button className="btn" onClick={closePrefab} title="Save the prefab and return to the scene">
                        <Icon name="back" /> Back to scene “{sceneName}”
                    </button>
                    <span className="prefab-banner">
                        <Icon name="prefab" /> Prefab: {editingPrefab}
                    </span>
                    {store.dirty && <span className="dirty-dot" title="Unsaved changes" />}
                    <button className="btn primary" onClick={save} title="Save the prefab (Ctrl+S)">
                        <Icon name="save" /> Save
                    </button>
                </>
            )}

            {project && (
                <>
                    <span className="sep" />
                    <button
                        className={`btn ${store.playing ? "playing" : ""}`}
                        onClick={() => (store.playing ? store.stop() : store.play())}
                        title={store.playing
                            ? "Stop the scripts and bring the scene back (Ctrl+P)"
                            : "Run the scripts of the scene (Ctrl+P)"}
                    >
                        <Icon name={store.playing ? "stop" : "play"} /> {store.playing ? "Stop" : "Play"}
                    </button>
                </>
            )}

            {dialog === "project" && (
                <NameDialog
                    title="New project"
                    confirm="Create"
                    taken={projects}
                    onCancel={() => setDialog(null)}
                    onSubmit={(name) => {
                        setDialog(null);
                        newProject(name);
                    }}
                />
            )}
            {dialog === "scene" && (
                <NameDialog
                    title="New scene"
                    confirm="Create"
                    taken={scenes}
                    onCancel={() => setDialog(null)}
                    onSubmit={(name) => {
                        setDialog(null);
                        newScene(name);
                    }}
                />
            )}
            {dialog === "saveAs" && (
                <NameDialog
                    title="Save scene as"
                    confirm="Save"
                    initial={sceneName}
                    onCancel={() => setDialog(null)}
                    onSubmit={(name) => {
                        setDialog(null);
                        saveSceneAs(name);
                    }}
                />
            )}
        </div>
    );
}
