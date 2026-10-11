import { useState } from "react";
import { buildGame, closePrefab, newProject, newScene, openProject, openScene, save, saveSceneAs } from "./core/actions";
import { useSceneStore } from "./core/useSceneStore";
import { openContextMenu } from "./contextMenu";
import type { ContextSection } from "./contextMenu";
import { copyToClipboard, CREATE_MENU, createObject } from "./createMenu";
import { resetLayout } from "./layout";
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

    const build = async () => {
        setBuilding(true);
        setGameUrl(await buildGame() ?? gameUrl);
        setBuilding(false);
    };

    // The menu bar: everything the editor can do, by the usual names. What cannot be done now is left out.
    const selected = store.selectedIds.length > 0;
    const inScene = project !== "" && !editingPrefab;
    const menus: { title: string; sections: ContextSection[] }[] = [
        {
            title: "File",
            sections: [
                {
                    items: !inScene ? [] : [
                        { label: "New Scene…", icon: "plus", run: () => setDialog("scene") },
                        { label: "Save Scene", icon: "save", shortcut: "Ctrl+S", run: save },
                        { label: "Save Scene As…", run: () => setDialog("saveAs") }
                    ]
                },
                {
                    items: !editingPrefab ? [] : [
                        { label: "Save Prefab", icon: "save", shortcut: "Ctrl+S", run: save },
                        { label: "Back to Scene", icon: "back", run: closePrefab }
                    ]
                },
                {
                    title: inScene ? "Game" : undefined,
                    items: !inScene ? [] : [
                        { label: "Build Game", icon: "build", run: build },
                        ...(gameUrl ? [{ label: "Open Built Game", run: () => void window.open(gameUrl, "_blank") }] : [])
                    ]
                },
                {
                    title: "Project",
                    items: [
                        { label: "New Project…", icon: "plus", run: () => setDialog("project") },
                        ...projects.filter((name) => name !== project).map((name) => ({ label: `Open ${name}`, icon: "folder" as const, run: () => void openProject(name) })),
                        ...(project ? [{ label: "Project Settings…", icon: "settings" as const, run: () => store.openSettings("project") }] : [])
                    ]
                }
            ]
        },
        {
            title: "Edit",
            sections: [
                {
                    items: [
                        ...(store.canUndo ? [{ label: "Undo", icon: "undo" as const, shortcut: "Ctrl+Z", run: () => store.undo() }] : []),
                        ...(store.canRedo ? [{ label: "Redo", icon: "redo" as const, shortcut: "Ctrl+Y", run: () => store.redo() }] : [])
                    ]
                },
                {
                    items: [
                        ...(selected ? [
                            { label: "Copy", icon: "copy" as const, shortcut: "Ctrl+C", run: copyToClipboard },
                            { label: "Duplicate", shortcut: "Ctrl+D", run: () => void store.duplicateSelected() }
                        ] : []),
                        ...(store.clipboard ? [{ label: "Paste", shortcut: "Ctrl+V", run: () => void store.paste() }] : []),
                        ...(selected ? [
                            { label: "Rename", shortcut: "F2", run: () => store.startRename() },
                            { label: "Group", icon: "folder" as const, shortcut: "Ctrl+G", run: () => store.groupSelected() },
                            { label: "Delete", icon: "trash" as const, shortcut: "Del", danger: true, run: () => store.removeSelected() }
                        ] : [])
                    ]
                },
                { items: [{ label: "Editor Settings…", icon: "settings", run: () => store.openSettings("editor") }] }
            ]
        },
        {
            // Like Unity's GameObject menu; with one object selected the new one becomes its child
            title: "Object",
            sections: CREATE_MENU.map((section, i) => ({
                title: section.title ?? (i === 0 ? (store.selectedIds.length === 1 ? `Create under ${store.selected?.name}` : "Create") : undefined),
                items: section.items.map((item) => ({
                    label: item.label,
                    icon: item.icon,
                    run: () => createObject(item, store.selectedIds.length === 1 ? store.selectedId : null)
                }))
            }))
        },
        {
            title: "Play",
            sections: [{
                items: editingPrefab ? [] : [
                    store.playing
                        ? { label: "Stop", icon: "stop", shortcut: "Ctrl+P", run: () => store.requestStop() }
                        : { label: "Play", icon: "play", shortcut: "Ctrl+P", run: () => store.play() },
                    ...(store.playing ? [
                        { label: store.paused ? "Resume" : "Pause", icon: "pause" as const, shortcut: "Ctrl+Shift+P", run: () => store.togglePause() },
                        { label: "Step One Frame", icon: "step" as const, shortcut: "Ctrl+Alt+P", run: () => store.step() }
                    ] : [])
                ]
            }]
        },
        {
            title: "Window",
            sections: [
                {
                    title: "Settings",
                    items: [
                        { label: "Project: collision layers", icon: "folder", run: () => store.openSettings("project") },
                        { label: "Scene: environment", icon: "scene", run: () => store.openSettings("scene") },
                        { label: "Editor: gizmo, viewport, panels", icon: "settings", run: () => store.openSettings("editor") }
                    ]
                },
                {
                    items: [
                        { label: store.consoleOpen ? "Close Console" : "Console", icon: "script", run: () => store.setConsoleOpen(!store.consoleOpen) },
                        { label: "Reset Panel Sizes", run: resetLayout }
                    ]
                }
            ]
        },
        {
            title: "Help",
            sections: [{ items: [{ label: "Controls: mouse and keys", run: () => store.openSettings("controls") }] }]
        }
    ];
    // Without a project there is only what opens one
    const shownMenus = project ? menus : menus.slice(0, 1);

    return (
        <div className="topbar">
            <span className="brand">whiteEditor</span>

            <div className="menubar">
                {shownMenus.map((menu) => (
                    <button
                        key={menu.title}
                        className="menubar-item"
                        onClick={(e) => {
                            // The list opens right under its name
                            const rect = e.currentTarget.getBoundingClientRect();
                            openContextMenu({ clientX: rect.left, clientY: rect.bottom + 2, preventDefault: () => {}, stopPropagation: () => {} }, menu.sections);
                        }}
                    >
                        {menu.title}
                    </button>
                ))}
            </div>
            <span className="sep" />

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
                </>
            )}

            {project && (
                <>
                    <span className="sep" />
                    <button className="btn ghost" onClick={() => store.undo()} disabled={!store.canUndo} title="Undo (Ctrl+Z)">
                        <Icon name="undo" />
                    </button>
                    <button className="btn ghost" onClick={() => store.redo()} disabled={!store.canRedo} title="Redo (Ctrl+Y or Ctrl+Shift+Z)">
                        <Icon name="redo" />
                    </button>
                    <span className="sep" />
                    <button className="btn ghost" onClick={() => store.openSettings("project")} title="Settings">
                        <Icon name="settings" />
                    </button>
                    {building && <span className="label">Building the game…</span>}
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
