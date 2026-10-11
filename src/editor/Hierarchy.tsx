import { useEffect, useState } from "react";
import type { EntityData } from "../engine";
import { openContextMenu } from "./contextMenu";
import { dropAsset, ENTITY_DRAG_TYPE, getDraggedAsset } from "./core/dnd";
import { sceneStore } from "./core/SceneStore";
import { useSceneStore } from "./core/useSceneStore";
import { CREATE_MENU, createObject, entityContextMenu, innerContextMenu, sceneContextMenu } from "./createMenu";
import { entityIcon } from "./entityIcon";
import { Icon, Menu } from "./ui";
import type { MenuSection } from "./ui";

const MENU_SECTIONS: MenuSection[] = CREATE_MENU.map((section, s) => ({
    title: section.title,
    items: section.items.map((item, i) => ({ key: `${s}:${i}`, label: item.label, icon: item.icon }))
}));

// Where a dragged row would land on the row under the mouse: above it, below it, or inside it as a child
type DropPlace = "before" | "after" | "inside";

// The rows that move when the row `id` is dragged: all the selected ones if it is one of them
function dragged(id: string) {
    const roots = sceneStore.selectedRoots.map((entity) => entity.id);
    return roots.includes(id) ? roots : [id];
}

// A row was dropped onto another as its child (or onto the empty part: parentId = null)
function moveInto(id: string, parentId: string | null) {
    for (const moved of dragged(id)) sceneStore.reparent(moved, parentId);
}

// A row was dropped above or below another: it becomes its neighbor there
function moveBeside(id: string, targetId: string, after: boolean) {
    const moved = dragged(id).filter((other) => other !== targetId);
    // Each one lands right next to the target, so going backwards keeps their order
    for (const other of after ? [...moved].reverse() : moved) sceneStore.moveBeside(other, targetId, after);
}

// true if the entity or something under it has the text in its name
function matches(entity: EntityData, filter: string): boolean {
    return entity.name.toLowerCase().includes(filter) || entity.children.some((child) => matches(child, filter));
}

