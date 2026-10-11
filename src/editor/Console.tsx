import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { editorLog } from "./core/log";
import { sceneStore } from "./core/SceneStore";
import { Icon } from "./ui";

const two = (n: number) => String(n).padStart(2, "0");

// Where the Console window stands and how big it is; remembered in the browser
interface Frame {
    x: number;
    y: number;
    width: number;
    height: number;
}

const FRAME_KEY = "white:console-window";

function loadFrame(): Frame {
    const frame: Frame = { x: window.innerWidth - 560, y: window.innerHeight - 330, width: 520, height: 260 };
    try {
        const saved = JSON.parse(localStorage.getItem(FRAME_KEY) ?? "{}") as Partial<Frame>;
        for (const key of Object.keys(frame) as (keyof Frame)[]) {
            if (typeof saved[key] === "number") frame[key] = saved[key];
        }
    } catch {
        // The default stands
    }
    // The window may be smaller than last time: the title must stay within reach
    frame.x = Math.min(Math.max(0, frame.x), Math.max(0, window.innerWidth - 120));
    frame.y = Math.min(Math.max(0, frame.y), Math.max(0, window.innerHeight - 60));
    return frame;
}

// In the status bar: opens and closes the Console window, and tells how many errors and warnings wait there
export function ConsoleButton() {
    useSyncExternalStore(editorLog.subscribe, editorLog.getVersion);
    const errors = editorLog.count("error");
    const warnings = editorLog.count("warn");
    return (
        <span
            className={`console-toggle ${sceneStore.consoleOpen ? "open" : ""}`}
            title={sceneStore.consoleOpen ? "Close the Console" : "Open the Console: what the scripts print, errors of behaviors and shaders"}
            onClick={() => sceneStore.setConsoleOpen(!sceneStore.consoleOpen)}
        >
            Console
            {errors > 0 && <b className="console-count error">{errors}</b>}
            {warnings > 0 && <b className="console-count warn">{warnings}</b>}
        </span>
    );
}

// The Console: a small window of its own over the editor. It is moved by its title and resized by its
// corner; the editor under it goes on working. See core/log.ts for what gets here.
export default function Console() {
    useSyncExternalStore(editorLog.subscribe, editorLog.getVersion);
    const { entries } = editorLog;
    const [frame, setFrame] = useState(loadFrame);
    const box = useRef<HTMLDivElement>(null);
    const list = useRef<HTMLDivElement>(null);
    // Follows the newest line, unless the list was scrolled up to read something
    const follow = useRef(true);
    // A drag of the title: where the mouse took it
    const drag = useRef<{ dx: number; dy: number } | null>(null);

    useEffect(() => {
        if (follow.current && list.current) list.current.scrollTop = list.current.scrollHeight;
    });

    useEffect(() => {
        localStorage.setItem(FRAME_KEY, JSON.stringify(frame));
    }, [frame]);

    // The corner is the browser's own (CSS resize): the new size is read once the mouse lets go
    const keepSize = () => {
        const el = box.current;
        if (el && (el.offsetWidth !== frame.width || el.offsetHeight !== frame.height)) {
            setFrame({ ...frame, width: el.offsetWidth, height: el.offsetHeight });
        }
    };

    const errors = editorLog.count("error");
    const warnings = editorLog.count("warn");

    return (
        <div
            className="console-window"
            ref={box}
            style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
            onPointerUp={keepSize}
        >
            <div
                className="panel-header"
                title="Drag to move the window"
                onPointerDown={(e) => {
                    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    drag.current = { dx: e.clientX - frame.x, dy: e.clientY - frame.y };
                }}
                onPointerMove={(e) => {
                    if (!drag.current) return;
                    setFrame({
                        ...frame,
                        x: Math.min(Math.max(0, e.clientX - drag.current.dx), window.innerWidth - 120),
                        y: Math.min(Math.max(0, e.clientY - drag.current.dy), window.innerHeight - 60)
                    });
                }}
                onPointerUp={() => {
                    drag.current = null;
                }}
                onPointerCancel={() => {
                    drag.current = null;
                }}
            >
                Console
                <span className={`console-count ${errors > 0 ? "error" : ""}`}>{errors} errors</span>
                <span className={`console-count ${warnings > 0 ? "warn" : ""}`}>{warnings} warnings</span>
                <span className="spacer" />
                <button className="btn ghost" title="Remove every line; Play clears the Console too" onClick={() => editorLog.clear()}>
                    <Icon name="trash" size={12} />
                </button>
                <button className="btn ghost" title="Close; the word Console in the status bar opens it again" onClick={() => sceneStore.setConsoleOpen(false)}>
                    <Icon name="close" size={12} />
                </button>
            </div>
            <div
                className="panel-body console"
                ref={list}
                onScroll={(e) => {
                    const el = e.currentTarget;
                    follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
                }}
            >
                {entries.map((entry) => (
                    <div key={entry.id} className={`console-line ${entry.level}`}>
                        <span className="time">{two(entry.time.getHours())}:{two(entry.time.getMinutes())}:{two(entry.time.getSeconds())}</span>
                        <pre>{entry.text}</pre>
                        {entry.count > 1 && <span className="times" title="The same message, this many times in a row">{entry.count}</span>}
                    </div>
                ))}
                {entries.length === 0 && (
                    <div className="empty">
                        Nothing yet. What the scripts print with <b>console.log</b>, and the errors of behaviors and shaders, show here.
                    </div>
                )}
            </div>
        </div>
    );
}
