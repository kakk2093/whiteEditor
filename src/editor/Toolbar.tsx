import { useState } from "react";
import { buildGame, closePrefab, newProject, newScene, openProject, openScene, save, saveSceneAs, showInExplorer } from "./core/actions";
import { useSceneStore } from "./core/useSceneStore";
import { contextMenuOwner, openContextMenu, useContextMenu } from "./contextMenu";
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
                        { label: building ? "Building…" : "Build Game", icon: "build", disabled: building, run: build },
                        { label: "Open Built Game", disabled: !gameUrl, run: () => void window.open(gameUrl ?? "", "_blank") }
                    ]
                },
                {
                    title: "Project",
                    items: [
                        { label: "New Project…", icon: "plus", run: () => setDialog("project") },
                        ...projects.filter((name) => name !== project).map((name) => ({ label: `Open ${name}`, icon: "folder" as const, run: () => void openProject(name) })),
                        ...(project ? [
                            { label: "Show Project in Explorer", icon: "folder" as const, run: () => void showInExplorer() },
                            { label: "Project Settings…", icon: "settings" as const, run: () => store.openSettings("project") }
                        ] : [])
                    ]
                }
            ]
        },
        {
            title: "Edit",
            sections: [
                {
                    items: [
                        { label: "Undo", icon: "undo", shortcut: "Ctrl+Z", disabled: !store.canUndo, run: () => store.undo() },
                        { label: "Redo", icon: "redo", shortcut: "Ctrl+Y", disabled: !store.canRedo, run: () => store.redo() }
                    ]
                },
                {
                    items: [
                        { label: "Copy", icon: "copy", shortcut: "Ctrl+C", disabled: !selected, run: copyToClipboard },
                        { label: "Duplicate", shortcut: "Ctrl+D", disabled: !selected, run: () => void store.duplicateSelected() },
                        { label: "Paste", shortcut: "Ctrl+V", disabled: !store.clipboard, run: () => void store.paste() },
                        { label: "Rename", shortcut: "F2", disabled: store.selectedIds.length !== 1, run: () => store.startRename() },
                        { label: "Group", icon: "folder", shortcut: "Ctrl+G", disabled: !selected, run: () => store.groupSelected() },
                        { label: "Delete", icon: "trash", shortcut: "Del", danger: true, disabled: !selected, run: () => store.removeSelected() }
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
                // A prefab that is being edited cannot be played
                items: [
                    store.playing
                        ? { label: "Stop", icon: "stop", shortcut: "Ctrl+P", run: () => store.requestStop() }
                        : { label: "Play", icon: "play", shortcut: "Ctrl+P", disabled: editingPrefab !== null, run: () => store.play() },
                    { label: store.paused ? "Resume" : "Pause", icon: "pause", shortcut: "Ctrl+Shift+P", disabled: !store.playing, run: () => store.togglePause() },
                    { label: "Step One Frame", icon: "step", shortcut: "Ctrl+Alt+P", disabled: !store.playing, run: () => store.step() }
                ]
            }, {
                // Only the editor: a built game always has its sound
                items: [{ label: store.muted ? "Unmute Sound" : "Mute Sound", icon: store.muted ? "sound" : "mute", run: () => store.setMuted(!store.muted) }]
            }]
        },
        {
            title: "Window",
            sections: [
                {
                    title: "Settings",
                    items: [
                        { label: "Project: game, tags, layers", icon: "folder", run: () => store.openSettings("project") },
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

    // The menu of the bar that is open now; with one open, the others open as the mouse comes over them
    const openMenu = useContextMenu()?.owner;
    const showMenu = (button: HTMLElement, menu: (typeof menus)[number]) => {
        const rect = button.getBoundingClientRect();
        const at = { clientX: rect.left, clientY: rect.bottom + 2, preventDefault: () => {}, stopPropagation: () => {} };
        openContextMenu(at, menu.sections, `menubar:${menu.title}`);
    };

    return (
        <div className="topbar">
            <span className="brand">whiteEditor</span>

            <div className="menubar">
                {shownMenus.map((menu) => (
                    <button
                        key={menu.title}
                        className={`menubar-item ${openMenu === `menubar:${menu.title}` ? "open" : ""}`}
                        // The list opens right under its name
                        onClick={(e) => showMenu(e.currentTarget, menu)}
                        onMouseEnter={(e) => {
                            const owner = contextMenuOwner();
                            if (owner?.startsWith("menubar:") && owner !== `menubar:${menu.title}`) showMenu(e.currentTarget, menu);
                        }}
                    >
                        {menu.title}
                    </button>
                ))}
            </div>
            <span className="sep" />

            {/* Another project is opened from the File menu: the bar keeps its middle for Play */}
            {project && <span className="project-name" title="The open project · File → Open … switches to another">{project}</span>}

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
                    {/* Play, Pause and Step: in the middle of what is left of the bar */}
                    {!editingPrefab && (
                        <div className="topbar-play">
                            <button
                                className={`btn play ${store.playing ? "playing" : ""}`}
                                onClick={() => (store.playing ? store.requestStop() : store.play())}
                                title={store.playing ? "Stop the scene (Ctrl+P)" : "Run the scene with its scripts (Ctrl+P)"}
                            >
                                <Icon name={store.playing ? "stop" : "play"} size={16} />
                            </button>
                            <button
                                className={`btn ${store.paused ? "playing" : ""}`}
                                onClick={() => store.togglePause()}
                                disabled={!store.playing}
                                title={store.paused ? "Resume (Ctrl+Shift+P)" : "Pause: freeze the scene to look at it and edit it (Ctrl+Shift+P)"}
                            >
                                <Icon name="pause" size={16} />
                            </button>
                            <button
                                className="btn"
                                onClick={() => store.step()}
                                disabled={!store.playing}
                                title="Pause and move by one frame (Ctrl+Alt+P)"
                            >
                                <Icon name="step" size={16} />
                            </button>
                        </div>
                    )}
                    {/* Undo, redo and the settings stand at the right end */}
                    <span className="spacer" />
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
