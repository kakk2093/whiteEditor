import type { ComponentData, EntityData } from "../engine";
import { createPrefab, openPrefab } from "./core/actions";
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
        title: "Other",
        items: [{ label: "Camera", icon: "camera", components: [{ type: "camera" }] }]
    }
];

export function createObject(item: CreateItem, parentId: string | null = null) {
    const name = item.components.length === 0 ? "GameObject" : item.label;
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
    return createSections(null);
}

// Right-click on an object
export function entityContextMenu(entity: EntityData): ContextSection[] {
    const store = sceneStore;
    const isPrefabRoot = store.editingPrefab !== null && store.entities[0] === entity;

    const duplicate = () => {
        const copy = store.duplicate(entity.id);
        if (copy) store.select(copy.id);
    };

    const actions: ContextSection = {
        items: [{ label: "Focus", shortcut: "F", run: () => store.focus(entity.id) }]
    };
    if (!isPrefabRoot) {
        actions.items.push({ label: "Duplicate", icon: "copy", shortcut: "Ctrl+D", run: duplicate });
    }
    if (entity.prefab) {
        const prefab = entity.prefab;
        actions.items.push(
            { label: "Edit Prefab", icon: "prefab", run: () => openPrefab(prefab) },
            { label: "Unpack Prefab", icon: "unlink", run: () => store.unpack(entity.id) }
        );
    } else if (!store.editingPrefab) {
        actions.items.push({ label: "Create Prefab", icon: "prefab", run: () => createPrefab(entity.id) });
    }
    if (!isPrefabRoot) {
        actions.items.push({ label: "Delete", icon: "trash", shortcut: "Del", danger: true, run: () => store.removeEntity(entity.id) });
    }

    // An instance has no children of its own
    return entity.prefab ? [actions] : [actions, ...createSections(entity.id)];
}
