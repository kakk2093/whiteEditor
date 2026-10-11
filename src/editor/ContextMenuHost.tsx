import { useEffect, useLayoutEffect, useRef } from "react";
import { closeContextMenu, useContextMenu } from "./contextMenu";
import { Icon } from "./ui";

// Draws the open context menu at the cursor; one instance lives in App
export default function ContextMenuHost() {
    const menu = useContextMenu();
    const ref = useRef<HTMLDivElement>(null);

    // Keep the menu inside the window
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el || !menu) return;
        const { width, height } = el.getBoundingClientRect();
        el.style.left = `${Math.max(4, Math.min(menu.x, window.innerWidth - width - 4))}px`;
        el.style.top = `${Math.max(4, Math.min(menu.y, window.innerHeight - height - 4))}px`;
    }, [menu]);

    useEffect(() => {
        if (!menu) return;
        const onDown = (e: MouseEvent) => {
            if (!ref.current?.contains(e.target as Node)) closeContextMenu();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") closeContextMenu();
        };
        window.addEventListener("mousedown", onDown, true);
        window.addEventListener("keydown", onKey);
        window.addEventListener("blur", closeContextMenu);
        return () => {
            window.removeEventListener("mousedown", onDown, true);
            window.removeEventListener("keydown", onKey);
            window.removeEventListener("blur", closeContextMenu);
        };
    }, [menu]);

    if (!menu) return null;

    return (
        <div ref={ref} className="menu context" role="menu" style={{ left: menu.x, top: menu.y }}>
            {menu.sections.map((section, i) => (
                <div key={i}>
                    {i > 0 && !section.title && <div className="menu-sep" />}
                    {section.title && <div className="menu-title">{section.title}</div>}
                    {section.items.map((item) => (
                        <div
                            key={item.label}
                            className={`menu-item ${item.danger ? "danger" : ""} ${item.disabled ? "disabled" : ""}`}
                            role="menuitem"
                            aria-disabled={item.disabled}
                            onClick={() => {
                                if (item.disabled) return;
                                closeContextMenu();
                                item.run();
                            }}
                        >
                            {item.icon ? <Icon name={item.icon} /> : <span style={{ width: 14 }} />}
                            {item.label}
                            {item.shortcut && <span className="shortcut">{item.shortcut}</span>}
                        </div>
                    ))}
                </div>
            ))}
        </div>
    );
}
