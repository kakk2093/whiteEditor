import { parsePrefab, parseScene, validateScene } from "../../engine";
import type { LookData, MaterialData } from "../../engine";
import type { AssetSection } from "./project";
import { sceneStore } from "./SceneStore";
import {
    buildGame as build,
    createProject,
    deleteAsset,
    listAssets,
    listProjects,
    loadRegistry,
    readAsset,
    writeAsset
} from "./project";

// Everything the editor does with the project on disk. Errors end up in the status line.

const LAST_PROJECT = "white:project";
const lastSceneKey = (project: string) => `white:scene:${project}`;

// Names of projects and assets are file names
export const NAME_PATTERN = /^[\w-]+$/;

function report(e: unknown) {
    console.error(e);
    sceneStore.update({ status: e instanceof Error ? e.message : String(e) });
}

// A free name like "Material", "Material_1", ...
function freeName(base: string, taken: string[]) {
    const stem = base.replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "") || "Asset";
    let name = stem;
    for (let n = 1; taken.includes(name); n++) name = `${stem}_${n}`;
    return name;
}

// Reads a scene file into the editor; returns a note about problems found in it ("" if none)
async function loadSceneFile(project: string, name: string) {
    const data = parseScene(await readAsset(project, "scenes", name));
    sceneStore.load(data);

    const problems = validateScene(data, sceneStore.registry);
    problems.forEach((problem) => console.warn(`${name}: ${problem}`));
    return problems.length > 0 ? ` (${problems.length} problems, first: ${problems[0]})` : "";
}

async function loadScripts(project: string) {
    const { registry, errors } = await loadRegistry(project);
    sceneStore.setRegistry(registry);
    return errors;
}

export async function openProject(name: string) {
    try {
        sceneStore.closePrefab();
        const errors = await loadScripts(name);
        const scenes = await listAssets(name, "scenes");
        const last = localStorage.getItem(lastSceneKey(name));
        const first = last && scenes.includes(last) ? last : scenes[0];

        let note = "";
        if (first) note = await loadSceneFile(name, first);
        else sceneStore.newScene();

        localStorage.setItem(LAST_PROJECT, name);
        sceneStore.update({
            project: name,
            scenes,
            sceneName: first ?? "main",
            status: errors.length > 0 ? errors.join("; ") : `Opened project ${name}${note}`
        });
    } catch (e) {
        report(e);
    }
}

export async function newProject(name: string) {
    try {
        // Creating the project's tsconfig.json makes Vite reload the page, so remember it first
        localStorage.setItem(LAST_PROJECT, name);
        await createProject(name);
        sceneStore.update({ projects: await listProjects() });
        await openProject(name);
    } catch (e) {
        report(e);
    }
}

// Called once when the editor starts: reopens what was open last time
export async function init() {
    try {
        const projects = await listProjects();
        sceneStore.update({ projects });
        const last = localStorage.getItem(LAST_PROJECT);
        if (last && projects.includes(last)) await openProject(last);
    } catch (e) {
        report(e);
    }
}

// Scripts edited in VS Code: reload them and rebuild the scene objects, keeping the scene data
export async function reloadScripts(project: string) {
    if (project !== sceneStore.project) return;
    try {
        const errors = await loadScripts(project);
        sceneStore.update({ status: errors.length > 0 ? errors.join("; ") : "Scripts reloaded" });
    } catch (e) {
        report(e);
    }
}

async function saveScene(name = sceneStore.sceneName) {
    const { project } = sceneStore;
    await writeAsset(project, "scenes", name, sceneStore.toJSON());
    sceneStore.markSaved();
    localStorage.setItem(lastSceneKey(project), name);
    sceneStore.update({
        sceneName: name,
        scenes: await listAssets(project, "scenes"),
        status: `Saved scenes/${name}.json`
    });
}

async function savePrefab() {
    const { project, editingPrefab: name, registry } = sceneStore;
    if (!name) return;
    const data = sceneStore.prefabJSON();
    await writeAsset(project, "prefabs", name, data);
    registry.setPrefab(name, structuredClone(data.root));
    sceneStore.markSaved();
    sceneStore.update({ status: `Saved prefabs/${name}.json` });
}

// What was edited during Play may still be dropped on Stop, so it must not reach the disk before that
function blockedByPlay() {
    if (sceneStore.playing) sceneStore.update({ status: "Stop Play first" });
    return sceneStore.playing;
}

