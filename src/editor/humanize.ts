// "castShadow" -> "Cast Shadow"
const LABELS: Record<string, string> = { fov: "FOV" };

export function humanize(key: string) {
    return LABELS[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}
