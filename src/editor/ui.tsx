import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { NAME_PATTERN } from "./core/actions";

// Small building blocks shared by the panels: icons, a popup menu, a "type a name" dialog.

const ICON_PATHS = {
    cube: "M8 1.5 14 4.5v7L8 14.5 2 11.5v-7z M2 4.5l6 3 6-3 M8 7.5v7",
    light: "M8 5.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z M8 1v2 M8 13v2 M1 8h2 M13 8h2 M3 3l1.4 1.4 M11.6 11.6 13 13 M3 13l1.4-1.4 M11.6 4.4 13 3",
    camera: "M1.5 4.5h9v7h-9z M10.5 7l4-2v6l-4-2",
    empty: "M3 3h10v10H3z",
    material: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2z M5.2 6.2a3.2 3.2 0 0 1 2.4-1.8",
    scene: "M2 3h12v10H2z M2 6h12 M5 3v3",
    script: "M5.5 4 2 8l3.5 4 M10.5 4 14 8l-3.5 4",
    plus: "M8 3v10 M3 8h10",
    trash: "M3 4.5h10 M6 4.5V3h4v1.5 M4.5 4.5l.5 9h6l.5-9",
    close: "M4 4l8 8 M12 4l-8 8",
    chevron: "M6 4l4 4-4 4",
    save: "M3 2.5h8l2 2v9H3z M5.5 2.5v3.5h4.5V2.5 M5 13.5V9.5h6v4",
    move: "M8 1.5v13 M1.5 8h13 M6 3.5l2-2 2 2 M6 12.5l2 2 2-2 M3.5 6l-2 2 2 2 M12.5 6l2 2-2 2",
    rotate: "M13 8a5 5 0 1 1-1.6-3.7 M13 2.2v3.2H9.8",
    scale: "M2.5 13.5h5v-5h-5z M7.5 8.5l6-6 M10 2.5h3.5V6",
    copy: "M5.5 5.5h8v8h-8z M10.5 5.5v-3h-8v8h3",
    back: "M9.5 3.5 5 8l4.5 4.5",
    unlink: "M6.5 9.5 9.5 6.5 M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1 M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1",
    folder: "M1.5 4h5l1.5 1.5h6.5v7.5h-13z",
    play: "M4.5 3v10l8.5-5z",
    stop: "M4 4h8v8H4z",
    pause: "M5.5 3.5v9 M10.5 3.5v9",
    look: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
    image: "M2 3h12v10H2z M2 11l3.5-3.5 2.5 2.5 2-2 4 4 M5.5 7a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
    snap: "M4 2.5v6a4 4 0 0 0 8 0v-6 M4 5.5h2.5 M9.5 5.5H12 M6.5 2.5v6a1.5 1.5 0 0 0 3 0v-6",
    collider: "M3.5 3.5h9v9h-9z M8 1v5 M8 10v5 M1 8h5 M10 8h5",
    undo: "M5.5 3 2.5 6l3 3 M2.5 6h7a4 4 0 0 1 0 8H6",
    redo: "M10.5 3l3 3-3 3 M13.5 6h-7a4 4 0 0 0 0 8H10",
    up: "M4 10l4-4 4 4",
    down: "M4 6l4 4 4-4",
    build: "M2.5 13.5h11 M8 2.5v8 M4.5 7l3.5 3.5L11.5 7",
    step: "M4 3.5v9l6.5-4.5z M12 3.5v9",
} as const;

export type IconName = keyof typeof ICON_PATHS | "prefab";

export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
    // A prefab is the cube, filled
    const filled = name === "prefab";
    return (
        <svg
            className="icon"
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill={filled ? "currentColor" : "none"}
            fillOpacity={filled ? 0.35 : undefined}
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={name === "empty" ? "2 2" : undefined}
        >
            <path d={ICON_PATHS[filled ? "cube" : name]} />
        </svg>
    );
}

export interface MenuSection {
    title?: string;
    items: { key: string; label: string; icon?: IconName }[];
}

// A button that opens a list of actions below (or above) itself
export function Menu({ trigger, sections, onPick, align = "left", up = false }: {
    trigger: (toggle: () => void, open: boolean) => ReactNode;
    sections: MenuSection[];
    onPick: (key: string) => void;
    align?: "left" | "right";
    up?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (!ref.current?.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        window.addEventListener("mousedown", onDown);
        window.addEventListener("keydown", onKey);
        return () => {
            window.removeEventListener("mousedown", onDown);
            window.removeEventListener("keydown", onKey);
        };
    }, [open]);

    return (
        <div className="menu-anchor" ref={ref}>
            {trigger(() => setOpen((o) => !o), open)}
            {open && (
                <div className={`menu ${align === "right" ? "right" : ""} ${up ? "up" : ""}`} role="menu">
                    {sections.filter((s) => s.items.length > 0).map((section, i) => (
                        <div key={section.title ?? i}>
                            {section.title && <div className="menu-title">{section.title}</div>}
                            {section.items.map((item) => (
                                <div
                                    key={item.key}
                                    className="menu-item"
                                    role="menuitem"
                                    onClick={() => {
                                        setOpen(false);
                                        onPick(item.key);
                                    }}
                                >
                                    {item.icon && <Icon name={item.icon} />}
                                    {item.label}
                                </div>
                            ))}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// Asks for a file-safe name (project, scene...)
export function NameDialog({ title, confirm, initial = "", taken = [], onSubmit, onCancel }: {
    title: string;
    confirm: string;
    initial?: string;
    // Names that already exist
    taken?: string[];
    onSubmit: (name: string) => void;
    onCancel: () => void;
}) {
    const [name, setName] = useState(initial);

    const error = !name
        ? ""
        : !NAME_PATTERN.test(name)
            ? "Only Latin letters, digits, _ and -"
            : taken.includes(name)
                ? `"${name}" already exists`
                : "";
    const valid = name !== "" && error === "";

    return (
        <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
            <form
                className="dialog"
                onSubmit={(e) => {
                    e.preventDefault();
                    if (valid) onSubmit(name);
                }}
            >
                <h3>{title}</h3>
                <input
                    className="input"
                    autoFocus
                    value={name}
                    placeholder="name"
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => e.key === "Escape" && onCancel()}
                />
                <div className="error">{error}</div>
                <div className="buttons">
                    <button type="button" className="btn" onClick={onCancel}>Cancel</button>
                    <button type="submit" className="btn primary" disabled={!valid}>{confirm}</button>
                </div>
            </form>
        </div>
    );
}
