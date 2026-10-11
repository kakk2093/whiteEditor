import { useState } from "react";
import type { DragEvent, MouseEvent, ReactNode } from "react";
import { builtinEffects, builtinSurfaces, defaultMaterialData } from "../engine";
import {
    addToLook, createFolder, createLook, createMaterial, createPrefab, deleteFolder, deleteLook, deleteMaterial, deletePrefab,
    copyText, deleteScene, deleteTexture, duplicateAsset, moveAssetToFolder, newScene, openPrefab, openScene, renameAsset, renameFolder,
    renameScene, showInExplorer, uploadTextures
} from "./core/actions";
import { confirmAt, openContextMenu } from "./contextMenu";
import type { ContextItem } from "./contextMenu";
import { ENTITY_DRAG_TYPE, getDraggedAsset, instantiateModel, instantiatePrefab, setDraggedAsset } from "./core/dnd";
import { folderName, folderPaths, parentFolder, placement } from "./core/folders";
import type { FolderSection } from "./core/folders";
import { sceneStore } from "./core/SceneStore";
import type { AssetRef } from "./core/SceneStore";
import { useSceneStore } from "./core/useSceneStore";
import type { Layout } from "./layout";
import { Splitter } from "./Splitter";
import { Icon, NameDialog } from "./ui";
import type { IconName } from "./ui";

type Kind = AssetRef["kind"];

// A kind of assets, a row at the top of the tree; "script" gathers what the scripts define besides models
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
// `into`: the folder a new scene goes to. For a folder: `parent` is the folder it stands in, `from` its
// path if it is being renamed.
type Naming =
    | { what: "scene"; into?: string }
    | { what: "folder"; parent: string | null; from?: string }
    // Another name for an asset
    | { what: "rename"; kind: "scene" | "material" | "look" | "prefab"; from: string };

// Where the files of each kind are, inside the project folder
const DIRS: Record<TabKey, string> = {
    scene: "scenes",
    material: "materials",
    prefab: "prefabs",
    look: "looks",
    texture: "assets",
    model: "scripts",
    script: "scripts"
};

// The file of an asset inside the project folder. What scripts define has no file of its own: for it this is
// the scripts folder; null for what is built into the engine.
function fileOf(item: Item): string | null {
    if (item.kind === "scene" || item.kind === "material" || item.kind === "prefab" || item.kind === "look") return `${DIRS[item.kind]}/${item.name}.json`;
    if (item.kind === "texture") return `assets/${item.name}`;
    return item.note?.includes("built-in") ? null : "scripts";
}

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

// How the assets are shown: big tiles or a compact list; remembered in the browser
type View = "grid" | "list";
const VIEW_KEY = "white:project-view";

// What is open in the panel: a kind of assets, and a folder of it (null: what is in no folder)
interface Place {
    tab: TabKey;
    folder: string | null;
}

