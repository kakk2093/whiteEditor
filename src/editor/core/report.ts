import { editorLog } from "./log";
import { sceneStore } from "./SceneStore";

// Tells the dev server what the editor shows now, so that `npm run editor` can print it: an AI agent working
// on the project from the command line then knows what is open, what is selected, what is not saved yet and
// what the Console says, without being told.

// One editor page among several open ones
const TAB = Math.random().toString(36).slice(2, 8);

// How many of the last Console messages go along
const MESSAGES = 40;

function state() {
    const store = sceneStore;
    const dirty = store.project !== "" && store.dirty;
    return {
        tab: TAB,
        project: store.project,
        scene: store.sceneName,
        // The prefab being edited instead of the scene, if one is
        editingPrefab: store.editingPrefab,
        dirty,
        // What is in the editor and not on disk yet: the scene (or the prefab) as it would be saved
        unsaved: dirty ? (store.editingPrefab ? store.prefabJSON() : store.toJSON()) : null,
        selected: store.selectedIds.map((id) => ({ id, name: store.findEntity(id)?.name ?? "" })),
        asset: store.selectedAsset,
        playing: store.playing,
        paused: store.paused,
        // The scene Play has gone to with self.loadScene(), if it is not the open one
        playScene: store.playScene,
        look: store.environment.look,
        status: store.status,
        errors: editorLog.count("error"),
        warnings: editorLog.count("warn"),
        console: editorLog.entries.slice(-MESSAGES).map((entry) => ({ level: entry.level, text: entry.text, count: entry.count })),
    };
}

let started = false;

// From now on every change of the editor is told to the dev server, a moment after it settles
export function reportState() {
    if (started) return;
    started = true;
    let timer = 0;
    let sent = "";
    const send = () => {
        const body = JSON.stringify(state());
        if (body === sent) return;
        sent = body;
        // No dev server (a built editor), or it is restarting: nobody to tell
        fetch("/__api/editor", { method: "POST", body }).catch(() => {});
    };
    const later = () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(send, 400);
    };
    sceneStore.subscribe(later);
    editorLog.subscribe(later);
    later();
}