// A row is "inner" if it is something a prefab brings into its instance: it can be selected and changed (that
// makes an override of the instance) and left out by the instance, but not moved or renamed. `within` is true
// for everything under an instance, the entities the instance adds included: those are real ones again.
// `filter` is the search text, in lower case: only the rows that have it, and what they are inside of, are shown.
function Node({ entity: shown, depth, filter, within = false }: { entity: EntityData; depth: number; filter: string; within?: boolean }) {
    // Under an instance the row gets a copy made from the prefab; what the instance adds is found by its id
    const real = within ? sceneStore.realEntity(shown.id) : shown;
    const entity = real ?? shown;
    const inner = real === null;
    const added = within && !inner;
    const [dropPlace, setDropPlace] = useState<DropPlace | null>(null);
    // An instance starts folded: mostly it is used as one thing
    const [folded, setFolded] = useState(entity.prefab !== undefined);
    const expanded = !inner ? sceneStore.expand(entity) : null;
    // What is inside a prefab instance is not searched: it is shown whole
    const children = (expanded ? expanded.children : entity.children).filter((child) => !filter || within || expanded !== null || matches(child, filter));
    // What the instance leaves out of its prefab right here
    const removed = within || entity.prefab ? sceneStore.removedUnder(entity.id) : [];
    const hasChildren = children.length > 0 || removed.length > 0;
    // A search shows what it found, wherever it is
    const open = filter && !expanded ? true : !folded;
    const overridden = (inner || entity.prefab) && sceneStore.hasOverrides(entity.id);
    const renaming = sceneStore.renamingId === entity.id;
    const active = entity.active ?? true;

    const classes = [
        "tree-row",
        sceneStore.selectedIds.includes(entity.id) ? "selected" : "",
        dropPlace ? `drop-${dropPlace}` : "",
        active ? "" : "inactive",
        entity.prefab || inner ? "prefab" : "",
        inner ? "inner" : "",
        added ? "added" : "",
        overridden ? "overridden" : ""
    ].join(" ");

    const title = inner
        ? `From the prefab; changing it here changes this instance only${overridden ? " (changed)" : ""}`
        : entity.prefab
            ? `Instance of prefab ${entity.prefab}${overridden ? ", with changes of its own" : ""}`
            : added
                ? "Added in this instance: the prefab does not have it"
                : undefined;

    return (
        <>
            <div
                className={classes}
                draggable={!inner && !renaming}
                title={title}
                data-id={entity.id}
                onClick={(e) => {
                    // Shift: everything from the main selected row to this one, as the rows stand on the screen
                    if (e.shiftKey && sceneStore.selectedId) {
                        const rows = [...document.querySelectorAll<HTMLElement>(".tree-row[data-id]")].map((row) => row.dataset.id!);
                        const from = rows.indexOf(sceneStore.selectedId);
                        const to = rows.indexOf(entity.id);
                        if (from >= 0 && to >= 0) {
                            const range = rows.slice(Math.min(from, to), Math.max(from, to) + 1);
                            // The clicked one last: it becomes the main one
                            sceneStore.selectMany([...range.filter((id) => id !== entity.id), entity.id]);
                            return;
                        }
                    }
                    sceneStore.select(entity.id, e.ctrlKey || e.metaKey);
                }}
                // Like in Unity: a double click brings the camera to the object
                onDoubleClick={() => sceneStore.focus(entity.id)}
                onContextMenu={(e) => {
                    // A right click on one of several selected rows is about all of them
                    if (!sceneStore.selectedIds.includes(entity.id)) sceneStore.select(entity.id);
                    openContextMenu(e, inner ? innerContextMenu(entity) : entityContextMenu(entity));
                }}
                onDragStart={(e) => e.dataTransfer.setData(ENTITY_DRAG_TYPE, entity.id)}
                onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // The top and the bottom of the row put the dragged one above or below it, the middle makes
                    // it a child. An asset is always dropped onto the object itself.
                    const rect = e.currentTarget.getBoundingClientRect();
                    const part = (e.clientY - rect.top) / rect.height;
                    const isRow = e.dataTransfer.types.includes(ENTITY_DRAG_TYPE);
                    // What a prefab brings keeps its place among its neighbors: a row can only go inside it
                    setDropPlace(!isRow || inner ? "inside" : part < 0.25 ? "before" : part > 0.75 ? "after" : "inside");
                }}
                onDragLeave={() => setDropPlace(null)}
                onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const place = dropPlace ?? "inside";
                    setDropPlace(null);
                    const asset = getDraggedAsset(e);
                    const id = e.dataTransfer.getData(ENTITY_DRAG_TYPE);
                    if (asset) dropAsset(asset, entity.id);
                    else if (place === "inside") moveInto(id, entity.id);
                    else moveBeside(id, entity.id, place === "after");
                }}
                style={{ paddingLeft: 6 + depth * 14 }}
            >
                <span
                    className={`twisty ${open ? "open" : ""}`}
                    onClick={(e) => {
                        e.stopPropagation();
                        setFolded(open);
                    }}
                >
                    {hasChildren && <Icon name="chevron" size={10} />}
                </span>
                <Icon name={entityIcon(entity)} />
                {renaming ? (
                    <input
                        className="input rename"
                        autoFocus
                        defaultValue={entity.name}
                        onFocus={(e) => e.target.select()}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                        onBlur={(e) => sceneStore.finishRename(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                            if (e.key === "Escape") sceneStore.finishRename(null);
                        }}
                    />
                ) : (
                    <span className="name">{entity.name}</span>
                )}
                <span
                    className="eye"
                    title={active ? "Hide: the object and what is under it are switched off" : "Show: switch the object on"}
                    onClick={(e) => {
                        e.stopPropagation();
                        sceneStore.setActive(entity.id, !active);
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                >
                    <Icon name={active ? "look" : "eyeOff"} size={12} />
                </span>
            </div>
            {open && children.map((child) => (
                <Node key={child.id} entity={child} depth={depth + 1} filter={filter} within={within || expanded !== null} />
            ))}
            {open && removed.map((name) => (
                <div
                    key={`removed:${name}`}
                    className="tree-row removed"
                    title="The prefab has this object, this instance leaves it out"
                    style={{ paddingLeft: 6 + (depth + 1) * 14 }}
                    onContextMenu={(e) => openContextMenu(e, [{
                        items: [{ label: "Restore from Prefab", icon: "back", run: () => sceneStore.restoreRemoved(entity.id, name) }]
                    }])}
                >
                    <span className="twisty" />
                    <Icon name="cube" />
                    <span className="name">{name}</span>
                    <span className="eye" title="Restore: the instance has it again" onClick={() => sceneStore.restoreRemoved(entity.id, name)}>
                        <Icon name="back" size={12} />
                    </span>
                </div>
            ))}
        </>
    );
}

