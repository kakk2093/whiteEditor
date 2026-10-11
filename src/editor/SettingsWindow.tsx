import { useEffect } from "react";
import { environmentFields } from "../engine";
import type { EnvironmentData, Params } from "../engine";
import { Fields, LayersSection, Section } from "./Inspector";
import { resetLayout } from "./layout";
import type { SettingsPage } from "./core/SceneStore";
import { useSceneStore } from "./core/useSceneStore";
import { Icon } from "./ui";
import type { IconName } from "./ui";

const PAGES: { key: SettingsPage; title: string; icon: IconName; about: string }[] = [
    { key: "project", title: "Project", icon: "folder", about: "What belongs to the whole project; kept in project.json" },
    { key: "scene", title: "Scene", icon: "scene", about: "The settings of the open scene; saved with it" },
    { key: "editor", title: "Editor", icon: "settings", about: "How the editor itself behaves; kept in this browser, not in the project" },
    { key: "controls", title: "Controls", icon: "move", about: "The mouse and the keys of the editor" }
];

// What the mouse and the keys do, by where they act
const CONTROLS: { title: string; rows: [string, string][] }[] = [
    {
        title: "Viewport",
        rows: [
            ["Click", "Select an object; Ctrl-click adds or removes one"],
            ["Drag", "Turn the camera around"],
            ["Shift + drag", "Select with a frame; with Ctrl adds to the selection"],
            ["Middle drag", "Move the camera sideways"],
            ["Wheel", "Closer / farther"],
            ["Hold right button", "Look around; W A S D fly, Q E down / up, Shift faster"],
            ["Right-click", "Menu of the object or of the scene"],
            ["F", "Bring the camera to the selected object"]
        ]
    },
    {
        title: "Objects",
        rows: [
            ["W / E / R", "Move / rotate / scale gizmo"],
            ["X", "Axes of the gizmo: world / local"],
            ["Del", "Delete"],
            ["Ctrl + D", "Duplicate"],
            ["Ctrl + G", "Group under a new parent"],
            ["Ctrl + C / X / V", "Copy / cut / paste (as text: works between scenes)"],
            ["F2", "Rename in the Hierarchy"],
            ["Esc", "Clear the selection"]
        ]
    },
    {
        title: "Hierarchy",
        rows: [
            ["Double-click", "Bring the camera to the object"],
            ["Shift-click", "Select a range of rows"],
            ["Drag a row", "Onto the middle of another: make it a child; onto its top or bottom edge: put it above or below"]
        ]
    },
    {
        title: "Scene and Play",
        rows: [
            ["Ctrl + S", "Save"],
            ["Ctrl + Z / Ctrl + Y", "Undo / redo"],
            ["Ctrl + P", "Play / stop"],
            ["Ctrl + Shift + P", "Pause"],
            ["Ctrl + Alt + P", "One frame forward"]
        ]
    },
    {
        title: "Fields and panels",
        rows: [
            ["Drag a number", "Change it; Shift ten times faster, Alt ten times finer"],
            ["Drag a panel border", "Resize the panel; double-click for the default size"],
            ["Right-click a marked field", "Revert it to what the prefab gives"]
        ]
    }
];

// The Settings window: everything that is set once and is not a property of a selected thing, in one place
export default function SettingsWindow() {
    const store = useSceneStore();
    const page = store.settingsPage;

    useEffect(() => {
        if (!page) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") store.openSettings(null);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [page, store]);

    if (!page) return null;
    const current = PAGES.find((p) => p.key === page) ?? PAGES[0];

    return (
        <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && store.openSettings(null)}>
            <div className="dialog settings">
                <div className="settings-nav">
                    <h3>Settings</h3>
                    {PAGES.map((p) => (
                        <div key={p.key} className={`settings-tab ${p.key === current.key ? "active" : ""}`} onClick={() => store.openSettings(p.key)}>
                            <Icon name={p.icon} /> {p.title}
                        </div>
                    ))}
                </div>
                <div className="settings-page">
                    <div className="settings-head">
                        <b>{current.title}</b>
                        <span>{current.about}</span>
                        <span style={{ flex: 1 }} />
                        <button className="btn ghost" title="Close (Esc)" onClick={() => store.openSettings(null)}>
                            <Icon name="close" />
                        </button>
                    </div>
                    <div className="settings-body">
                        {current.key === "project" && (
                            <>
                                <Section title="Project">
                                    <div className="field">
                                        <label>Name</label>
                                        <div className="control">{store.project}</div>
                                    </div>
                                    <div className="field">
                                        <label>Folder</label>
                                        <div className="control">projects/{store.project}/</div>
                                    </div>
                                    <div className="field">
                                        <label>Contains</label>
                                        <div className="control">
                                            {store.scenes.length} scenes · {store.registry.materialNames().length} materials ·{" "}
                                            {store.registry.prefabNames().length} prefabs · {store.registry.lookNames().length} looks
                                        </div>
                                    </div>
                                </Section>
                                <LayersSection />
                            </>
                        )}

                        {current.key === "scene" && (
                            store.editingPrefab ? (
                                <div className="empty">A prefab is open. Go back to the scene to change its settings.</div>
                            ) : (
                                <Section title={`Environment of the scene ${store.sceneName}`}>
                                    <Fields
                                        defs={environmentFields}
                                        values={store.environment as unknown as Params}
                                        onChange={(key, value) => store.setEnvironment(key as keyof EnvironmentData, value as never)}
                                    />
                                </Section>
                            )
                        )}

                        {current.key === "editor" && (
                            <>
                                <Section title="Gizmo">
                                    <div className="field">
                                        <label title="The gizmo moves by whole steps, turns by 15° and scales by 0.25">Snap</label>
                                        <div className="control">
                                            <input className="checkbox" type="checkbox" checked={store.snap} onChange={(e) => store.setSnap(e.target.checked)} />
                                        </div>
                                    </div>
                                    <div className="field">
                                        <label>Snap step</label>
                                        <div className="control">
                                            <select className="select" value={store.snapStep} onChange={(e) => store.setSnap(store.snap, Number(e.target.value))}>
                                                {[0.1, 0.25, 0.5, 1, 2].map((step) => <option key={step} value={step}>{step} m</option>)}
                                            </select>
                                        </div>
                                    </div>
                                    <div className="field">
                                        <label title="World: along the axes of the scene. Local: turned with the object">Axes</label>
                                        <div className="control">
                                            <select className="select" value={store.gizmoSpace} onChange={(e) => store.setGizmoSpace(e.target.value as "world" | "local")}>
                                                <option value="world">World</option>
                                                <option value="local">Local</option>
                                            </select>
                                        </div>
                                    </div>
                                </Section>
                                <Section title="Viewport">
                                    <div className="field">
                                        <label title="Off draws the plain scene, easier to arrange. The game always has its look">Show the look</label>
                                        <div className="control">
                                            <input className="checkbox" type="checkbox" checked={store.lookEnabled} onChange={(e) => store.setLookEnabled(e.target.checked)} />
                                        </div>
                                    </div>
                                </Section>
                                <Section title="Panels">
                                    <div className="field">
                                        <label>Sizes</label>
                                        <div className="control">
                                            <button className="btn" onClick={resetLayout}>Reset to default</button>
                                        </div>
                                    </div>
                                </Section>
                            </>
                        )}

                        {current.key === "controls" && CONTROLS.map((group) => (
                            <Section key={group.title} title={group.title}>
                                {group.rows.map(([keys, what]) => (
                                    <div key={keys} className="field controls-row">
                                        <label>{keys}</label>
                                        <div className="control">{what}</div>
                                    </div>
                                ))}
                            </Section>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
