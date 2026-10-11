// The Console of the editor: what the scripts of the project print (console.log / warn / error), the errors
// of behaviors and shaders, and whatever else goes to the console of the browser, where few would look.

export type LogLevel = "log" | "warn" | "error";

export interface LogEntry {
    id: number;
    level: LogLevel;
    text: string;
    // The same message came this many times in a row
    count: number;
    time: Date;
}

// The oldest entries go once there are more
const LIMIT = 500;

// A message longer than this is cut: a failed shader prints its whole source
const MAX_LENGTH = 4000;

function describe(value: unknown): string {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack && !value.stack.includes(value.message) ? `${value.message}\n${value.stack}` : value.stack ?? value.message;
    if (typeof value === "object" && value !== null) {
        // three.js vectors and the like read better as their numbers than as "[object Object]"
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
}

class EditorLog {
    entries: LogEntry[] = [];

    private nextId = 1;

    private version = 0;

    private listeners = new Set<() => void>();

    subscribe = (fn: () => void) => {
        this.listeners.add(fn);
        return () => {
            this.listeners.delete(fn);
        };
    };

    getVersion = () => this.version;

    private changed() {
        this.version++;
        this.listeners.forEach((fn) => fn());
    }

    add(level: LogLevel, parts: unknown[]) {
        let text = parts.map(describe).join(" ");
        if (text.length > MAX_LENGTH) text = `${text.slice(0, MAX_LENGTH)}\n… (${text.length - MAX_LENGTH} more characters, see the browser console)`;
        const last = this.entries[this.entries.length - 1];
        if (last && last.level === level && last.text === text) {
            // A new object, so that the list sees the change
            this.entries = [...this.entries.slice(0, -1), { ...last, count: last.count + 1, time: new Date() }];
        } else {
            this.entries = [...this.entries.slice(-(LIMIT - 1)), { id: this.nextId++, level, text, count: 1, time: new Date() }];
        }
        this.changed();
    }

    clear() {
        if (this.entries.length === 0) return;
        this.entries = [];
        this.changed();
    }

    count(level: LogLevel) {
        return this.entries.reduce((sum, entry) => sum + (entry.level === level ? entry.count : 0), 0);
    }
}

export const editorLog = new EditorLog();

let captured = false;

// From now on everything printed to the console of the browser is in the Console of the editor too.
// The dev server's own chatter ("[vite] hot updated") is left out.
export function captureConsole() {
    if (captured) return;
    captured = true;

    const levels: Record<string, LogLevel> = { log: "log", info: "log", warn: "warn", error: "error" };
    for (const [method, level] of Object.entries(levels)) {
        const original = console[method as "log"].bind(console);
        console[method as "log"] = (...parts: unknown[]) => {
            original(...parts);
            if (typeof parts[0] === "string" && parts[0].startsWith("[vite]")) return;
            // The Console is drawn by React: adding to it while React is drawing something else must wait
            queueMicrotask(() => editorLog.add(level, parts));
        };
    }
    window.addEventListener("error", (e) => editorLog.add("error", [e.error ?? e.message]));
    window.addEventListener("unhandledrejection", (e) => editorLog.add("error", ["Unhandled promise rejection:", e.reason]));
}
