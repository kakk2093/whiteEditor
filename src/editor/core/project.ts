import { isModelDef, parsePrefab, Registry } from "../../engine";

// Talks to the dev-server API from vite-plugin-projects.ts
const API = "/__api/projects";

// Folders of a project that hold JSON assets
export type AssetSection = "scenes" | "materials" | "prefabs";

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

export async function deleteAsset(project: string, section: AssetSection, name: string) {
    await request(`${project}/${section}/${name}`, { method: "DELETE" });
}

// Builds the registry of the project: imports every file from scripts/ and reads the material assets
export async function loadRegistry(project: string) {
    const registry = new Registry();
    const errors: string[] = [];
    const urls: string[] = await request(`${project}/scripts`);

    for (const url of urls) {
        try {
            // The timestamp makes the browser fetch the module again after an edit
            const module = await import(/* @vite-ignore */ `${url}?t=${Date.now()}`);
            for (const value of Object.values(module)) {
                if (isModelDef(value)) registry.registerModel(value);
            }
        } catch (e) {
            console.error(e);
            errors.push(`${url.split("/").pop()}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    for (const name of await listAssets(project, "materials")) {
        registry.setMaterial(name, (await readAsset(project, "materials", name)) as object);
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

export function onScriptsChanged(fn: (project: string) => void) {
    const listener = (data: { project: string }) => fn(data.project);
    import.meta.hot?.on("white:scripts-changed", listener);
    return () => import.meta.hot?.off("white:scripts-changed", listener);
}
