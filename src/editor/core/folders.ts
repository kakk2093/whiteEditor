// Folders of the Project panel. They are a layout only: the files stay where they are (materials/Bricks.json),
// names stay unique in the project, and everything refers to an asset by its name as before. What lies in
// which folder is kept in one file of the project, folders.json:
//   { "materials": { "Walls": ["Bricks", "Stone"] }, "scenes": { "Levels": [] } }

export const FOLDER_SECTIONS = ["scenes", "materials", "prefabs", "looks", "textures"] as const;

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
