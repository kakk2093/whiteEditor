import { useState } from "react";
import type { DragEvent, MouseEvent } from "react";
import { builtinEffects, builtinSurfaces, defaultMaterialData } from "../engine";
import {
    addToLook, createFolder, createLook, createMaterial, createPrefab, deleteFolder, deleteLook, deleteMaterial, deletePrefab,
    deleteScene, deleteTexture, duplicateAsset, moveAssetToFolder, newScene, openPrefab, openScene, renameFolder, uploadTextures
} from "./core/actions";
import { confirmAt, openContextMenu } from "./contextMenu";
import type { ContextItem } from "./contextMenu";
import { ENTITY_DRAG_TYPE, getDraggedAsset, instantiateModel, instantiatePrefab, setDraggedAsset } from "./core/dnd";
import { placement } from "./core/folders";
import type { FolderSection } from "./core/folders";
import { sceneStore } from "./core/SceneStore";
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

// The tabs whose assets can be laid out in folders, and the name of each in folders.json.
// What scripts define (models, behaviors, effects) is laid out by the files of scripts/ themselves.
const FOLDERS: Partial<Record<TabKey, FolderSection>> = {
    scene: "scenes",
    material: "materials",
    prefab: "prefabs",
    look: "looks",
    texture: "textures"
};

// The dialog that asks for a name: of a new scene, of a new folder, or the new name of a folder
type Naming = { what: "scene" } | { what: "folder"; from?: string };

interface Item {
    kind: Kind;
    name: string;
    label: string;
    // CSS color of a material
    color?: string;
    // Address of the picture: of a texture, or of the texture a material has
    image?: string;
    // A second line under the name: what kind of script thing it is
    note?: string;
}

