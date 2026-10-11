import type { ComponentData, EntityData } from "../engine";
import { applyOverrides, createPrefab, openPrefab } from "./core/actions";
import { sceneStore } from "./core/SceneStore";
import type { ContextSection } from "./contextMenu";
import type { IconName } from "./ui";

interface CreateItem {
    label: string;
    icon: IconName;
    components: ComponentData[];
}

// Same idea as Unity's GameObject menu: every item is an entity with a ready set of components
export const CREATE_MENU: { title?: string; items: CreateItem[] }[] = [
    {
        items: [{ label: "Empty Object", icon: "empty", components: [] }]
    },
    {
        title: "3D Object",
        items: ["box", "sphere", "cylinder", "capsule", "plane"].map((shape) => ({
            label: shape === "box" ? "Cube" : shape[0].toUpperCase() + shape.slice(1),
            icon: "cube",
            components: [{ type: "mesh", shape }]
        }))
    },
    {
        title: "Light",
        items: [
            { label: "Directional Light", icon: "light", components: [{ type: "light", kind: "directional" }] },
            { label: "Point Light", icon: "light", components: [{ type: "light", kind: "point", intensity: 10 }] },
            { label: "Spot Light", icon: "light", components: [{ type: "light", kind: "spot", intensity: 20 }] }
        ]
    },
    {
        // The interface of the game: flat, over the picture. Its elements live inside a Canvas.
        title: "UI",
        items: [
            { label: "Canvas", icon: "image", components: [{ type: "canvas" }] },
            { label: "Text", icon: "image", components: [{ type: "ui", width: 200, height: 40 }, { type: "text" }] },
            { label: "Image", icon: "image", components: [{ type: "ui", width: 100, height: 100 }, { type: "image" }] },
            {
                label: "Button",
                icon: "image",
                components: [{ type: "ui", width: 160, height: 44 }, { type: "image", color: "#2d6cdf" }, { type: "text", text: "Button" }, { type: "button" }]
            }
        ]
    },
    {
        title: "Other",
        items: [{ label: "Camera", icon: "camera", components: [{ type: "camera" }] }]
    }
];

// Where a new element of the interface goes, like in Unity: under `parentId` if that is inside a canvas (or
// is one), otherwise into the first canvas of the scene; if the scene has none, one is made
function canvasFor(parentId: string | null): string {
    let first: string | null = null;
    let fits = false;
    const visit = (list: EntityData[], inCanvas: boolean) => {
        for (const entity of list) {
            const shown = sceneStore.expand(entity) ?? entity;
            const inside = inCanvas || shown.components.some((component) => component.type === "canvas");
            if (inside && first === null) first = shown.id;
            if (inside && shown.id === parentId) fits = true;
            visit(shown.children, inside);
        }
    };
    visit(sceneStore.entities, false);
    if (fits && parentId) return parentId;
    return first ?? sceneStore.addEntity("Canvas", [{ type: "canvas" }], null).id;
}

export function createObject(item: CreateItem, parentId: string | null = null) {
    const name = item.components.length === 0 ? "GameObject" : item.label;
    if (item.components.some((component) => component.type === "ui")) parentId = canvasFor(parentId);
    sceneStore.select(sceneStore.addEntity(name, structuredClone(item.components), parentId).id);
}

// The "create" part of a context menu; with parentId the new object becomes a child
function createSections(parentId: string | null): ContextSection[] {
    return CREATE_MENU.map((section, i) => ({
        title: section.title ?? (i === 0 ? (parentId ? "Create child" : "Create") : undefined),
        items: section.items.map((item) => ({
            label: item.label,
            icon: item.icon,
            run: () => createObject(item, parentId)
        }))
    }));
}

// Right-click on empty space of the Hierarchy or the viewport
export function sceneContextMenu(): ContextSection[] {
    const paste: ContextSection = { items: sceneStore.clipboard ? [{ label: "Paste", shortcut: "Ctrl+V", run: () => sceneStore.paste() }] : [] };
    return [paste, ...createSections(null)];
}

