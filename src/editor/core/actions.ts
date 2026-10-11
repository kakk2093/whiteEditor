import {
    applyToPrefab, parsePrefab, parseScene, renameLayerIn, resolveLook, SOUND_FILE, validateLook, validateMaterial, validatePrefab, validateScene
} from "../../engine";
import type { LookData, MaterialData, ProjectSettings, SceneData } from "../../engine";
import { renameInEntities, renameInScene } from "./references";
import { changeFolder, moveToFolder, parseFolders, removeFolderTree, renameFolderTree, renameInFolders } from "./folders";
import type { Folders, FolderSection } from "./folders";
import type { AssetSection } from "./project";
import { sceneStore } from "./SceneStore";
import {
    buildGame as build,
    createProject,
    deleteAsset,
    deleteImage,
    listAssets,
    listProjects,
    loadRegistry,
    readAsset,
    readFolders,
    revealFile,
    uploadImage,
    writeAsset,
    writeFolders,
    writeSettings
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

        // A broken folders.json must not keep the project from opening: everything shows without folders
        const folders = await readFolders(name).then(parseFolders, () => ({}));

        localStorage.setItem(LAST_PROJECT, name);
        sceneStore.update({
            project: name,
            scenes,
            folders,
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

// The folders of the Project panel: shown at once and written to folders.json; a step of undo
async function saveFolders(folders: Folders, status: string) {
    try {
        sceneStore.recordAsset("folders", "folders", sceneStore.folders, folders);
        sceneStore.update({ folders, status });
        await writeFolders(sceneStore.project, folders);
    } catch (e) {
        report(e);
    }
}

export function createFolder(section: FolderSection, name: string) {
    return saveFolders(changeFolder(sceneStore.folders, section, null, name), `Folder ${name} added to ${section}`);
}

export function renameFolder(section: FolderSection, from: string, to: string) {
    return saveFolders(renameFolderTree(sceneStore.folders, section, from, to), `Folder ${from} renamed to ${to}`);
}

// Only the folder goes, with the folders inside it: what was in them shows in the folder above (or at the top)
export function deleteFolder(section: FolderSection, name: string) {
    return saveFolders(removeFolderTree(sceneStore.folders, section, name), `Folder ${name} removed; its ${section} are kept`);
}

// `folder` = null takes the asset out of its folder
export function moveAssetToFolder(section: FolderSection, name: string, folder: string | null) {
    return saveFolders(
        moveToFolder(sceneStore.folders, section, name, folder),
        folder === null ? `${name} taken out of its folder` : `${name} moved to folder ${folder}`
    );
}

// folders.json edited outside the editor
export async function foldersChangedOnDisk(project: string) {
    if (project !== sceneStore.project) return;
    try {
        sceneStore.update({ folders: parseFolders(await readFolders(project)), status: "folders.json changed on disk — reloaded" });
    } catch (e) {
        report(e);
    }
}

// Shows a file or a folder of the open project in the file manager of the system ("" is the project itself)
export async function showInExplorer(path = "") {
    try {
        await revealFile(sceneStore.project, path);
        sceneStore.update({ status: `Shown in the file manager: projects/${sceneStore.project}/${path}` });
    } catch (e) {
        report(e);
    }
}

// Puts a text into the clipboard of the system
export function copyText(text: string) {
    navigator.clipboard?.writeText(text).then(
        () => sceneStore.update({ status: `Copied: ${text}` }),
        () => sceneStore.update({ status: "The browser did not let the editor use the clipboard" })
    );
}

// The settings of the project (project.json): applied at once and written to the file; a step of undo
export async function updateSettings(settings: ProjectSettings) {
    const { project, registry } = sceneStore;
    try {
        sceneStore.recordAsset("settings", "settings", registry.settings, settings);
        registry.setSettings(settings);
        // The colliders of a running scene read the layers from the registry
        sceneStore.setRegistry(registry);
        await writeSettings(project, settings);
    } catch (e) {
        report(e);
    }
}

// Gives a collision layer another name: in the settings and in every collider that names it, in the scenes
// and the prefabs on disk and in the open scene (whose unsaved changes stay unsaved). Not a step of undo.
export async function renameLayer(from: string, to: string) {
    const { project, registry } = sceneStore;
    const name = to.trim();
    if (!name || name === from || !registry.settings.layers.includes(from)) return;
    if (name === "Default" || registry.settings.layers.includes(name)) {
        sceneStore.update({ status: `There already is a layer named ${name}` });
        return;
    }
    if (sceneStore.editingPrefab) {
        sceneStore.update({ status: "Go back to the scene to rename a layer" });
        return;
    }
    if (blockedByPlay()) return;
    try {
        const settings = renameLayerIn(registry.settings, from, name);
        // The new name must be a layer already when the colliders get it
        registry.setSettings(settings);
        await writeSettings(project, settings);

        let files = 0;
        for (const prefab of registry.prefabNames()) {
            const root = structuredClone(registry.getPrefab(prefab)!);
            if (!renameInEntities(registry, [root], "layer", from, name)) continue;
            registry.setPrefab(prefab, root);
            await writeAsset(project, "prefabs", prefab, { version: 3, root });
            files++;
        }
        for (const scene of await listAssets(project, "scenes")) {
            const data = (await readAsset(project, "scenes", scene)) as SceneData;
            if (!renameInScene(registry, data, "layer", from, name)) continue;
            await writeAsset(project, "scenes", scene, data);
            files++;
        }
        sceneStore.renameReferences((scene) => renameInScene(registry, scene, "layer", from, name), "settings", from, name);
        sceneStore.setRegistry(registry);
        sceneStore.update({ status: `Layer ${from} renamed to ${name}${files > 0 ? `; ${files} file(s) that use it updated` : ""}` });
    } catch (e) {
        report(e);
    }
}

// Every scene, prefab, material and look on disk checked against the engine, like `npm run check` does (the
// types of the scripts are not checked here). Returns the problems found, "<file>: <what>".
export async function validateProject() {
    const { project, registry } = sceneStore;
    const problems: string[] = [];
    const each = async (section: AssetSection, check: (name: string, data: unknown) => string[]) => {
        for (const name of await listAssets(project, section)) {
            try {
                for (const problem of check(name, await readAsset(project, section, name))) problems.push(`${section}/${name}.json: ${problem}`);
            } catch (e) {
                problems.push(`${section}/${name}.json: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    };
    await each("materials", (_, data) => validateMaterial(data, registry));
    await each("looks", (name, data) => validateLook(name, data as LookData, registry));
    await each("prefabs", (name, data) => validatePrefab(name, parsePrefab(data), registry));
    await each("scenes", (_, data) => validateScene(parseScene(data), registry));
    const start = registry.settings.startScene;
    if (start && !sceneStore.scenes.includes(start)) problems.push(`project.json: startScene: there is no scene "${start}"`);
    return problems;
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
        // A game is not built from a project with mistakes in it: they are listed in the Console
        sceneStore.update({ status: `Checking ${project}…` });
        const problems = await validateProject();
        if (problems.length > 0) {
            problems.forEach((problem) => console.error(problem));
            sceneStore.update({ status: `Not built: ${problems.length} problem(s) in the project, see the Console` });
            sceneStore.setConsoleOpen(true);
            return null;
        }
        sceneStore.update({ status: `Building ${project}…` });
        const started = Date.now();
        // The start scene of the project settings; without one, the open scene
        const result = await build(project, sceneStore.registry.settings.startScene || sceneName);
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
        const before = await readAsset(project, "scenes", name);
        await deleteAsset(project, "scenes", name);
        sceneStore.recordAsset("scenes", name, before, null);
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
    if (!entity || entity.prefab || sceneStore.isInner(entityId) || sceneStore.editingPrefab || blockedByPlay()) return;
    try {
        const name = freeName(entity.name, registry.prefabNames());
        const root = { ...structuredClone(entity), position: [0, 0, 0] as [number, number, number] };
        await writeAsset(project, "prefabs", name, { version: 3, root });
        registry.setPrefab(name, root);
        // Two steps: undo first turns the instance back into the object, then takes the prefab file away
        sceneStore.recordAsset("prefabs", name, null, { version: 3, root });
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

// Writes what an instance changes into its prefab, so that every instance gets it; the instance then no
// longer differs. For an id of something inside the instance: only the changes of that one object.
export async function applyOverrides(id: string) {
    const { project, registry } = sceneStore;
    const instance = sceneStore.instanceOf(id);
    const root = instance?.prefab ? registry.getPrefab(instance.prefab) : null;
    if (!instance?.prefab || !instance.overrides || !root || blockedByPlay()) return;
    // A prefab that is open for editing is saved from there
    if (sceneStore.editingPrefab === instance.prefab) return;
    try {
        const name = instance.prefab;
        const path = sceneStore.pathIn(id);
        const overrides = path === null ? instance.overrides : { [path]: instance.overrides[path] ?? {} };
        const changed = applyToPrefab(root, overrides);
        await writeAsset(project, "prefabs", name, { version: 3, root: changed });
        // Two steps: undo first gives the instance its changes back, then the prefab its old content
        sceneStore.recordAsset("prefabs", name, { version: 3, root }, { version: 3, root: changed });
        registry.setPrefab(name, changed);
        sceneStore.revertOverrides(id);
        // Every other instance shows the new prefab
        sceneStore.setRegistry(registry);
        sceneStore.update({ status: `Applied to prefabs/${name}.json; every instance of ${name} follows` });
    } catch (e) {
        report(e);
    }
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
        const root = registry.getPrefab(name);
        await deleteAsset(project, "prefabs", name);
        if (root) sceneStore.recordAsset("prefabs", name, { version: 3, root }, null);
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
        sceneStore.recordAsset("materials", name, null, {});
        sceneStore.selectAsset({ kind: "material", name });
    } catch (e) {
        report(e);
    }
}

const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();

// Applies the change at once and writes the file a moment later, so dragging a value does not flood the disk
export function updateMaterial<K extends keyof MaterialData>(name: string, key: K, value: MaterialData[K]) {
    const { project, registry } = sceneStore;
    const before = registry.getMaterialData(name) ?? {};
    const data = { ...before, [key]: value };
    registry.setMaterial(name, data);
    sceneStore.recordAsset("materials", name, before, data);
    sceneStore.changed();

    clearTimeout(pendingWrites.get(name));
    pendingWrites.set(name, setTimeout(() => {
        pendingWrites.delete(name);
        writeAsset(project, "materials", name, data).catch(report);
    }, 300));
}

// Image and audio files (dropped into the Project panel) go into assets/ and become textures and sounds. A
// name the project cannot keep is tidied up; a file with the name of an existing one replaces it.
// Tells what the last of them is, null if none was taken.
export async function uploadFiles(files: File[]): Promise<"texture" | "sound" | null> {
    const { project } = sceneStore;
    const images = files.filter((file) => /\.(png|jpe?g|webp)$/i.test(file.name) || SOUND_FILE.test(file.name));
    if (images.length === 0) {
        sceneStore.update({ status: "Only images (.png, .jpg, .webp) and sounds (.mp3, .ogg, .wav) can be added" });
        return null;
    }
    try {
        const names: string[] = [];
        for (const file of images) {
            const dot = file.name.lastIndexOf(".");
            const stem = file.name.slice(0, dot).replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "") || "image";
            const name = `${stem}${file.name.slice(dot).toLowerCase()}`;
            await uploadImage(project, name, file);
            names.push(name);
        }
        // The same reload as after an edit of scripts: the registry gets the new list of images
        await loadScripts(project);
        const last = names[names.length - 1];
        const kind = SOUND_FILE.test(last) ? "sound" : "texture";
        sceneStore.selectAsset({ kind, name: last });
        sceneStore.update({ status: `Added to assets/: ${names.join(", ")}` });
        return kind;
    } catch (e) {
        report(e);
        return null;
    }
}

// A sound dropped onto an object: the object gets a Sound component with it, or its Sound component gets it
export function applySound(entityId: string, sound: string) {
    const entity = sceneStore.findEntity(entityId);
    const content = entity && (sceneStore.expand(entity) ?? entity);
    if (!content) return;
    // One step of undo
    sceneStore.batch(() => {
        if (!content.components.some((component) => component.type === "sound")) sceneStore.addComponent(entityId, "sound");
        sceneStore.setComponentField(entityId, "sound", "sound", sound);
    });
    sceneStore.update({ status: `${content.name} plays ${sound}` });
}

// Removes an image or an audio file of assets/
export async function deleteTexture(name: string) {
    const { project } = sceneStore;
    try {
        await deleteImage(project, name);
        await loadScripts(project);
        sceneStore.selectAsset(null);
        sceneStore.update({ status: `Deleted assets/${name}` });
    } catch (e) {
        report(e);
    }
}

// A texture dropped onto an object: the object gets a material with that texture. A material named after
// the image is used if there is one, otherwise it is made.
export async function applyTexture(entityId: string, texture: string) {
    const { project, registry } = sceneStore;
    const entity = sceneStore.findEntity(entityId);
    const content = entity && (sceneStore.expand(entity) ?? entity);
    if (!content?.components.some((component) => component.type === "mesh")) {
        sceneStore.update({ status: "Drop a texture onto an object with a Mesh" });
        return;
    }
    try {
        const stem = texture.slice(texture.lastIndexOf("/") + 1, texture.lastIndexOf("."));
        let name = registry.materialNames().find((material) => registry.getMaterialData(material)?.texture === texture);
        if (!name) {
            name = freeName(stem.charAt(0).toUpperCase() + stem.slice(1), registry.materialNames());
            const data = { color: "#ffffff", texture };
            await writeAsset(project, "materials", name, data);
            registry.setMaterial(name, data);
            sceneStore.recordAsset("materials", name, null, data);
        }
        sceneStore.setComponentField(entityId, "mesh", "material", name);
        sceneStore.update({ status: `Material ${name} with ${texture}` });
    } catch (e) {
        report(e);
    }
}

// A copy of a material or a look under a free name
export async function duplicateAsset(kind: "material" | "look", name: string) {
    const { project, registry } = sceneStore;
    const section = kind === "material" ? "materials" : "looks";
    try {
        const source = kind === "material" ? registry.getMaterialData(name) : registry.getLookData(name);
        if (!source) return;
        const data = structuredClone(source);
        const copy = freeName(name, kind === "material" ? registry.materialNames() : registry.lookNames());
        await writeAsset(project, section, copy, data);
        if (kind === "material") registry.setMaterial(copy, data as Partial<MaterialData>);
        else registry.setLook(copy, data as LookData);
        sceneStore.recordAsset(section, copy, null, data);
        sceneStore.selectAsset({ kind, name: copy });
        sceneStore.update({ status: `Created ${section}/${copy}.json` });
    } catch (e) {
        report(e);
    }
}

// Adds an effect or a surface to the look of the open scene
export function addToLook(list: "effects" | "surfaces", name: string) {
    const { registry } = sceneStore;
    const look = sceneStore.environment.look;
    const data = look ? registry.getLookData(look) : undefined;
    if (!look || !data) {
        sceneStore.update({ status: "The scene has no look to add it to: pick one in the viewport first" });
        return;
    }
    const key = list === "effects" ? "effect" : "surface";
    const has = (resolveLook(registry, look)?.[list] ?? []).some((entry) => (entry as Record<string, unknown>)[key] === name);
    if (has) {
        sceneStore.update({ status: `The look ${look} already has ${name}` });
        return;
    }
    updateLook(look, { ...data, [list]: [...(data[list] ?? []), { [key]: name }] });
    sceneStore.update({ status: `Added ${name} to the look ${look}` });
}

// Undo and redo of an asset step: makes the asset what it was, in the editor and on disk.
// null removes it (undo of its creation) or, the other way, a deleted one comes back.
sceneStore.assetHandler = (section, name, data) => {
    const { project, registry } = sceneStore;
    if (section === "folders") {
        sceneStore.update({ folders: data as Folders });
        writeFolders(project, data).catch(report);
        return;
    }
    if (section === "settings") {
        registry.setSettings(data as ProjectSettings);
        sceneStore.setRegistry(registry);
        writeSettings(project, data as ProjectSettings).catch(report);
        return;
    }
    if (section === "scenes") {
        // Never the open scene: that one cannot be deleted
        const done = data === null ? deleteAsset(project, section, name) : writeAsset(project, section, name, data);
        done.then(async () => sceneStore.update({ scenes: await listAssets(project, "scenes") })).catch(report);
        return;
    }
    if (section === "prefabs") {
        if (data === null) {
            deleteAsset(project, section, name).catch(report);
            registry.removePrefab(name);
            if (sceneStore.selectedAsset?.kind === "prefab" && sceneStore.selectedAsset.name === name) sceneStore.selectAsset(null);
        } else {
            writeAsset(project, section, name, data).catch(report);
            registry.setPrefab(name, parsePrefab(data).root);
        }
        // Its instances are built again from what the prefab is now
        sceneStore.setRegistry(registry);
        return;
    }

    const kind = section === "materials" ? "material" : "look";
    const key = section === "materials" ? name : `looks/${name}`;
    clearTimeout(pendingWrites.get(key));
    pendingWrites.delete(key);

    const existed = section === "materials" ? registry.getMaterialData(name) !== undefined : registry.getLookData(name) !== undefined;
    if (data === null) {
        deleteAsset(project, section, name).catch(report);
        if (section === "materials") registry.removeMaterial(name);
        else registry.removeLook(name);
        if (sceneStore.selectedAsset?.kind === kind && sceneStore.selectedAsset.name === name) sceneStore.selectAsset(null);
    } else {
        writeAsset(project, section, name, data).catch(report);
        if (section === "materials") registry.setMaterial(name, data as Partial<MaterialData>);
        else registry.setLook(name, data as LookData);
    }
    // A material that appeared or went away: the meshes that name it have to be built again
    if (section === "materials" && existed !== (data !== null)) sceneStore.setRegistry(registry);
};

// Play asks for another scene (self.loadScene of a behavior): it is read from its file
sceneStore.sceneLoader = async (name) => parseScene(await readAsset(sceneStore.project, "scenes", name));

// true if `to` can be the new name of the asset `from`; otherwise says why not in the status line
function nameIsFree(kind: string, names: string[], from: string, to: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(to)) {
        sceneStore.update({ status: "A name can have only Latin letters, digits, _ and -" });
        return false;
    }
    // File names differ by more than the case of the letters
    if (names.some((name) => name !== from && name.toLowerCase() === to.toLowerCase())) {
        sceneStore.update({ status: `There already is a ${kind} named ${to}` });
        return false;
    }
    return true;
}

// Gives a scene file another name. Nothing refers to a scene by name, so only the file changes; for the
// open scene it is the file as it was last saved, unsaved changes stay unsaved.
export async function renameScene(from: string, to: string) {
    const { project } = sceneStore;
    if (to === from || !sceneStore.scenes.includes(from)) return;
    if (!nameIsFree("scene", sceneStore.scenes, from, to) || blockedByPlay()) return;
    try {
        await writeAsset(project, "scenes", to, await readAsset(project, "scenes", from));
        if (to.toLowerCase() !== from.toLowerCase()) await deleteAsset(project, "scenes", from);
        sceneStore.selectAsset({ kind: "scene", name: to });
        sceneStore.update({
            ...(sceneStore.sceneName === from ? { sceneName: to } : {}),
            scenes: await listAssets(project, "scenes"),
        });
        await saveFolders(renameInFolders(sceneStore.folders, "scenes", from, to), `Renamed scenes/${from} to ${to}`);
    } catch (e) {
        report(e);
    }
}

// Gives a material, a look or a prefab another name: the file, and every scene, prefab and look that refers
// to it. The files are rewritten at once, the open scene included (its unsaved changes stay unsaved).
export async function renameAsset(kind: "material" | "look" | "prefab", from: string, to: string) {
    const { project, registry } = sceneStore;
    const section = kind === "material" ? "materials" : kind === "look" ? "looks" : "prefabs";
    const names = kind === "material" ? registry.materialNames() : kind === "look" ? registry.lookNames() : registry.prefabNames();
    if (to === from || !names.includes(from)) return;
    if (!nameIsFree(kind, names, from, to)) return;
    if (sceneStore.editingPrefab) {
        sceneStore.update({ status: "Go back to the scene to rename an asset" });
        return;
    }
    if (blockedByPlay()) return;

    try {
        const key = kind === "material" ? from : `looks/${from}`;
        clearTimeout(pendingWrites.get(key));
        pendingWrites.delete(key);

        if (kind === "material") {
            const data = registry.getMaterialData(from) ?? {};
            await writeAsset(project, section, to, data);
            registry.setMaterial(to, data);
            registry.removeMaterial(from);
        } else if (kind === "look") {
            const data = registry.getLookData(from) ?? {};
            await writeAsset(project, section, to, data);
            registry.setLook(to, data);
            registry.removeLook(from);
        } else {
            const root = registry.getPrefab(from)!;
            await writeAsset(project, section, to, { version: 3, root });
            registry.setPrefab(to, root);
            registry.removePrefab(from);
        }
        // Without a change of case only: there the new file is the old one
        if (to.toLowerCase() !== from.toLowerCase()) await deleteAsset(project, section, from);

        let files = 0;
        if (kind === "look") {
            for (const name of registry.lookNames()) {
                const look = registry.getLookData(name);
                if (look?.extends !== from) continue;
                const next = { ...look, extends: to };
                registry.setLook(name, next);
                await writeAsset(project, "looks", name, next);
                files++;
            }
        }
        for (const name of registry.prefabNames()) {
            const root = structuredClone(registry.getPrefab(name)!);
            if (!renameInEntities(registry, [root], kind, from, to)) continue;
            registry.setPrefab(name, root);
            await writeAsset(project, "prefabs", name, { version: 3, root });
            files++;
        }
        for (const name of await listAssets(project, "scenes")) {
            const scene = (await readAsset(project, "scenes", name)) as SceneData;
            if (!renameInScene(registry, scene, kind, from, to)) continue;
            await writeAsset(project, "scenes", name, scene);
            files++;
        }

        sceneStore.renameReferences((scene) => renameInScene(registry, scene, kind, from, to), section, from, to);
        sceneStore.setRegistry(registry);
        sceneStore.selectAsset({ kind, name: to });
        await saveFolders(
            renameInFolders(sceneStore.folders, section, from, to),
            `Renamed ${section}/${from} to ${to}${files > 0 ? `; ${files} file(s) that use it updated` : ""}`
        );
    } catch (e) {
        report(e);
    }
}

// A new look starts as the pixel-art one: small picture, outlines, few colors
export async function createLook() {
    const { project, registry } = sceneStore;
    try {
        const name = freeName("Look", registry.lookNames());
        const data: LookData = { pixelSize: 3, effects: [{ effect: "outline" }, { effect: "palette" }] };
        await writeAsset(project, "looks", name, data);
        registry.setLook(name, data);
        sceneStore.recordAsset("looks", name, null, data);
        sceneStore.selectAsset({ kind: "look", name });
    } catch (e) {
        report(e);
    }
}

// Like updateMaterial: applies at once, writes the file a moment later
export function updateLook(name: string, data: LookData) {
    const { project, registry } = sceneStore;
    sceneStore.recordAsset("looks", name, registry.getLookData(name) ?? {}, data);
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
        sceneStore.recordAsset("looks", name, registry.getLookData(name) ?? {}, null);
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
        sceneStore.recordAsset("materials", name, registry.getMaterialData(name) ?? {}, null);
        registry.removeMaterial(name);
        sceneStore.selectAsset(null);
        // Meshes that used it fall back to the default material
        sceneStore.setRegistry(registry);
    } catch (e) {
        report(e);
    }
}
