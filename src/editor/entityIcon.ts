import type { EntityData } from "../engine";
import { getComponent } from "./core/SceneStore";
import type { IconName } from "./ui";

// The icon that tells what kind of object an entity is
export function entityIcon(entity: EntityData): IconName {
    if (entity.prefab) return "prefab";
    if (getComponent(entity, "light")) return "light";
    if (getComponent(entity, "camera")) return "camera";
    if (getComponent(entity, "mesh") || getComponent(entity, "model")) return "cube";
    return "empty";
}
