import { useState } from "react";
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

// `inner` is true for what is inside a prefab instance: it comes from the prefab file, so it can be selected
// and changed (that makes an override of the instance) but not moved, renamed or deleted
function Node({ entity, depth, inner = false }: { entity: EntityData; depth: number; inner?: boolean }) {
    const [dropTarget, setDropTarget] = useState(false);
    // An instance starts folded: mostly it is used as one thing
    const [open, setOpen] = useState(!entity.prefab);
    const expanded = !inner ? sceneStore.expand(entity) : null;
    const children = expanded ? expanded.children : entity.children;
    const hasChildren = children.length > 0;
    const overridden = (inner || entity.prefab) && sceneStore.hasOverrides(entity.id);

    const classes = [
        "tree-row",
        sceneStore.selectedId === entity.id ? "selected" : "",
        dropTarget ? "drop" : "",
        entity.active === false ? "inactive" : "",
        entity.prefab || inner ? "prefab" : "",
        inner ? "inner" : "",
        overridden ? "overridden" : ""
    ].join(" ");

    const title = inner
        ? `From the prefab; changing it here changes this instance only${overridden ? " (changed)" : ""}`
        : entity.prefab
            ? `Instance of prefab ${entity.prefab}${overridden ? ", with changes of its own" : ""}`
            : undefined;

    return (
        <>
            <div
                className={classes}
                draggable={!inner}
                title={title}
                onClick={() => sceneStore.select(entity.id)}
                // Like in Unity: a double click brings the camera to the object
                onDoubleClick={() => sceneStore.focus(entity.id)}
                onContextMenu={(e) => {
                    sceneStore.select(entity.id);
                    openContextMenu(e, inner ? innerContextMenu(entity) : entityContextMenu(entity));
                }}
                onDragStart={(e) => e.dataTransfer.setData(ENTITY_DRAG_TYPE, entity.id)}
                onDragOver={(e) => {
                    if (inner) return;
                    e.preventDefault();
                    e.stopPropagation();
                    setDropTarget(true);
                }}
                onDragLeave={() => setDropTarget(false)}
                onDrop={(e) => {
                    // Dropping an entity makes it a child; dropping an asset applies it to this entity
                    if (inner) return;
                    e.preventDefault();
                    e.stopPropagation();
                    setDropTarget(false);
                    const asset = getDraggedAsset(e);
                    if (asset) dropAsset(asset, entity.id);
                    else sceneStore.reparent(e.dataTransfer.getData(ENTITY_DRAG_TYPE), entity.id);
                }}
                style={{ paddingLeft: 6 + depth * 14 }}
            >
                <span
                    className={`twisty ${open ? "open" : ""}`}
                    onClick={(e) => {
                        e.stopPropagation();
                        setOpen(!open);
                    }}
                >
                    {hasChildren && <Icon name="chevron" size={10} />}
                </span>
                <Icon name={entityIcon(entity)} />
                <span className="name">{entity.name}</span>
            </div>
            {open && children.map((child) => (
                <Node key={child.id} entity={child} depth={depth + 1} inner={inner || expanded !== null} />
            ))}
        </>
    );
}

export default function Hierarchy() {
    const store = useSceneStore();

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
                    else store.reparent(e.dataTransfer.getData(ENTITY_DRAG_TYPE), null);
                }}
            >
                {store.entities.map((entity) => (
                    <Node key={entity.id} entity={entity} depth={0} />
                ))}
                {store.entities.length === 0 && (
                    <div className="empty">
                        The scene is empty.<br />
                        Press <b>Create</b> or right-click here to add an object.
                    </div>
                )}
            </div>
        </div>
    );
}
