import { useState } from "react";
import { defaultMaterialData } from "../engine";
import { createLook, createMaterial, createPrefab, newScene, openPrefab, openScene } from "./core/actions";
import { ENTITY_DRAG_TYPE, instantiateModel, setDraggedAsset } from "./core/dnd";
import type { AssetRef } from "./core/SceneStore";
import { useSceneStore } from "./core/useSceneStore";
import { Icon, NameDialog } from "./ui";
import type { IconName } from "./ui";

type Kind = AssetRef["kind"];

const TABS: { kind: Kind; title: string; icon: IconName; hint: string }[] = [
    { kind: "scene", title: "Scenes", icon: "scene", hint: "Double-click a scene to open it" },
    { kind: "material", title: "Materials", icon: "material", hint: "Click to edit · drag onto an object to assign" },
    { kind: "prefab", title: "Prefabs", icon: "prefab", hint: "Drag into the scene · double-click to edit · drop an object here to make a prefab" },
    { kind: "model", title: "Models", icon: "script", hint: "Models built by code in scripts/ · drag or double-click to add to the scene" },
    { kind: "look", title: "Looks", icon: "look", hint: "Render styles · click to edit · double-click or drag into the scene to use" }
];

interface Item {
    name: string;
    label: string;
    // CSS color of a material
    color?: string;
}

// The assets of the open project, like Unity's Project window
export default function ProjectPanel() {
    const store = useSceneStore();
    const [kind, setKind] = useState<Kind>("scene");
    const [naming, setNaming] = useState(false);
    const { registry } = store;

    const itemsOf = (k: Kind): Item[] => {
        if (k === "scene") return store.scenes.map((name) => ({ name, label: name }));
        if (k === "prefab") return registry.prefabNames().map((name) => ({ name, label: name }));
        if (k === "model") return registry.models().map((m) => ({ name: m.name, label: m.label ?? m.name }));
        if (k === "look") return registry.lookNames().map((name) => ({ name, label: name }));
        return registry.materialNames().map((name) => ({
            name,
            label: name,
            color: registry.getMaterialData(name)?.color ?? defaultMaterialData.color
        }));
    };

    const tab = TABS.find((t) => t.kind === kind)!;
    const items = itemsOf(kind);

    const activate = (name: string) => {
        if (kind === "scene") openScene(name);
        if (kind === "prefab") openPrefab(name);
        if (kind === "model") instantiateModel(name);
        if (kind === "look") store.setEnvironment("look", name);
    };

    return (
        <div className="panel bottom">
            <div className="tabs">
                {TABS.map((t) => (
                    <div key={t.kind} className={`tab ${t.kind === kind ? "active" : ""}`} onClick={() => setKind(t.kind)}>
                        <Icon name={t.icon} /> {t.title} <span className="count">{itemsOf(t.kind).length}</span>
                    </div>
                ))}
                <span className="spacer" />
                <span className="hint">{tab.hint}</span>
            </div>

            <div
                className="panel-body tiles"
                // An object dragged here from the Hierarchy becomes a prefab
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                    const entityId = e.dataTransfer.getData(ENTITY_DRAG_TYPE);
                    if (!entityId) return;
                    e.preventDefault();
                    setKind("prefab");
                    createPrefab(entityId);
                }}
            >
                {kind === "scene" && (
                    <div className="tile add" onClick={() => setNaming(true)} title="Create a new scene">
                        <div className="tile-preview"><Icon name="plus" size={18} /></div>
                        <div className="tile-name">New Scene</div>
                    </div>
                )}
                {kind === "material" && (
                    <div className="tile add" onClick={createMaterial} title="Create a new material">
                        <div className="tile-preview"><Icon name="plus" size={18} /></div>
                        <div className="tile-name">New Material</div>
                    </div>
                )}

                {kind === "look" && (
                    <div className="tile add" onClick={createLook} title="Create a new look">
                        <div className="tile-preview"><Icon name="plus" size={18} /></div>
                        <div className="tile-name">New Look</div>
                    </div>
                )}

                {items.map((item) => {
                    const selected = store.selectedAsset?.kind === kind && store.selectedAsset.name === item.name;
                    const current = (kind === "scene" && item.name === store.sceneName)
                        || (kind === "look" && item.name === store.environment.look);
                    return (
                        <div
                            key={item.name}
                            className={`tile ${selected ? "selected" : ""} ${current ? "current" : ""}`}
                            title={current ? `${item.label} (${kind === "look" ? "used by the scene" : "open"})` : item.label}
                            draggable={kind !== "scene"}
                            onDragStart={(e) => setDraggedAsset(e, { kind, name: item.name })}
                            onClick={() => store.selectAsset({ kind, name: item.name })}
                            onDoubleClick={() => activate(item.name)}
                        >
                            {item.color ? (
                                <div className="tile-preview material" style={{ background: item.color }} />
                            ) : (
                                <div className={`tile-preview ${kind}`}><Icon name={tab.icon} size={20} /></div>
                            )}
                            <div className="tile-name">{item.label}</div>
                        </div>
                    );
                })}

                {items.length === 0 && kind === "prefab" && (
                    <div className="empty">
                        No prefabs yet. Select an object and press <b>Create Prefab</b> in the Inspector, or drag it here from the Hierarchy.
                    </div>
                )}
                {items.length === 0 && kind === "model" && (
                    <div className="empty">
                        No code models. Export <b>defineModel(...)</b> from a file in the project's scripts/ folder.
                    </div>
                )}
            </div>

            {naming && (
                <NameDialog
                    title="New scene"
                    confirm="Create"
                    taken={store.scenes}
                    onCancel={() => setNaming(false)}
                    onSubmit={(name) => {
                        setNaming(false);
                        newScene(name);
                    }}
                />
            )}
        </div>
    );
}