// The assets of the open project, like Unity's Project window
export default function ProjectPanel() {
    const store = useSceneStore();
    const [tabKey, setTabKey] = useState<TabKey>("scene");
    const [naming, setNaming] = useState<Naming | null>(null);
    // The folder that is open on each tab
    const [opened, setOpened] = useState<Partial<Record<TabKey, string>>>({});
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
        return registry.materialNames().map((name) => {
            const data = registry.getMaterialData(name);
            // A texture the project no longer has leaves the plain color
            const texture = data?.texture && registry.textureNames().includes(data.texture) ? data.texture : "";
            return {
                kind: "material",
                name,
                label: name,
                color: data?.color ?? defaultMaterialData.color,
                image: texture ? registry.textureUrl(texture) : undefined
            };
        });
    };

    const tab = TABS.find((t) => t.key === tabKey)!;

    // Folders: the top of a tab shows them and the assets that are in none; an open folder shows its own
    const section = FOLDERS[tabKey];
    const tree = (section && store.folders[section]) || {};
    const folder = opened[tabKey] !== undefined && opened[tabKey]! in tree ? opened[tabKey]! : null;
    const placed = section ? placement(store.folders, section) : new Map<string, string>();
    const all = itemsOf(tabKey);
    const items = all.filter((item) => (placed.get(item.name) ?? null) === folder);
    const openFolder = (name: string | null) => setOpened({ ...opened, [tabKey]: name ?? undefined });

    // An asset tile dropped onto a folder (or onto the way back, `to` = null) moves there
    const dropInto = (e: DragEvent, to: string | null) => {
        const asset = getDraggedAsset(e);
        if (!asset || !section || FOLDERS[asset.kind as TabKey] !== section) return;
        e.preventDefault();
        e.stopPropagation();
        moveAssetToFolder(section, asset.name, to);
    };

    // What is made while a folder is open goes into it
    const createHere = async (create: () => Promise<void>) => {
        await create();
        const made = sceneStore.selectedAsset;
        if (folder && section && made && FOLDERS[made.kind as TabKey] === section) moveAssetToFolder(section, made.name, folder);
    };

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
        const moves: ContextItem[] = [];
        if (section) {
            const from = placed.get(name) ?? null;
            if (from !== null) moves.push({ label: "Take Out of Folder", icon: "back", run: () => moveAssetToFolder(section, name, null) });
            for (const to of Object.keys(tree).sort()) {
                if (to !== from) moves.push({ label: `Move to ${to}`, icon: "folder", run: () => moveAssetToFolder(section, name, to) });
            }
        }
        openContextMenu(e, [{ items: menu }, { title: "Folder", items: moves }]);
    };

    const folderMenu = (e: MouseEvent, name: string) => {
        if (!section) return;
        openContextMenu(e, [{
            items: [
                { label: "Open", icon: "folder", run: () => openFolder(name) },
                { label: "Rename…", run: () => setNaming({ what: "folder", from: name }) },
                // Nothing is lost, so it does not ask
                { label: "Remove Folder (keeps what is in it)", icon: "trash", run: () => deleteFolder(section, name) }
            ]
        }]);
    };

    // Right-click on the empty part of the panel: what can be created on this tab
    const panelMenu = (e: MouseEvent) => {
        const menu: ContextItem[] = [];
        if (tabKey === "scene") menu.push({ label: "New Scene…", icon: "plus", run: () => setNaming({ what: "scene" }) });
        if (tabKey === "material") menu.push({ label: "New Material", icon: "plus", run: () => createHere(createMaterial) });
        if (tabKey === "look") menu.push({ label: "New Look", icon: "plus", run: () => createHere(createLook) });
        if (section && !folder) menu.push({ label: "New Folder…", icon: "folder", run: () => setNaming({ what: "folder" }) });
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
                {folder !== null && (
                    <div
                        className="tile folder"
                        title="Back to the top of the tab · drop an asset here to take it out of the folder"
                        onClick={() => openFolder(null)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => dropInto(e, null)}
                    >
                        <div className="tile-preview"><Icon name="back" size={20} /></div>
                        <div className="tile-name">{folder}</div>
                        <div className="tile-note">back</div>
                    </div>
                )}

                {tabKey === "scene" && (
                    <div className="tile add" onClick={() => setNaming({ what: "scene" })} title="Create a new scene">
                        <div className="tile-preview"><Icon name="plus" size={18} /></div>
                        <div className="tile-name">New Scene</div>
                    </div>
                )}
                {tabKey === "material" && (
                    <div className="tile add" onClick={() => createHere(createMaterial)} title="Create a new material">
                        <div className="tile-preview"><Icon name="plus" size={18} /></div>
                        <div className="tile-name">New Material</div>
                    </div>
                )}

                {tabKey === "look" && (
                    <div className="tile add" onClick={() => createHere(createLook)} title="Create a new look">
                        <div className="tile-preview"><Icon name="plus" size={18} /></div>
                        <div className="tile-name">New Look</div>
                    </div>
                )}

                {folder === null && Object.keys(tree).sort().map((name) => (
                    <div
                        key={`folder:${name}`}
                        className="tile folder"
                        title={`Folder ${name} · double-click to open · drop an asset here to move it in`}
                        onDoubleClick={() => openFolder(name)}
                        onContextMenu={(e) => folderMenu(e, name)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => dropInto(e, name)}
                    >
                        <div className="tile-preview"><Icon name="folder" size={20} /></div>
                        <div className="tile-name">{name}</div>
                        <div className="tile-note">{all.filter((item) => placed.get(item.name) === name).length}</div>
                    </div>
                ))}

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
                            {item.color ? (
                                // The texture is tinted by the color, as the material draws it
                                <div
                                    className="tile-preview material"
                                    style={{
                                        backgroundColor: item.color,
                                        backgroundImage: item.image ? `url("${item.image}")` : undefined
                                    }}
                                />
                            ) : item.image ? (
                                <img className="tile-preview texture" src={item.image} alt="" draggable={false} />
                            ) : (
                                <div className={`tile-preview ${kind}`}><Icon name={ICONS[kind]} size={20} /></div>
                            )}
                            <div className="tile-name">{item.label}</div>
                            {item.note && <div className="tile-note">{item.note}</div>}
                        </div>
                    );
                })}

                {all.length === 0 && tabKey === "texture" && (
                    <div className="empty">
                        No textures yet. Drop image files (.png, .jpg, .webp) here, or put them into the project's assets/ folder.
                    </div>
                )}
                {all.length === 0 && tabKey === "prefab" && (
                    <div className="empty">
                        No prefabs yet. Select an object and press <b>Create Prefab</b> in the Inspector, or drag it here from the Hierarchy.
                    </div>
                )}
                {all.length === 0 && tabKey === "model" && (
                    <div className="empty">
                        No code models. Export <b>defineModel(...)</b> from a file in the project's scripts/ folder.
                    </div>
                )}
            </div>

            {naming?.what === "scene" && (
                <NameDialog
                    title="New scene"
                    confirm="Create"
                    taken={store.scenes}
                    onCancel={() => setNaming(null)}
                    onSubmit={(name) => {
                        setNaming(null);
                        newScene(name).then(() => {
                            if (folder) moveAssetToFolder("scenes", name, folder);
                        });
                    }}
                />
            )}
            {naming?.what === "folder" && section && (
                <NameDialog
                    title={naming.from ? `Rename folder ${naming.from}` : `New folder in ${tab.title}`}
                    confirm={naming.from ? "Rename" : "Create"}
                    initial={naming.from}
                    taken={Object.keys(tree).filter((name) => name !== naming.from)}
                    onCancel={() => setNaming(null)}
                    onSubmit={(name) => {
                        setNaming(null);
                        if (!naming.from) createFolder(section, name);
                        else if (name !== naming.from) renameFolder(section, naming.from, name);
                    }}
                />
            )}
        </div>
    );
}