// Copy from a menu: the text also goes to the system clipboard, where the browser allows it
export function copyToClipboard() {
    const text = sceneStore.copySelected();
    if (text) navigator.clipboard?.writeText(text).catch(() => {});
}

// Right-click on something inside a prefab instance
export function innerContextMenu(entity: EntityData): ContextSection[] {
    const store = sceneStore;
    const items: ContextSection["items"] = [{ label: "Focus", shortcut: "F", run: () => store.focus(entity.id) }];
    const many = store.selectedIds.length > 1 && store.selectedIds.includes(entity.id);
    items.push(
        { label: "Duplicate", icon: "copy", shortcut: "Ctrl+D", run: () => (many ? store.duplicateSelected() : store.select(store.duplicate(entity.id)?.id ?? entity.id)) },
        { label: "Copy", shortcut: "Ctrl+C", run: () => copyToClipboard() }
    );
    if (!many) items.push({ label: "Rename", shortcut: "F2", run: () => store.startRename(entity.id) });
    if (store.hasOverrides(entity.id) && !many) {
        items.push(
            { label: "Apply to Prefab", icon: "prefab", run: () => applyOverrides(entity.id) },
            { label: "Revert to Prefab", icon: "back", run: () => store.revertOverrides(entity.id) }
        );
    }
    // The prefab keeps it; only this instance is left without it
    items.push({
        label: many ? "Remove from This Instance (all selected)" : "Remove from This Instance",
        icon: "trash",
        shortcut: "Del",
        danger: true,
        run: () => (many ? store.removeSelected() : store.removeEntity(entity.id))
    });
    return many ? [{ items }] : [{ items }, ...createSections(entity.id)];
}

// Right-click on an object
export function entityContextMenu(entity: EntityData): ContextSection[] {
    const store = sceneStore;
    const isPrefabRoot = store.editingPrefab !== null && store.entities[0] === entity;

    // With several objects selected the menu is about all of them
    const many = store.selectedIds.length > 1 && store.selectedIds.includes(entity.id);
    const actions: ContextSection = {
        items: [{ label: "Focus", shortcut: "F", run: () => store.focus(entity.id) }]
    };
    if (!isPrefabRoot) {
        actions.items.push(
            { label: many ? `Duplicate ${store.selectedRoots.length} Objects` : "Duplicate", icon: "copy", shortcut: "Ctrl+D", run: () => store.duplicateSelected() },
            { label: "Copy", shortcut: "Ctrl+C", run: () => copyToClipboard() }
        );
    }
    if (store.clipboard) actions.items.push({ label: "Paste", shortcut: "Ctrl+V", run: () => store.paste() });
    if (!many) actions.items.push({ label: "Rename", shortcut: "F2", run: () => store.startRename(entity.id) });
    if (!store.editingPrefab || !isPrefabRoot) {
        actions.items.push({ label: many ? "Group" : "Group (new parent)", icon: "folder", shortcut: "Ctrl+G", run: () => store.groupSelected() });
    }
    if (many) {
        actions.items.push({ label: `Delete ${store.selectedRoots.length} Objects`, icon: "trash", shortcut: "Del", danger: true, run: () => store.removeSelected() });
        return [actions];
    }
    if (entity.prefab) {
        const prefab = entity.prefab;
        actions.items.push(
            { label: "Edit Prefab", icon: "prefab", run: () => openPrefab(prefab) },
            ...(entity.overrides ? [
                { label: "Apply All to Prefab", icon: "prefab" as const, run: () => applyOverrides(entity.id) },
                { label: "Revert All to Prefab", icon: "back" as const, run: () => store.revertOverrides(entity.id) },
            ] : []),
            { label: "Unpack Prefab", icon: "unlink", run: () => store.unpack(entity.id) }
        );
    } else if (!store.editingPrefab) {
        actions.items.push({ label: "Create Prefab", icon: "prefab", run: () => createPrefab(entity.id) });
    }
    if (!isPrefabRoot) {
        actions.items.push({ label: "Delete", icon: "trash", shortcut: "Del", danger: true, run: () => store.removeEntity(entity.id) });
    }

    // A child of an instance is one the instance adds to its prefab
    return [actions, ...createSections(entity.id)];
}
