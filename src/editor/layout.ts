import { useEffect, useState } from "react";

// The sizes of the panels around the viewport, pixels; dragged by the borders between them
export interface Layout {
    // Width of the Hierarchy
    left: number;
    // Width of the Inspector
    right: number;
    // Height of the Project panel
    bottom: number;
}

export const DEFAULT_LAYOUT: Layout = { left: 250, right: 290, bottom: 190 };

export const LIMITS: Record<keyof Layout, [number, number]> = { left: [150, 700], right: [200, 800], bottom: [80, 700] };

const LAYOUT_KEY = "white:layout";

function loadLayout(): Layout {
    try {
        const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") as Partial<Layout>;
        const layout = { ...DEFAULT_LAYOUT };
        for (const key of Object.keys(layout) as (keyof Layout)[]) {
            if (typeof saved[key] === "number") layout[key] = saved[key];
        }
        return layout;
    } catch {
        return { ...DEFAULT_LAYOUT };
    }
}

// The layout of the editor window, remembered between runs (in the browser, not in the project)
export function useLayout() {
    const [layout, setLayout] = useState(loadLayout);
    useEffect(() => {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    }, [layout]);
    return [layout, setLayout] as const;
}