export default function Hierarchy() {
    const store = useSceneStore();
    const [search, setSearch] = useState("");
    const filter = search.trim().toLowerCase();
    const shown = store.entities.filter((entity) => !filter || matches(entity, filter));

    // What the behaviors create during Play is in no data the panel hears about: it looks twice a second
    const [, look] = useState(0);
    useEffect(() => {
        if (!store.playing) return;
        const timer = setInterval(() => look((n) => n + 1), 500);
        return () => clearInterval(timer);
    }, [store.playing]);
    const spawned = store.spawned;

    const create = (key: string) => {
        const [section, index] = key.split(":").map(Number);
        createObject(CREATE_MENU[section].items[index]);
    };

    return (
        <div className="panel left">
            <div className="panel-header">
                Hierarchy
                <span className="spacer" />
                <Menu
                    sections={MENU_SECTIONS}
                    onPick={create}
                    align="right"
                    trigger={(toggle, open) => (
                        <button className={`btn ${open ? "active" : ""}`} onClick={toggle} title="Create an object">
                            <Icon name="plus" /> Create
                        </button>
                    )}
                />
            </div>
            <div className="tree-search">
                <input
                    className="input"
                    placeholder="Search by name"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => e.key === "Escape" && setSearch("")}
                />
                {search && (
                    <button className="btn ghost" title="Clear the search" onClick={() => setSearch("")}>
                        <Icon name="close" size={12} />
                    </button>
                )}
            </div>

            <div
                className="panel-body"
                // Clicking the empty area clears the selection, dropping there moves the entity to the scene root
                onClick={(e) => {
                    if (e.target === e.currentTarget) store.select(null);
                }}
                onContextMenu={(e) => openContextMenu(e, sceneContextMenu())}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                    e.preventDefault();
                    const asset = getDraggedAsset(e);
                    if (asset) dropAsset(asset, null);
                    else moveInto(e.dataTransfer.getData(ENTITY_DRAG_TYPE), null);
                }}
            >
                {shown.map((entity) => (
                    <Node key={entity.id} entity={entity} depth={0} filter={filter} />
                ))}
                {spawned.length > 0 && (
                    <>
                        <div className="tree-title" title="Objects the behaviors have created (self.spawn). They live only while Play goes on">
                            Created in Play · {spawned.length}
                        </div>
                        {spawned.slice(0, 200).map((item, i) => (
                            <div
                                key={`${item.id}:${i}`}
                                className="tree-row spawned"
                                style={{ paddingLeft: 6 }}
                                title="Created by a behavior · click to bring the camera to it (in the Scene view)"
                                onClick={() => store.focusObject(item.object)}
                            >
                                <span className="twisty" />
                                <Icon name="cube" />
                                <span className="name">{item.name}</span>
                            </div>
                        ))}
                    </>
                )}
                {store.entities.length === 0 && (
                    <div className="empty">
                        The scene is empty.<br />
                        Press <b>Create</b> or right-click here to add an object.
                    </div>
                )}
                {store.entities.length > 0 && shown.length === 0 && (
                    <div className="empty">Nothing is named like that.</div>
                )}
            </div>
        </div>
    );
}
