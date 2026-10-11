import { useState } from "react";
import type { MouseEvent } from "react";
import { builtinEffects, builtinSurfaces, defaultMaterialData } from "../engine";
import {
    addToLook, createLook, createMaterial, createPrefab, deleteLook, deleteMaterial, deletePrefab, deleteScene,
    deleteTexture, duplicateAsset, newScene, openPrefab, openScene, uploadTextures
} from "./core/actions";
import { confirmAt, openContextMenu } from "./contextMenu";
import type { ContextItem } from "./contextMenu";
import { ENTITY_DRAG_TYPE, instantiateModel, instantiatePrefab, setDraggedAsset } from "./core/dnd";
import type { AssetRef } from "./core/SceneStore";
import { useSceneStore } from "./core/useSceneStore";
import { Icon, NameDialog } from "./ui";
import type { IconName } from "./ui";

type Kind = AssetRef["kind"];

// A tab shows the assets of one kind; "script" gathers what the scripts define besides models
type TabKey = "scene" | "material" | "texture" | "prefab" | "model" | "look" | "script";

const TABS: { key: TabKey; title: string; icon: IconName; hint: string }[] = [
    { key: "scene", title: "Scenes", icon: "scene", hint: "Double-click a scene to open it · right-click for more" },
    { key: "material", title: "Materials", icon: "material", hint: "Click to edit · drag onto an object to assign" },
    { key: "texture", title: "Textures", icon: "image", hint: "Images of assets/ · drop image files here to add · drag onto an object to give it a material with the texture" },
    { key: "prefab", title: "Prefabs", icon: "prefab", hint: "Drag into the scene · double-click to edit · drop an object here to make a prefab" },
    { key: "model", title: "Models", icon: "script", hint: "Models built by code in scripts/ · drag or double-click to add to the scene" },
    { key: "look", title: "Looks", icon: "look", hint: "Render styles · click to edit · double-click or drag into the scene to use" },
    { key: "script", title: "Scripts", icon: "script", hint: "Behaviors, effects and surfaces · click to see params · drag a behavior onto an object" }
];

const ICONS: Record<Kind, IconName> = {
    scene: "scene",
    material: "material",
    prefab: "prefab",
    model: "script",
    look: "look",
    texture: "image",
    behavior: "script",
    effect: "look",
    surface: "cube",
};

interface Item {
    kind: Kind;
    name: string;
    label: string;
    // CSS color of a material
    color?: string;
    // Address of the picture of a texture
    image?: string;
    // A second line under the name: what kind of script thing it is
    note?: string;
}

