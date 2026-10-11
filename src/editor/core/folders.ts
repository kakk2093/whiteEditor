// Folders of the Project panel. They are a layout only: the files stay where they are (materials/Bricks.json),
// names stay unique in the project, and everything refers to an asset by its name as before. What lies in
// which folder is kept in one file of the project, folders.json:
//   { "materials": { "Walls": ["Bricks", "Stone"] }, "scenes": { "Levels": [] } }

export const FOLDER_SECTIONS = ["scenes", "materials", "prefabs", "looks", "textures", "sounds"] as const;

export type FolderSection = (typeof FOLDER_SECTIONS)[number];

// Folder name -> the names of the assets in it. One level, no folders inside folders.
export type Folders = Partial<Record<FolderSection, Record<string, string[]>>>;

// Reads folders.json leniently: what is not a list of names is left out
export function parseFolders(data: unknown): Folders {
    const folders: Folders = {};
    if (!data || typeof data !== "object") return folders;
    for (const section of FOLDER_SECTIONS) {
        const tree = (data as Record<string, unknown>)[section];
        if (!tree || typeof tree !== "object") continue;
        const parsed: Record<string, string[]> = {};
        for (const [folder, names] of Object.entries(tree)) {
            if (Array.isArray(names)) parsed[folder] = names.filter((name) => typeof name === "string");
        }
        folders[section] = parsed;
    }
    return folders;
}

// Asset name -> its folder. A name written into two folders belongs to the first one.
export function placement(folders: Folders, section: FolderSection) {
    const placed = new Map<string, string>();
    for (const [folder, names] of Object.entries(folders[section] ?? {})) {
        for (const name of names) if (!placed.has(name)) placed.set(name, folder);
    }
    return placed;
}

// Puts the asset into the folder; null takes it out of any
export function moveToFolder(folders: Folders, section: FolderSection, name: string, folder: string | null): Folders {
    const tree: Record<string, string[]> = {};
    for (const [key, names] of Object.entries(folders[section] ?? {})) tree[key] = names.filter((other) => other !== name);
    if (folder !== null) tree[folder] = [...(tree[folder] ?? []), name];
    return { ...folders, [section]: tree };
}

// An asset got another name: it stays in its folder
export function renameInFolders(folders: Folders, section: FolderSection, from: string, to: string): Folders {
    const tree: Record<string, string[]> = {};
    for (const [key, names] of Object.entries(folders[section] ?? {})) tree[key] = names.map((name) => (name === from ? to : name));
    return { ...folders, [section]: tree };
}

// Adds an empty folder, renames one (`from`) or, with `to` = null, removes it: its assets go back to the top
export function changeFolder(folders: Folders, section: FolderSection, from: string | null, to: string | null): Folders {
    const tree: Record<string, string[]> = {};
    for (const [key, names] of Object.entries(folders[section] ?? {})) {
        if (key !== from) tree[key] = names;
        else if (to !== null) tree[to] = names;
    }
    if (from === null && to !== null) tree[to] = tree[to] ?? [];
    return { ...folders, [section]: tree };
}

// Folders can stand inside folders: the name of one is then a path, "Walls/Old". A folder that is only a
// part of such a path ("Walls" when only "Walls/Old" is written) exists too.

// The folder a folder is in; null for one at the top
export const parentFolder = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null);

// The last part of the path: the name of the folder itself
export const folderName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

// Every folder of the section, the ones that are only parts of paths included, sorted
export function folderPaths(folders: Folders, section: FolderSection): string[] {
    const paths = new Set<string>();
    for (const key of Object.keys(folders[section] ?? {})) {
        const parts = key.split("/");
        for (let n = 1; n <= parts.length; n++) paths.add(parts.slice(0, n).join("/"));
    }
    return [...paths].sort();
}

const isInside = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

// Gives the folder another path; the folders inside it move with it
export function renameFolderTree(folders: Folders, section: FolderSection, from: string, to: string): Folders {
    const tree: Record<string, string[]> = {};
    let found = false;
    for (const [key, names] of Object.entries(folders[section] ?? {})) {
        if (isInside(key, from)) {
            tree[to + key.slice(from.length)] = names;
            found = found || key === from;
        } else {
            tree[key] = names;
        }
    }
    // One that was only a part of a path has nothing of its own to carry over
    if (!found) tree[to] = tree[to] ?? [];
    return { ...folders, [section]: tree };
}

// Removes the folder with the folders inside it; their assets go to the folder it was in (or to the top)
export function removeFolderTree(folders: Folders, section: FolderSection, path: string): Folders {
    const tree: Record<string, string[]> = {};
    const freed: string[] = [];
    for (const [key, names] of Object.entries(folders[section] ?? {})) {
        if (isInside(key, path)) freed.push(...names);
        else tree[key] = names;
    }
    const parent = parentFolder(path);
    if (parent !== null) tree[parent] = [...(tree[parent] ?? []), ...freed];
    return { ...folders, [section]: tree };
}
