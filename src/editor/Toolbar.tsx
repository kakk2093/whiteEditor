import { useState } from "react";
import { buildGame, closePrefab, newProject, newScene, openProject, openScene, save, saveSceneAs } from "./core/actions";
import { useSceneStore } from "./core/useSceneStore";
import { Icon, NameDialog } from "./ui";

type Dialog = "project" | "scene" | "saveAs" | null;

const NEW = "__new__";

export default function Toolbar() {
    const store = useSceneStore();
    const { project, projects, sceneName, scenes, editingPrefab } = store;
    const [dialog, setDialog] = useState<Dialog>(null);
    const [building, setBuilding] = useState(false);
    // Where the game built in this session can be opened
    const [gameUrl, setGameUrl] = useState<string | null>(null);

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
                        onClick={() => (store.playing ? store.requestStop() : store.play())}
                        disabled={editingPrefab !== null}
                        title={editingPrefab
                            ? "Go back to the scene to play it"
                            : store.playing
                                ? "Stop the scene (Ctrl+P)"
                                : "Run the scene with its scripts (Ctrl+P)"}
                    >
                        <Icon name={store.playing ? "stop" : "play"} /> {store.playing ? "Stop" : "Play"}
                    </button>
                    <button
                        className={`btn ${store.paused ? "playing" : ""}`}
                        onClick={() => store.togglePause()}
                        disabled={!store.playing}
                        title={store.paused ? "Resume (Ctrl+Shift+P)" : "Pause: freeze the scene to look at it and edit it (Ctrl+Shift+P)"}
                    >
                        <Icon name="pause" />
                    </button>
                    <button
                        className="btn"
                        onClick={() => store.step()}
                        disabled={!store.playing}
                        title="Pause and move by one frame (Ctrl+Alt+P)"
                    >
                        <Icon name="step" />
                    </button>
                    <span className="sep" />
                    <button
                        className="btn"
                        disabled={building || editingPrefab !== null}
                        onClick={async () => {
                            setBuilding(true);
                            setGameUrl(await buildGame() ?? gameUrl);
                            setBuilding(false);
                        }}
                        title="Build the game into the project's build/ folder; it starts with the open scene"
                    >
                        <Icon name="build" /> {building ? "Building…" : "Build"}
                    </button>
                    {gameUrl && (
                        <a className="btn" href={gameUrl} target="_blank" rel="noreferrer" title="Open the built game in a new tab">
                            Open game ↗
                        </a>
                    )}
                </>
            )}

            {store.confirmingStop && (
                <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && store.cancelStop()}>
                    <div className="dialog">
                        <h3>Keep the changes made during Play?</h3>
                        <div className="buttons">
                            <button className="btn" onClick={() => store.cancelStop()}>Continue playing</button>
                            <button className="btn" onClick={() => store.stop(false)}>Discard</button>
                            <button className="btn primary" autoFocus onClick={() => store.stop(true)}>Keep</button>
                        </div>
                    </div>
                </div>
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
