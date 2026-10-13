import { parsePrefab, parseSettings, parseTerrain, Registry, serializeSettings, SHARED_PROJECT } from "../../engine";
import type { LookData, ProjectSettings } from "../../engine";

// Talks to the dev-server API from vite-plugin-projects.ts
const API = "/__api/projects";

// Folders of a project that hold JSON assets
export type AssetSection = "scenes" | "materials" | "prefabs" | "looks" | "terrains";

async function request(path: string, init?: RequestInit) {
    const res = await fetch(path ? `${API}/${path}` : API, init);
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error ?? res.statusText);
    return body;
}

export function listProjects(): Promise<string[]> {
    return request("");
}

export async function createProject(project: string) {
    await request(project, { method: "POST" });
}

export function listAssets(project: string, section: AssetSection): Promise<string[]> {
    return request(`${project}/${section}`);
}

export function readAsset(project: string, section: AssetSection, name: string): Promise<unknown> {
    return request(`${project}/${section}/${name}`);
}

export async function writeAsset(project: string, section: AssetSection, name: string, data: unknown) {
    await request(`${project}/${section}/${name}`, { method: "PUT", body: JSON.stringify(data) });
}

// Puts an image or an audio file into the project's assets/ folder, under `name` ("bricks.png")
export async function uploadImage(project: string, name: string, file: Blob) {
    await request(`${project}/assets/${encodeURIComponent(name)}`, { method: "PUT", body: file });
}

export async function deleteImage(project: string, name: string) {
    await request(`${project}/assets/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export async function deleteAsset(project: string, section: AssetSection, name: string) {
    await request(`${project}/${section}/${name}`, { method: "DELETE" });
}

// folders.json of the project: the layout of the Project panel (see folders.ts)
export function readFolders(project: string): Promise<unknown> {
    return request(`${project}/folders`);
}

export async function writeFolders(project: string, data: unknown) {
    await request(`${project}/folders`, { method: "PUT", body: JSON.stringify(data) });
}

// Shows a file or a folder of the project in the file manager of the system; `path` is inside the project
// ("materials/Wood.json"), "" is the project folder itself
export async function revealFile(project: string, path: string) {
    await request(`${project}/reveal?path=${encodeURIComponent(path)}`, { method: "POST" });
}

// project.json of the project: its settings (collision layers)
export async function writeSettings(project: string, settings: ProjectSettings) {
    await request(`${project}/settings`, { method: "PUT", body: JSON.stringify(serializeSettings(settings)) });
}

// Builds the game of the project into its build/ folder; `url` is where the dev server shows it
export function buildGame(project: string, scene: string): Promise<{ scene: string; files: string[]; url: string }> {
    return request(`${project}/build?scene=${encodeURIComponent(scene)}`, { method: "POST" });
}

// The address of the assets/ folder of the project: "/projects/demo/assets/". The server tells where its
// projects are (the checks of the editor keep theirs elsewhere).
export async function assetsUrl(project: string): Promise<string> {
    // A server started before it could tell keeps its projects in the usual place
    return `${await request(`${project}/base`).catch(() => `/projects/${project}/`)}assets/`;
}

// Builds the registry of the project: imports every file from scripts/ and reads the material assets
export async function loadRegistry(project: string) {
    const registry = new Registry();
    const errors: string[] = [];
    // What the project "shared" gives every project comes first: the project's own things replace it by name
    const shared = project !== SHARED_PROJECT && (await listProjects()).includes(SHARED_PROJECT);
    const urls: string[] = [...(shared ? await request(`${SHARED_PROJECT}/scripts`) : []), ...(await request(`${project}/scripts`))];
    if (shared) {
        for (const name of await listAssets(SHARED_PROJECT, "looks")) {
            registry.setSharedLook(name, (await readAsset(SHARED_PROJECT, "looks", name)) as LookData);
        }
    }

    const own: string[] = await request(`${project}/scripts`);
    for (const url of urls) {
        // From here on the scripts are the project's own
        if (shared && url === own[0]) registry.markShared();
        try {
            // The timestamp makes the browser fetch the module again after an edit
            const module = await import(/* @vite-ignore */ `${url}?t=${Date.now()}`);
            registry.registerExports(module);
        } catch (e) {
            console.error(e);
            errors.push(`${url.split("/").pop()}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    // A project without scripts of its own: all of them were the shared ones
    if (shared && own.length === 0) registry.markShared();

    const assets = await assetsUrl(project);
    // The time in the address gets an image that was edited past the cache of the browser
    registry.setTextures(assets, await request(`${project}/assets`), `?t=${Date.now()}`);
    registry.setFonts(assets, await request(`${project}/assets?kind=font`), `?t=${Date.now()}`);
    registry.setSounds(assets, await request(`${project}/assets?kind=sound`), `?t=${Date.now()}`);
    // No time in the address: a .gltf names its other files next to itself, and they are asked for without one
    registry.setModelFiles(assets, await request(`${project}/assets?kind=gltf`));
    try {
        registry.setSettings(parseSettings(await request(`${project}/settings`)));
    } catch (e) {
        errors.push(`project.json: ${e instanceof Error ? e.message : String(e)}`);
    }
    registry.setScenes(await listAssets(project, "scenes"));
    for (const name of await listAssets(project, "materials")) {
        registry.setMaterial(name, (await readAsset(project, "materials", name)) as object);
    }
    for (const name of await listAssets(project, "looks")) {
        registry.setLook(name, (await readAsset(project, "looks", name)) as LookData);
    }
    // A project made before there were terrains has no such folder: the server then lists nothing
    for (const name of await listAssets(project, "terrains").catch(() => [] as string[])) {
        try {
            registry.setTerrain(name, parseTerrain(await readAsset(project, "terrains", name)));
        } catch (e) {
            errors.push(`terrains/${name}.json: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    for (const name of await listAssets(project, "prefabs")) {
        try {
            registry.setPrefab(name, parsePrefab(await readAsset(project, "prefabs", name)).root);
        } catch (e) {
            errors.push(`prefabs/${name}.json: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return { registry, errors };
}

// A scene, material or prefab file was changed on disk by something other than the editor
export function onAssetChanged(fn: (project: string, section: AssetSection, name: string) => void) {
    const listener = (data: { project: string; section: AssetSection; name: string }) =>
        fn(data.project, data.section, data.name);
    import.meta.hot?.on("white:asset-changed", listener);
    return () => import.meta.hot?.off("white:asset-changed", listener);
}

// folders.json was changed on disk by something other than the editor
export function onFoldersChanged(fn: (project: string) => void) {
    const listener = (data: { project: string }) => fn(data.project);
    import.meta.hot?.on("white:folders-changed", listener);
    return () => import.meta.hot?.off("white:folders-changed", listener);
}

export function onScriptsChanged(fn: (project: string) => void) {
    const listener = (data: { project: string }) => fn(data.project);
    import.meta.hot?.on("white:scripts-changed", listener);
    return () => import.meta.hot?.off("white:scripts-changed", listener);
}
