import { useEffect, useRef, useSyncExternalStore } from "react";
import { editorLog } from "./core/log";
import { sceneStore } from "./core/SceneStore";
import { Icon } from "./ui";

const two = (n: number) => String(n).padStart(2, "0");

// The Console panel, next to the Project one: see core/log.ts for what gets here
export default function Console() {
    useSyncExternalStore(editorLog.subscribe, editorLog.getVersion);
    const { entries } = editorLog;
    const list = useRef<HTMLDivElement>(null);
    // Follows the newest line, unless the list was scrolled up to read something
    const follow = useRef(true);

    useEffect(() => {
        if (follow.current && list.current) list.current.scrollTop = list.current.scrollHeight;
    });

    const errors = editorLog.count("error");
    const warnings = editorLog.count("warn");

    return (
        <div className="panel console-panel">
            <div className="panel-header">
                Console
                <span className={`console-count ${errors > 0 ? "error" : ""}`}>{errors} errors</span>
                <span className={`console-count ${warnings > 0 ? "warn" : ""}`}>{warnings} warnings</span>
                <span className="spacer" />
                <button className="btn ghost" title="Remove every line; Play clears the Console too" onClick={() => editorLog.clear()}>
                    <Icon name="trash" size={12} />
                </button>
                <button className="btn ghost" title="Hide the Console; Window → Show Console brings it back" onClick={() => sceneStore.setConsoleOpen(false)}>
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
