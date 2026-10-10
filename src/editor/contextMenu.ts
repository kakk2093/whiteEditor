import { useSyncExternalStore } from "react";
import type { IconName } from "./ui";

// The right-click menu of the editor. Anything can open it; ContextMenuHost draws it.

export interface ContextItem {
    label: string;
    icon?: IconName;
    // Shown at the right, e.g. "Ctrl+D"
    shortcut?: string;
    danger?: boolean;
    run: () => void;
}

export interface ContextSection {
    title?: string;
    items: ContextItem[];
}

interface State {
    x: number;
    y: number;
    sections: ContextSection[];
}

let state: State | null = null;
const listeners = new Set<() => void>();

function set(next: State | null) {
    state = next;
    listeners.forEach((fn) => fn());
}

export function openContextMenu(
    e: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void },
    sections: ContextSection[]
) {
    e.preventDefault();
    e.stopPropagation();
    set({ x: e.clientX, y: e.clientY, sections: sections.filter((s) => s.items.length > 0) });
}

export function closeContextMenu() {
    if (state) set(null);
}

export function useContextMenu() {
    return useSyncExternalStore(
        (fn) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        () => state
    );
}
