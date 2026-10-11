import type { DragEvent } from "react";
import { createPrefabInstance } from "../../engine";
import { applySound, applyTexture } from "./actions";
import { getComponent, sceneStore } from "./SceneStore";
import type { AssetRef } from "./SceneStore";

// An entity dragged inside the Hierarchy
export const ENTITY_DRAG_TYPE = "application/x-white-entity";

// An asset dragged out of the Project panel
const ASSET_DRAG_TYPE = "application/x-white-asset";

export function setDraggedAsset(e: DragEvent, asset: AssetRef) {
    e.dataTransfer.setData(ASSET_DRAG_TYPE, JSON.stringify(asset));
}

export function getDraggedAsset(e: DragEvent): AssetRef | null {
    const data = e.dataTransfer.getData(ASSET_DRAG_TYPE);
    return data ? JSON.parse(data) : null;
}

// Puts a code model into the scene as a new entity
export function instantiateModel(name: string, parentId: string | null = null) {
    const label = sceneStore.registry.getModel(name)?.label ?? name;
    const entity = sceneStore.addEntity(label, [{ type: "model", model: name, params: {} }], parentId);
    sceneStore.select(entity.id);
    return entity;
}

// Puts an instance of the prefab into the scene
export function instantiatePrefab(name: string, parentId: string | null = null) {
    // A prefab cannot be placed inside itself
    if (sceneStore.editingPrefab === name) return null;
    const entity = sceneStore.insertEntity(createPrefabInstance(sceneStore.registry, name), parentId);
    sceneStore.select(entity.id);
    return entity;
}

// What happens when an asset is dropped onto an entity (or onto nothing: entityId = null)
export function dropAsset(asset: AssetRef, entityId: string | null) {
    if (asset.kind === "model") instantiateModel(asset.name, entityId);
    if (asset.kind === "prefab") instantiatePrefab(asset.name, entityId);
    // A look dropped anywhere becomes the look of the scene
    if (asset.kind === "look") sceneStore.setEnvironment("look", asset.name);
    if (asset.kind === "texture" && entityId) applyTexture(entityId, asset.name);
    if (asset.kind === "sound" && entityId) applySound(entityId, asset.name);
    // A behavior dropped onto an object is attached to it
    if (asset.kind === "behavior" && entityId) sceneStore.addComponent(entityId, "script", asset.name);
    if (asset.kind === "material" && entityId) {
        const found = sceneStore.findEntity(entityId);
        if (found && getComponent(found, "mesh")) {
            sceneStore.setComponentField(entityId, "mesh", "material", asset.name);
        }
    }
}