// Ctrl+S: saves what is open, the scene or the prefab being edited
export async function save() {
    if (!sceneStore.project || blockedByPlay()) return;
    try {
        if (sceneStore.editingPrefab) await savePrefab();
        else await saveScene();
    } catch (e) {
        report(e);
    }
}

// Builds the game that starts with the open scene; returns the address to open it at, or null if it failed.
// The build is made from the files on disk, so the scene has to be saved first.
export async function buildGame() {
    const { project, sceneName } = sceneStore;
    if (sceneStore.dirty) {
        sceneStore.update({ status: "Save first: the game is built from the files on disk" });
        return null;
    }
    try {
        sceneStore.update({ status: `Building ${project}…` });
        const started = Date.now();
        const result = await build(project, sceneName);
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        sceneStore.update({ status: `Built projects/${project}/build in ${seconds} s, the game starts with scene "${result.scene}"` });
        return result.url;
    } catch (e) {
        report(e);
        return null;
    }
}

export async function saveSceneAs(name: string) {
    if (blockedByPlay()) return;
    try {
        await saveScene(name);
    } catch (e) {
        report(e);
    }
}

export async function newScene(name: string) {
    try {
        await closePrefab();
        sceneStore.newScene();
        await saveScene(name);
    } catch (e) {
        report(e);
    }
}

export async function openScene(name: string) {
    const { project } = sceneStore;
    try {
        await closePrefab();
        const note = await loadSceneFile(project, name);
        localStorage.setItem(lastSceneKey(project), name);
        sceneStore.update({ sceneName: name, status: `Opened scenes/${name}.json${note}` });
    } catch (e) {
        report(e);
    }
}

export async function deleteScene(name: string) {
    const { project } = sceneStore;
    try {
        await deleteAsset(project, "scenes", name);
        sceneStore.selectAsset(null);
        sceneStore.update({ scenes: await listAssets(project, "scenes"), status: `Deleted scenes/${name}.json` });
    } catch (e) {
        report(e);
    }
}

// Saves the entity with its children as a prefab asset and turns the entity into an instance of it
export async function createPrefab(entityId: string) {
    const { project, registry } = sceneStore;
    const entity = sceneStore.findEntity(entityId);
    if (!entity || entity.prefab || sceneStore.editingPrefab || blockedByPlay()) return;
    try {
        const name = freeName(entity.name, registry.prefabNames());
        const root = { ...structuredClone(entity), position: [0, 0, 0] as [number, number, number] };
        await writeAsset(project, "prefabs", name, { version: 3, root });
        registry.setPrefab(name, root);
        sceneStore.convertToInstance(entityId, name);
        sceneStore.update({ status: `Created prefabs/${name}.json` });
    } catch (e) {
        report(e);
    }
}

export function openPrefab(name: string) {
    if (sceneStore.editingPrefab === name) return;
    closePrefab().then(() => {
        sceneStore.openPrefab(name);
        sceneStore.update({ status: `Editing prefab ${name}` });
    });
}

// Leaves prefab editing; unsaved changes of the prefab are saved, like Unity's auto save
export async function closePrefab() {
    if (!sceneStore.editingPrefab) return;
    try {
        if (sceneStore.dirty) await savePrefab();
    } catch (e) {
        report(e);
    }
    sceneStore.closePrefab();
}

export async function deletePrefab(name: string) {
    const { project, registry } = sceneStore;
    try {
        if (sceneStore.editingPrefab === name) sceneStore.closePrefab();
        await deleteAsset(project, "prefabs", name);
        registry.removePrefab(name);
        sceneStore.selectAsset(null);
        // Its instances turn into placeholders
        sceneStore.setRegistry(registry);
        sceneStore.update({ status: `Deleted prefabs/${name}.json` });
    } catch (e) {
        report(e);
    }
}