// The assets of the open project, like Unity's Project window: at the left a tree of the kinds of assets
// with their folders, at the right what is in the place picked there
export default function ProjectPanel({ layout, onLayout }: { layout: Layout; onLayout: (change: (layout: Layout) => Layout) => void }) {
    const store = useSceneStore();
    const [place, setPlace] = useState<Place>({ tab: "scene", folder: null });
    const [naming, setNaming] = useState<Naming | null>(null);
    const [search, setSearch] = useState("");
    const [view, setView] = useState<View>(() => (localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid"));
    // The rows of the tree that are folded, as "<tab>" or "<tab>:<folder>"; a row is open until it is folded
    const [folded, setFolded] = useState<Set<string>>(new Set());
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

    const tabKey = place.tab;
    const tab = TABS.find((t) => t.key === tabKey)!;
    const section = FOLDERS[tabKey];
    const paths = section ? folderPaths(store.folders, section) : [];
    // A folder that is gone (removed, renamed, another project) leaves the top of its kind open
    const folder = place.folder !== null && paths.includes(place.folder) ? place.folder : null;
    const placed = section ? placement(store.folders, section) : new Map<string, string>();
    const all = itemsOf(tabKey);
    // The search looks through the whole kind, whatever folder is open
    const filter = search.trim().toLowerCase();
    const items = filter
        ? all.filter((item) => item.label.toLowerCase().includes(filter) || item.name.toLowerCase().includes(filter))
        : all.filter((item) => (placed.get(item.name) ?? null) === folder);
    const subfolders = filter ? [] : paths.filter((path) => parentFolder(path) === folder);

    const go = (tabTo: TabKey, folderTo: string | null = null) => {
        setPlace({ tab: tabTo, folder: folderTo });
        setSearch("");
    };
    const changeView = (next: View) => {
        setView(next);
        localStorage.setItem(VIEW_KEY, next);
    };
    const toggle = (key: string) => {
        const next = new Set(folded);
        if (!next.delete(key)) next.add(key);
        setFolded(next);
    };

    // An asset dropped onto a folder of its own kind (or onto the top of the kind, `to` = null) moves there
    const dropInto = (e: DragEvent, dropTab: TabKey, to: string | null) => {
        const asset = getDraggedAsset(e);
        const dropSection = FOLDERS[dropTab];
        if (!asset || !dropSection || FOLDERS[asset.kind as TabKey] !== dropSection) return false;
        e.preventDefault();
        e.stopPropagation();
        if ((placement(store.folders, dropSection).get(asset.name) ?? null) !== to) moveAssetToFolder(dropSection, asset.name, to);
        return true;
    };

    // Makes an asset and puts it into the folder
    const createIn = async (into: string | null, create: () => Promise<void>) => {
        await create();
        const made = sceneStore.selectedAsset;
        if (into && section && made && FOLDERS[made.kind as TabKey] === section) moveAssetToFolder(section, made.name, into);
    };

    // What can be made in a folder of the open kind
    const createItems = (into: string | null): ContextItem[] => {
        const menu: ContextItem[] = [];
        if (tabKey === "scene") menu.push({ label: "New Scene…", icon: "plus", run: () => setNaming({ what: "scene", into: into ?? undefined }) });
        if (tabKey === "material") menu.push({ label: "New Material", icon: "plus", run: () => createIn(into, createMaterial) });
        if (tabKey === "look") menu.push({ label: "New Look", icon: "plus", run: () => createIn(into, createLook) });
        if (section) menu.push({ label: "New Folder…", icon: "folder", run: () => setNaming({ what: "folder", parent: into }) });
        return menu;
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
        // Selecting the asset clears the selection of objects, and some items are about those objects
        const objects = [...store.selectedIds];
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
        // What any asset has: where it is used, its name, its file
        const more: ContextItem[] = [];
        if (kind === "material" && objects.length > 0) {
            more.push({
                label: objects.length > 1 ? `Assign to ${objects.length} Selected Objects` : "Assign to Selected Object",
                icon: "material",
                run: () => {
                    store.batch(() => objects.forEach((id) => store.setComponentField(id, "mesh", "material", name)));
                    // Back to the objects: the change is seen on them
                    store.selectMany(objects);
                }
            });
        }
        if (kind === "material" || kind === "prefab" || kind === "behavior" || kind === "model") {
            const users = store.usersOf(kind, name);
            more.push({
                label: users.length > 0 ? `Select in Scene (${users.length})` : "Not Used in This Scene",
                run: () => (users.length > 0 ? store.selectMany(users.map((entity) => entity.id)) : store.update({ status: `Nothing in this scene uses ${name}` }))
            });
        }
        if (kind === "scene" || kind === "material" || kind === "look" || kind === "prefab") {
            more.push({ label: "Rename…", run: () => setNaming({ what: "rename", kind, from: name }) });
        }
        const file = fileOf(item);
        const files: ContextItem[] = [{ label: "Copy Name", icon: "copy", run: () => copyText(name) }];
        if (file) {
            files.push(
                { label: "Copy Path", run: () => copyText(`projects/${store.project}/${file}`) },
                { label: file === "scripts" ? "Show Scripts Folder in Explorer" : "Show in Explorer", icon: "folder", run: () => showInExplorer(file) }
            );
        }

        const moves: ContextItem[] = [];
        if (section) {
            const from = placed.get(name) ?? null;
            if (from !== null) moves.push({ label: "Take Out of Folder", icon: "back", run: () => moveAssetToFolder(section, name, null) });
            for (const to of paths) {
                if (to !== from) moves.push({ label: `Move to ${to}`, icon: "folder", run: () => moveAssetToFolder(section, name, to) });
            }
        }
        openContextMenu(e, [{ items: menu }, { items: more }, { title: "Folder", items: moves }, { items: files }]);
    };

    // The menu of the empty part of the panel and of a kind in the tree: what can be made there, and its files
    const placeMenu = (e: MouseEvent, t: TabKey, into: string | null) => {
        openContextMenu(e, [
            { items: t === tabKey ? createItems(into) : [] },
            {
                items: [
                    { label: `Show ${DIRS[t]}/ in Explorer`, icon: "folder", run: () => showInExplorer(DIRS[t]) },
                    { label: "Show Project in Explorer", run: () => showInExplorer() }
                ]
            }
        ]);
    };

    const folderMenu = (e: MouseEvent, path: string) => {
        if (!section) return;
        openContextMenu(e, [
            { items: createItems(path) },
            {
                items: [
                    { label: "Rename…", run: () => setNaming({ what: "folder", parent: parentFolder(path), from: path }) },
                    // Nothing is lost, so it does not ask
                    { label: "Remove Folder (keeps what is in it)", icon: "trash", run: () => deleteFolder(section, path) }
                ]
            }
        ]);
    };

    const tile = (item: Item) => {
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
                    <div className={`tile-preview ${kind}`}><Icon name={ICONS[kind]} size={view === "list" ? 14 : 20} /></div>
                )}
                <div className="tile-name">{item.label}</div>
                {item.note && <div className="tile-note">{item.note}</div>}
                {filter && placed.has(item.name) && <div className="tile-note">{placed.get(item.name)}</div>}
            </div>
        );
    };

    // The rows of the tree under one kind: its folders, each with the folders inside it
    const treeRows = (t: TabKey, all: string[], parent: string | null, depth: number): ReactNode[] =>
        all.filter((path) => parentFolder(path) === parent).flatMap((path) => {
            const key = `${t}:${path}`;
            const hasInside = all.some((other) => parentFolder(other) === path);
            const open = !folded.has(key);
            return [
                <div
                    key={key}
                    className={`tree-row ${place.tab === t && folder === path ? "selected" : ""}`}
                    style={{ paddingLeft: 6 + depth * 14 }}
                    title="Drop an asset here to move it in · right-click for more"
                    onClick={() => go(t, path)}
                    onContextMenu={(e) => {
                        go(t, path);
                        folderMenu(e, path);
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => dropInto(e, t, path)}
                >
                    <span
                        className={`twisty ${open ? "open" : ""}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            toggle(key);
                        }}
                    >
                        {hasInside && <Icon name="chevron" size={10} />}
                    </span>
                    <Icon name="folder" />
                    <span className="name">{folderName(path)}</span>
                </div>,
                ...(open ? treeRows(t, all, path, depth + 1) : [])
            ];
        });

    const creatable = createItems(folder);
    // The way to the open folder, for the line above the tiles: "Materials › Walls › Old"
    const crumbs = folder === null ? [] : folder.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"));

    return (
        <div className="panel bottom project">
            <div className="project-tree">
                {TABS.map((t) => {
                    const tabSection = FOLDERS[t.key];
                    const tabPaths = tabSection ? folderPaths(store.folders, tabSection) : [];
                    const open = !folded.has(t.key);
                    return [
                        <div
                            key={t.key}
                            className={`tree-row ${place.tab === t.key && folder === null ? "selected" : ""}`}
                            style={{ paddingLeft: 6 }}
                            title={t.hint}
                            onClick={() => go(t.key)}
                            onContextMenu={(e) => {
                                go(t.key);
                                placeMenu(e, t.key, null);
                            }}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => dropInto(e, t.key, null)}
                        >
                            <span
                                className={`twisty ${open ? "open" : ""}`}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    toggle(t.key);
                                }}
                            >
                                {tabPaths.length > 0 && <Icon name="chevron" size={10} />}
                            </span>
                            <Icon name={t.icon} />
                            <span className="name">{t.title}</span>
                            <span className="count">{itemsOf(t.key).length}</span>
                        </div>,
                        ...(open ? treeRows(t.key, tabPaths, null, 1) : [])
                    ];
                })}
            </div>

            {/* The border of the tree can be dragged, like those of the panels */}
            <Splitter side="tree" layout={layout} onChange={onLayout} />

            <div className="project-main">
                <div className="project-head">
                    <div className="crumbs">
                        <span className={folder === null ? "here" : ""} onClick={() => go(tabKey)}>{tab.title}</span>
                        {crumbs.map((path) => (
                            <span key={path} className={path === folder ? "here" : ""} onClick={() => go(tabKey, path)}>
                                › {folderName(path)}
                            </span>
                        ))}
                    </div>
                    <span className="spacer" />
                    {creatable.length > 0 && (
                        <button className="btn ghost" title="Create here: an asset of this kind or a folder" onClick={(e) => openContextMenu(e, [{ items: creatable }])}>
                            <Icon name="plus" />
                        </button>
                    )}
                    <input
                        className="input"
                        placeholder={`Search ${tab.title.toLowerCase()}`}
                        value={search}
                        title="Shows the assets of this kind that have the text in their names, from every folder"
                        onChange={(e) => setSearch(e.target.value)}
                        onKeyDown={(e) => e.key === "Escape" && setSearch("")}
                    />
                    <button
                        className="btn ghost"
                        title={view === "grid" ? "Show as a compact list" : "Show as tiles"}
                        onClick={() => changeView(view === "grid" ? "list" : "grid")}
                    >
                        {view === "grid" ? "List" : "Tiles"}
                    </button>
                </div>

                <div
                    className={`panel-body tiles ${view}`}
                    onContextMenu={(e) => placeMenu(e, tabKey, folder)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                        // Image files dragged in from the desktop become textures
                        if (e.dataTransfer.files.length > 0) {
                            e.preventDefault();
                            go("texture");
                            uploadTextures([...e.dataTransfer.files]);
                            return;
                        }
                        // An asset from the tree or from a search lands in the folder that is open
                        if (dropInto(e, tabKey, folder)) return;
                        // An object dragged here from the Hierarchy becomes a prefab
                        const entityId = e.dataTransfer.getData(ENTITY_DRAG_TYPE);
                        if (!entityId) return;
                        e.preventDefault();
                        go("prefab");
                        createPrefab(entityId);
                    }}
                >
                    {subfolders.map((path) => (
                        <div
                            key={`folder:${path}`}
                            className="tile folder"
                            title={`Folder ${folderName(path)} · double-click to open · drop an asset here to move it in`}
                            onDoubleClick={() => go(tabKey, path)}
                            onContextMenu={(e) => folderMenu(e, path)}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => dropInto(e, tabKey, path)}
                        >
                            <div className="tile-preview"><Icon name="folder" size={view === "list" ? 14 : 20} /></div>
                            <div className="tile-name">{folderName(path)}</div>
                        </div>
                    ))}

                    {items.map(tile)}

                    {filter && items.length === 0 && <div className="empty">No {tab.title.toLowerCase()} are named like that.</div>}
                    {!filter && items.length === 0 && subfolders.length === 0 && folder !== null && (
                        <div className="empty">The folder is empty. Drag assets here, or onto it in the tree.</div>
                    )}
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
                            if (naming.into) moveAssetToFolder("scenes", name, naming.into);
                        });
                    }}
                />
            )}
            {naming?.what === "rename" && (
                <NameDialog
                    title={`Rename ${naming.kind} ${naming.from}`}
                    confirm="Rename"
                    initial={naming.from}
                    taken={itemsOf(naming.kind).map((item) => item.name).filter((name) => name !== naming.from)}
                    onCancel={() => setNaming(null)}
                    onSubmit={(name) => {
                        setNaming(null);
                        // Everything that refers to the asset by name is rewritten with it
                        if (naming.kind === "scene") renameScene(naming.from, name);
                        else renameAsset(naming.kind, naming.from, name);
                    }}
                />
            )}
            {naming?.what === "folder" && section && (
                <NameDialog
                    title={naming.from ? `Rename folder ${folderName(naming.from)}` : `New folder in ${naming.parent ?? tab.title}`}
                    confirm={naming.from ? "Rename" : "Create"}
                    initial={naming.from ? folderName(naming.from) : undefined}
                    // Among the folders that stand next to it
                    taken={paths.filter((path) => parentFolder(path) === naming.parent && path !== naming.from).map(folderName)}
                    onCancel={() => setNaming(null)}
                    onSubmit={(name) => {
                        setNaming(null);
                        const path = naming.parent ? `${naming.parent}/${name}` : name;
                        if (!naming.from) {
                            createFolder(section, path);
                        } else if (path !== naming.from) {
                            renameFolder(section, naming.from, path);
                            // The open folder goes on under its new name
                            if (folder !== null && (folder === naming.from || folder.startsWith(`${naming.from}/`))) {
                                setPlace({ tab: tabKey, folder: path + folder.slice(naming.from.length) });
                            }
                        }
                    }}
                />
            )}
        </div>
    );
}
