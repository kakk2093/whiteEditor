import { useRef } from "react";
import { DEFAULT_LAYOUT, LIMITS } from "./layout";
import type { Layout } from "./layout";

// The border of a panel that can be dragged to resize it; a double click puts the default size back.
// `side` is the panel it resizes: the left and the right one by width, the bottom one by height.
export function Splitter({ side, layout, onChange }: { side: keyof Layout; layout: Layout; onChange: (change: (layout: Layout) => Layout) => void }) {
    // Where the drag began and what the size was
    const drag = useRef<{ at: number; size: number } | null>(null);
    const row = side === "bottom";
    // Dragging towards the viewport makes the panel bigger
    const direction = side === "left" ? 1 : -1;
    const [min, max] = LIMITS[side];

    return (
        <div
            className={`splitter ${row ? "row" : ""}`}
            title="Drag to resize · double-click for the default size"
            onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                drag.current = { at: row ? e.clientY : e.clientX, size: layout[side] };
            }}
            onPointerMove={(e) => {
                if (!drag.current) return;
                const moved = ((row ? e.clientY : e.clientX) - drag.current.at) * direction;
                const size = Math.round(Math.min(max, Math.max(min, drag.current.size + moved)));
                onChange((current) => ({ ...current, [side]: size }));
            }}
            onPointerUp={() => {
                drag.current = null;
            }}
            onPointerCancel={() => {
                drag.current = null;
            }}
            onDoubleClick={() => onChange((current) => ({ ...current, [side]: DEFAULT_LAYOUT[side] }))}
        />
    );
}