// A file was edited outside the editor (VS Code, an AI agent): show the new state without losing editor work
export async function assetChangedOnDisk(project: string, section: AssetSection, name: string) {
    if (project !== sceneStore.project) return;
    try {
        if (section === "scenes") {
            const scenes = await listAssets(project, "scenes");
            sceneStore.update({ scenes });
            if (sceneStore.editingPrefab || name !== sceneStore.sceneName || !scenes.includes(name)) return;

            if (sceneStore.dirty) {
                sceneStore.update({ status: `${name}.json changed on disk, but the editor has unsaved changes. Reopen the scene to load it, Save overwrites it.` });
                return;
            }
            const note = await loadSceneFile(project, name);
            sceneStore.update({ status: `Reloaded ${name}.json from disk${note}` });
        }

        if (section === "materials") {
            const { registry } = sceneStore;
            if ((await listAssets(project, "materials")).includes(name)) {
                const isNew = !registry.getMaterialData(name);
                registry.setMaterial(name, (await readAsset(project, "materials", name)) as object);
                // A mesh may already refer to a material that did not exist until now
                if (isNew) sceneStore.setRegistry(registry);
                else sceneStore.changed();
            } else {
                registry.removeMaterial(name);
                if (sceneStore.selectedAsset?.name === name) sceneStore.selectAsset(null);
                sceneStore.setRegistry(registry);
            }
            sceneStore.update({ status: `Material ${name} updated from disk` });
        }

        if (section === "looks") {
            const { registry } = sceneStore;
            if ((await listAssets(project, "looks")).includes(name)) {
                registry.setLook(name, (await readAsset(project, "looks", name)) as LookData);
            } else {
                registry.removeLook(name);
                if (sceneStore.selectedAsset?.kind === "look" && sceneStore.selectedAsset.name === name) sceneStore.selectAsset(null);
            }
            sceneStore.update({ status: `Look ${name} updated from disk` });
        }

        if (section === "prefabs") {
            const { registry } = sceneStore;
            const exists = (await listAssets(project, "prefabs")).includes(name);
            if (exists) registry.setPrefab(name, parsePrefab(await readAsset(project, "prefabs", name)).root);
            else registry.removePrefab(name);

            if (sceneStore.editingPrefab === name) {
                if (!exists) {
                    sceneStore.closePrefab();
                } else if (sceneStore.dirty) {
                    sceneStore.update({ status: `Prefab ${name} changed on disk, but the editor has unsaved changes of it. Save overwrites it.` });
                    return;
                } else {
                    sceneStore.openPrefab(name);
                }
            }
            sceneStore.setRegistry(registry);
            sceneStore.update({ status: `Prefab ${name} updated from disk` });
        }
    } catch (e) {
        report(e);
    }
}

export async function createMaterial() {
    const { project, registry } = sceneStore;
    try {
        const name = freeName("Material", registry.materialNames());
        await writeAsset(project, "materials", name, {});
        registry.setMaterial(name, {});
        sceneStore.selectAsset({ kind: "material", name });
    } catch (e) {
        report(e);
    }
}

const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();

// Applies the change at once and writes the file a moment later, so dragging a value does not flood the disk
export function updateMaterial<K extends keyof MaterialData>(name: string, key: K, value: MaterialData[K]) {
    const { project, registry } = sceneStore;
    const data = { ...registry.getMaterialData(name), [key]: value };
    registry.setMaterial(name, data);
    sceneStore.changed();

    clearTimeout(pendingWrites.get(name));
    pendingWrites.set(name, setTimeout(() => {
        pendingWrites.delete(name);
        writeAsset(project, "materials", name, data).catch(report);
    }, 300));
}

// A new look starts as the pixel-art one: small picture, outlines, few colors
export async function createLook() {
    const { project, registry } = sceneStore;
    try {
        const name = freeName("Look", registry.lookNames());
        const data: LookData = { pixelSize: 3, effects: [{ effect: "outline" }, { effect: "palette" }] };
        await writeAsset(project, "looks", name, data);
        registry.setLook(name, data);
        sceneStore.selectAsset({ kind: "look", name });
    } catch (e) {
        report(e);
    }
}

// Like updateMaterial: applies at once, writes the file a moment later
export function updateLook(name: string, data: LookData) {
    const { project, registry } = sceneStore;
    registry.setLook(name, data);
    sceneStore.changed();

    const key = `looks/${name}`;
    clearTimeout(pendingWrites.get(key));
    pendingWrites.set(key, setTimeout(() => {
        pendingWrites.delete(key);
        writeAsset(project, "looks", name, data).catch(report);
    }, 300));
}

export async function deleteLook(name: string) {
    const { project, registry } = sceneStore;
    try {
        clearTimeout(pendingWrites.get(`looks/${name}`));
        pendingWrites.delete(`looks/${name}`);
        await deleteAsset(project, "looks", name);
        registry.removeLook(name);
        sceneStore.selectAsset(null);
    } catch (e) {
        report(e);
    }
}

export async function deleteMaterial(name: string) {
    const { project, registry } = sceneStore;
    try {
        clearTimeout(pendingWrites.get(name));
        pendingWrites.delete(name);
        await deleteAsset(project, "materials", name);
        registry.removeMaterial(name);
        sceneStore.selectAsset(null);
        // Meshes that used it fall back to the default material
        sceneStore.setRegistry(registry);
    } catch (e) {
        report(e);
    }
}
