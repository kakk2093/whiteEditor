import { useSyncExternalStore } from "react";
import { sceneStore } from "./SceneStore";

// Re-renders the component on every scene change
export function useSceneStore() {
    useSyncExternalStore(sceneStore.subscribe, sceneStore.getVersion);
    return sceneStore;
}