// The assets of the open project, like Unity's Project window
export default function ProjectPanel() {
    const store = useSceneStore();
    const [tabKey, setTabKey] = useState<TabKey>("scene");
    const [naming, setNaming] = useState(false);
    const { registry } = store;

    const itemsOf = (key: TabKey): Item[] => {
        if (key === "scene") return store.scenes.map((name) => ({ kind: "scene", name, label: name }));
        if (key === "prefab") return registry.prefabNames().map((name) => ({ kind: "prefab", name, label: name }));
        if (key === "model") return registry.models().map((m) => ({ kind: "model", name: m.name, label: m.label ?? m.name }));
        if (key === "look") return registry.lookNames().map((name) => ({ kind: "look", name, label: name }));
        if (key === "texture") return registry.textureNames().map((name) => ({ kind: "texture", name, label: name, image: registry.textureUrl(name) }));
        if (key === "script") {
            return [
                ...registry.behaviors().map((d): Item => ({ kind: "behavior", name: d.name, label: d.label ?? d.name, note: "behavior" })),
                ...registry.effects().map((d): Item => ({
                    kind: "effect", name: d.name, label: d.label ?? d.name, note: builtinEffects.includes(d) ? "effect · built-in" : "effect"
                })),
                ...registry.surfaces().map((d): Item => ({
                    kind: "surface", name: d.name, label: d.label ?? d.name, note: builtinSurfaces.includes(d) ? "surface · built-in" : "surface"
                })),
            ];
        }
        return registry.materialNames().map((name) => ({
            kind: "material",
            name,
            label: name,
            color: registry.getMaterialData(name)?.color ?? defaultMaterialData.color
        }));
    };

    const tab = TABS.find((t) => t.key === tabKey)!;
    const items = itemsOf(tabKey);

    const addBehavior = (name: string) => {
        if (store.selectedId) store.addComponent(store.selectedId, "script", name);
        else store.update({ status: "Select an object to put the behavior on" });
    };

    // What a double click does
    const activate = (item: Item) => {
        if (item.kind === "scene") openScene(item.name);
        if (item.kind === "prefab") openPrefab(item.name);
        if (item.kind === "model") instantiateModel(item.name);
        if (item.kind === "look") store.setEnvironment("look", item.name);
        if (item.kind === "behavior") addBehavior(item.name);
        if (item.kind === "effect") addToLook("effects", item.name);
        if (item.kind === "surface") addToLook("surfaces", item.name);
    };

    const itemMenu = (e: MouseEvent, item: Item) => {
        store.selectAsset({ kind: item.kind, name: item.name });
        const { kind, name } = item;
        const menu: ContextItem[] = [];
        // Deleting a scene or a prefab cannot be undone, so it asks first, at the same place
        const at = { clientX: e.clientX, clientY: e.clientY };
        const sure = (run: () => void) => () => confirmAt(at, `Delete ${kind} ${name}? This cannot be undone`, "Delete", run);
        if (kind === "scene") {
            if (name !== store.sceneName) {
                menu.push({ label: "Open", icon: "scene", run: () => openScene(name) });
                menu.push({ label: "Delete…", icon: "trash", danger: true, run: sure(() => deleteScene(name)) });
            }
        } else if (kind === "material") {
            menu.push({ label: "Duplicate", icon: "copy", run: () => duplicateAsset("material", name) });
            menu.push({ label: "Delete", icon: "trash", danger: true, run: () => deleteMaterial(name) });
        } else if (kind === "prefab") {
            menu.push({ label: "Edit Prefab", icon: "prefab", run: () => openPrefab(name) });
            menu.push({ label: "Add to Scene", icon: "plus", run: () => instantiatePrefab(name) });
            menu.push({ label: "Delete…", icon: "trash", danger: true, run: sure(() => deletePrefab(name)) });
        } else if (kind === "model") {
            menu.push({ label: "Add to Scene", icon: "plus", run: () => instantiateModel(name) });
        } else if (kind === "look") {
            if (name !== store.environment.look) menu.push({ label: "Use in This Scene", icon: "look", run: () => store.setEnvironment("look", name) });
            menu.push({ label: "Duplicate", icon: "copy", run: () => duplicateAsset("look", name) });
            menu.push({ label: "Delete", icon: "trash", danger: true, run: () => deleteLook(name) });
        } else if (kind === "texture") {
            menu.push({ label: "Delete…", icon: "trash", danger: true, run: sure(() => deleteTexture(name)) });
        } else if (kind === "behavior") {
            menu.push({ label: "Add to Selected Object", icon: "plus", run: () => addBehavior(name) });
        } else {
            menu.push({ label: "Add to the Look of the Scene", icon: "plus", run: () => addToLook(kind === "effect" ? "effects" : "surfaces", name) });
        }
        openContextMenu(e, [{ items: menu }]);
    };

    // Right-click on the empty part of the panel: what can be created on this tab
    const panelMenu = (e: MouseEvent) => {
        const menu: ContextItem[] = [];
        if (tabKey === "scene") menu.push({ label: "New Scene…", icon: "plus", run: () => setNaming(true) });
        if (tabKey === "material") menu.push({ label: "New Material", icon: "plus", run: createMaterial });
        if (tabKey === "look") menu.push({ label: "New Look", icon: "plus", run: createLook });
        openContextMenu(e, [{ items: menu }]);
    };

    return (
        <div className="panel bottom">
            <div className="tabs">
                {TABS.map((t) => (
                    <div key={t.key} className={`tab ${t.key === tabKey ? "active" : ""}`} onClick={() => setTabKey(t.key)}>
                        <Icon name={t.icon} /> {t.title} <span className="count">{itemsOf(t.key).length}</span>
                    </div>
                ))}
                <span className="spacer" />
                <span className="hint">{tab.hint}</span>
            </div>

            <div
                className="panel-body tiles"
                onContextMenu={panelMenu}
                // An object dragged here from the Hierarchy becomes a prefab
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                    // Image files dragged in from the desktop become textures
                    if (e.dataTransfer.files.length > 0) {
                        e.preventDefault();
                        setTabKey("texture");
                        uploadTextures([...e.dataTransfer.files]);
                        return;
                    }
                    const entityId = e.dataTransfer.getData(ENTITY_DRAG_TYPE);
                    if (!entityId) return;
                    e.preventDefault();
                    setTabKey("prefab");
                    createPrefab(entityId);
                }}
            >
                {tabKey === "scene" && (
                    <div className="tile add" onClick={() => setNaming(true)} title="Create a new scene">
                        <div className="tile-preview"><Icon name="plus" size={18} /></div>
                        <div className="tile-name">New Scene</div>
                    </div>
                )}
                {tabKey === "material" && (
                    <div className="tile add" onClick={createMaterial} title="Create a new material">
                        <div className="tile-preview"><Icon name="plus" size={18} /></div>
                        <div className="tile-name">New Material</div>
                    </div>
                )}

                {tabKey === "look" && (
                    <div className="tile add" onClick={createLook} title="Create a new look">
                        <div className="tile-preview"><Icon name="plus" size={18} /></div>
                        <div className="tile-name">New Look</div>
                    </div>
                )}

                {items.map((item) => {
                    const { kind } = item;
                    const selected = store.selectedAsset?.kind === kind && store.selectedAsset.name === item.name;
                    const current = (kind === "scene" && item.name === store.sceneName)
                        || (kind === "look" && item.name === store.environment.look);
                    return (
                        <div
                            key={`${kind}:${item.name}`}
                            className={`tile ${selected ? "selected" : ""} ${current ? "current" : ""}`}
                            title={current ? `${item.label} (${kind === "look" ? "used by the scene" : "open"})` : item.label}
                            draggable={kind !== "scene" && kind !== "effect" && kind !== "surface"}
                            onDragStart={(e) => setDraggedAsset(e, { kind, name: item.name })}
                            onClick={() => store.selectAsset({ kind, name: item.name })}
                            onDoubleClick={() => activate(item)}
                            onContextMenu={(e) => itemMenu(e, item)}
                        >
                            {item.image ? (
                                <img className="tile-preview texture" src={item.image} alt="" draggable={false} />
                            ) : item.color ? (
                                <div className="tile-preview material" style={{ background: item.color }} />
                            ) : (
                                <div className={`tile-preview ${kind}`}><Icon name={ICONS[kind]} size={20} /></div>
                            )}
                            <div className="tile-name">{item.label}</div>
                            {item.note && <div className="tile-note">{item.note}</div>}
                        </div>
                    );
                })}

                {items.length === 0 && tabKey === "texture" && (
                    <div className="empty">
                        No textures yet. Drop image files (.png, .jpg, .webp) here, or put them into the project's assets/ folder.
                    </div>
                )}
                {items.length === 0 && tabKey === "prefab" && (
                    <div className="empty">
                        No prefabs yet. Select an object and press <b>Create Prefab</b> in the Inspector, or drag it here from the Hierarchy.
                    </div>
                )}
                {items.length === 0 && tabKey === "model" && (
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
