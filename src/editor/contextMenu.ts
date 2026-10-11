import { useSyncExternalStore } from "react";
import type { IconName } from "./ui";

// The right-click menu of the editor. Anything can open it; ContextMenuHost draws it.

export interface ContextItem {
    label: string;
    icon?: IconName;
    // Shown at the right, e.g. "Ctrl+D"
    shortcut?: string;
    danger?: boolean;
    // Shown grey and does nothing: what cannot be done right now
    disabled?: boolean;
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
    // Who opened it, if that matters: the menu bar marks its menus to move from one to the next
    owner?: string;
}

let state: State | null = null;
const listeners = new Set<() => void>();

function set(next: State | null) {
    state = next;
    listeners.forEach((fn) => fn());
}

export function openContextMenu(
    e: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void },
    sections: ContextSection[],
    owner?: string
) {
    e.preventDefault();
    e.stopPropagation();
    set({ x: e.clientX, y: e.clientY, sections: sections.filter((s) => s.items.length > 0), owner });
}

// Who opened the menu that is open now; undefined if none is, or if it was not marked
export const contextMenuOwner = () => state?.owner;

// Asks before doing what cannot be undone: a small menu at that place with the question and the one answer.
// Clicking anywhere else is "no".
export function confirmAt(at: { clientX: number; clientY: number }, question: string, label: string, run: () => void) {
    set({ x: at.clientX, y: at.clientY, sections: [{ title: question, items: [{ label, icon: "trash", danger: true, run }] }] });
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
