import { useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import {
    ASPECTS, builtinEffects, builtinSurfaces, componentDefs, componentKey, DEFAULT_LAYER, environmentFields, fieldApplies, layersCollide, lookFields, materialFields,
    MAX_COLORS, paramDefaults, resolveLook, setLayersCollide
} from "../engine";
import type {
    ComponentData, EntityData, EnvironmentData, LookData, MaterialData, ParamDef, ParamValue, Params
} from "../engine";
import {
    addToLook, applyOverrides, createPrefab, deleteLook, deleteMaterial, deletePrefab, deleteScene, deleteTexture, openPrefab, openScene, renameAsset, renameLayer, renameScene, updateLook, updateMaterial, updateSettings
} from "./core/actions";
import { instantiateModel, instantiatePrefab } from "./core/dnd";
import { confirmAt, openContextMenu } from "./contextMenu";
import { getComponent, sceneStore } from "./core/SceneStore";
import type { AssetRef, TransformProperty } from "./core/SceneStore";
import { useSceneStore } from "./core/useSceneStore";
import { entityIcon } from "./entityIcon";
import { humanize } from "./humanize";
import { Icon, Menu } from "./ui";
import type { MenuSection } from "./ui";

const TRANSFORMS: { property: TransformProperty; title: string }[] = [
    { property: "position", title: "Position" },
    { property: "rotation", title: "Rotation" },
    { property: "scale", title: "Scale" }
];

const AXES = ["x", "y", "z"] as const;

// Shown in a field whose value is not the same in all the selected objects
const MIXED_MARK = "—";
// The value of the entry of a list that stands for it
const MIXED_OPTION = "(mixed)";

// How far the mouse travels for one step of a value that is being dragged, pixels
const SCRUB_PIXELS = 4;

// A number can be typed, stepped with the two small arrows that show on hover, or dragged: press on the
// field and move the mouse left or right (Shift: ten times faster, Alt: ten times finer). A click without
// moving starts typing. While the field is focused it keeps exactly what is being typed.
// `mixed`: several objects are edited and their values differ; the field shows a dash until one is given.
function NumberInput({ value, step = 0.1, min, max, mixed = false, onChange }: {
    value: number;
    mixed?: boolean;
    step?: number;
    min?: number;
    max?: number;
    onChange: (value: number) => void;
}) {
    const [text, setText] = useState<string | null>(null);
    // A press that may turn into a drag: where it began and what the value was
    const drag = useRef<{ x: number; start: number; moved: boolean } | null>(null);

    const set = (next: number) => {
        let v = next;
        if (min !== undefined) v = Math.max(min, v);
        if (max !== undefined) v = Math.min(max, v);
        // Steps of 0.1 must not leave 0.30000000000000004 in the files
        v = Math.round(v * 1e6) / 1e6;
        if (text !== null) setText(String(v));
        onChange(v);
    };

    return (
        <div className="number">
            <input
                className="input"
                type="number"
                step={step}
                min={min}
                max={max}
                title="Drag left or right to change (Shift faster, Alt finer) · click to type"
                placeholder={mixed ? MIXED_MARK : undefined}
                value={text ?? (mixed ? "" : String(Math.round(value * 1000) / 1000))}
                onFocus={(e) => setText(e.target.value)}
                onBlur={() => setText(null)}
                onChange={(e) => {
                    setText(e.target.value);
                    const parsed = Number(e.target.value);
                    if (e.target.value !== "" && !Number.isNaN(parsed)) onChange(parsed);
                }}
                onPointerDown={(e) => {
                    // A field that is being typed in keeps the mouse for its text
                    if (e.button !== 0 || document.activeElement === e.currentTarget) return;
                    e.preventDefault();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    drag.current = { x: e.clientX, start: value, moved: false };
                }}
                onPointerMove={(e) => {
                    const d = drag.current;
                    if (!d) return;
                    const dx = e.clientX - d.x;
                    if (!d.moved && Math.abs(dx) < SCRUB_PIXELS) return;
                    d.moved = true;
                    const speed = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
                    set(d.start + Math.round(dx / SCRUB_PIXELS) * step * speed);
                }}
                onPointerUp={(e) => {
                    const d = drag.current;
                    drag.current = null;
                    if (!d) return;
                    e.currentTarget.releasePointerCapture(e.pointerId);
                    // It was a click after all
                    if (!d.moved) {
                        e.currentTarget.focus();
                        e.currentTarget.select();
                    }
                }}
                onPointerCancel={() => {
                    drag.current = null;
                }}
            />
            <span className="number-steps">
                {/* preventDefault keeps the focus where it is: a field being typed in stays so */}
                <button tabIndex={-1} title="More" onPointerDown={(e) => e.preventDefault()} onClick={() => set(value + step)}>▲</button>
                <button tabIndex={-1} title="Less" onPointerDown={(e) => e.preventDefault()} onClick={() => set(value - step)}>▼</button>
            </span>
        </div>
    );
}

function ParamField({ def, value, mixed = false, onChange }: {
    def: ParamDef;
    value: ParamValue;
    // The selected objects have different values here; `value` is the one of the main object
    mixed?: boolean;
    onChange: (value: ParamValue) => void;
}) {
    const mixedOption = mixed && <option value={MIXED_OPTION} disabled hidden>{MIXED_MARK}</option>;
    switch (def.type) {
        case "number":
            return <NumberInput value={value as number} step={def.step} min={def.min} max={def.max} mixed={mixed} onChange={onChange} />;
        case "color":
            return (
                <>
                    <input className="color-swatch" type="color" value={value as string} onChange={(e) => onChange(e.target.value)} />
                    <input
                        className="input"
                        key={mixed ? MIXED_OPTION : value as string}
                        defaultValue={mixed ? "" : value as string}
                        placeholder={mixed ? MIXED_MARK : undefined}
                        onChange={(e) => /^#[0-9a-f]{6}$/i.test(e.target.value) && onChange(e.target.value)}
                    />
                </>
            );
        case "colors": {
            const colors = value as string[];
            return (
                <div className="colors">
                    {colors.map((color, i) => (
                        <input
                            key={i}
                            className="color-swatch"
                            type="color"
                            value={color}
                            title={`${color} — right-click to remove`}
                            onChange={(e) => onChange(colors.map((c, n) => (n === i ? e.target.value : c)))}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                onChange(colors.filter((_, n) => n !== i));
                            }}
                        />
                    ))}
                    {colors.length < MAX_COLORS && (
                        <button className="btn ghost" title="Add a color" onClick={() => onChange([...colors, colors[colors.length - 1] ?? "#ffffff"])}>
                            <Icon name="plus" size={12} />
                        </button>
                    )}
                    {/* A whole palette at once: any text with hex colors in it, e.g. copied from a palette site */}
                    <input
                        className="input"
                        key={colors.join()}
                        defaultValue={colors.join(" ")}
                        placeholder="paste hex colors"
                        title="The list as text: paste hex colors separated by anything"
                        onChange={(e) => {
                            const found = e.target.value.match(/[0-9a-f]{6}/gi) ?? [];
                            const rest = e.target.value.replace(/[0-9a-f]{6}/gi, "");
                            // Only once nothing half-typed is left
                            if (!/[0-9a-f]/i.test(rest)) onChange(found.slice(0, MAX_COLORS).map((c) => `#${c.toLowerCase()}`));
                        }}
                    />
                </div>
            );
        }
        case "boolean":
            return (
                <input
                    className="checkbox"
                    type="checkbox"
                    ref={(el) => {
                        if (el) el.indeterminate = mixed;
                    }}
                    checked={value as boolean}
                    onChange={(e) => onChange(e.target.checked)}
                />
            );
        case "select":
            return (
                <select className="select" value={mixed ? MIXED_OPTION : value as string} onChange={(e) => onChange(e.target.value)}>
                    {mixedOption}
                    {def.options.map((option) => (
                        <option key={option} value={option}>{humanize(option)}</option>
                    ))}
                </select>
            );
        case "asset":
            return (
                <select className="select" value={mixed ? MIXED_OPTION : value as string} onChange={(e) => onChange(e.target.value)}>
                    {mixedOption}
                    <option value="">{def.kind === "material" ? "Default (gray)" : def.kind === "layer" ? DEFAULT_LAYER : "(none)"}</option>
                    {sceneStore.registry.assetNames(def.kind).map((name) => (
                        <option key={name} value={name}>{name}</option>
                    ))}
                </select>
            );
        case "string":
            return (
                <input
                    className="input"
                    value={mixed ? "" : value as string}
                    placeholder={mixed ? MIXED_MARK : undefined}
                    onChange={(e) => onChange(e.target.value)}
                />
            );
    }
}

// One row per field, values missing in `values` show the default
// Shown on what a prefab instance has changed for itself
const CHANGED_TITLE = "Changed in this instance: the prefab has another value. Right-click to revert";

// The right-click menu of a field a prefab instance has changed
function revertMenu(e: MouseEvent, run: () => void) {
    openContextMenu(e, [{ items: [{ label: "Revert to Prefab", icon: "back", run }] }]);
}

// The fields whose value is not the same in all of `list` (what several selected objects have in one place)
function mixedKeys(defs: Record<string, ParamDef>, list: Params[]) {
    const defaults = paramDefaults(defs);
    const text = (values: Params, key: string) => JSON.stringify(values[key] ?? defaults[key]);
    return new Set(Object.keys(defs).filter((key) => list.some((values) => text(values, key) !== text(list[0], key))));
}

const MIXED_TITLE = "the selected objects have different values; a value given here goes to all of them";

export function Fields({ defs, values, onChange, changed, onRevert, mixed }: {
    defs: Record<string, ParamDef>;
    values: Params;
    onChange: (key: string, value: ParamValue) => void;
    // The fields a prefab instance overrides; they are marked
    changed?: Record<string, unknown>;
    // Puts such a field back to what the prefab gives
    onRevert?: (key: string) => void;
    // The fields that differ between the selected objects; `values` are those of the main one
    mixed?: Set<string>;
}) {
    const defaults = paramDefaults(defs);
    return (
        <>
            {Object.entries(defs).filter(([, def]) => fieldApplies(def, defs, values)).map(([key, def]) => (
                <div key={key} className="field">
                    <label
                        className={changed && key in changed ? "overridden" : undefined}
                        title={changed && key in changed ? `${key} — ${CHANGED_TITLE}` : mixed?.has(key) ? `${key} — ${MIXED_TITLE}` : key}
                        onContextMenu={changed && key in changed && onRevert ? (e) => revertMenu(e, () => onRevert(key)) : undefined}
                    >
                        {humanize(key)}
                    </label>
                    <div className="control">
                        <ParamField def={def} value={values[key] ?? defaults[key]} mixed={mixed?.has(key)} onChange={(value) => onChange(key, value)} />
                    </div>
                </div>
            ))}
        </>
    );
}

export function Section({ title, onRemove, removeTitle = "Remove component", extra, children }: {
    title: ReactNode;
    onRemove?: () => void;
    removeTitle?: string;
    // More buttons of the header, before the remove one
    extra?: ReactNode;
    children: ReactNode;
}) {
    return (
        <div className="section">
            <div className="section-header">
                {title}
                <span className="spacer" />
                {extra}
                {onRemove && (
                    <button className="btn ghost" title={removeTitle} onClick={onRemove}>
                        <Icon name="close" size={12} />
                    </button>
                )}
            </div>
            <div className="section-body">{children}</div>
        </div>
    );
}

// With several entities the fields show the values of the last one (the main one of the selection) and a
// dash where the others differ; a value given here goes to all of them
function TransformSection({ entities }: { entities: EntityData[] }) {
    const entity = entities[entities.length - 1];
    const override = entities.length === 1 ? sceneStore.overrideOf(entity.id) : null;
    return (
        <Section title="Transform">
            {TRANSFORMS.map(({ property, title }) => (
                <div key={property} className="field">
                    <label
                        className={override?.[property] ? "overridden" : undefined}
                        title={override?.[property] ? CHANGED_TITLE : undefined}
                        onContextMenu={override?.[property]
                            ? (e) => revertMenu(e, () => sceneStore.revertOverrideField(entity.id, [property]))
                            : undefined}
                    >
                        {title}
                    </label>
                    <div className="control">
                        {AXES.map((axis, i) => (
                            <div key={axis} className={`axis ${axis}`}>
                                <span>{axis.toUpperCase()}</span>
                                <NumberInput
                                    value={entity[property][i]}
                                    mixed={entities.some((other) => other[property][i] !== entity[property][i])}
                                    step={property === "rotation" ? 5 : 0.1}
                                    onChange={(value) => sceneStore.batch(() => {
                                        for (const each of entities) sceneStore.setTransform(each.id, property, i as 0 | 1 | 2, value);
                                    })}
                                />
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </Section>
    );
}

// With several entities `components` has the component of each, in the same order; the fields show the
// last one, and what is changed goes to all.
function ComponentSection({ entities, components }: { entities: EntityData[]; components: ComponentData[] }) {
    const store = useSceneStore();
    const entity = entities[entities.length - 1];
    const component = components[components.length - 1];
    const single = entities.length === 1;
    const def = componentDefs[component.type];
    const key = componentKey(component);
    const each = (run: (id: string) => void) => store.batch(() => entities.forEach((other) => run(other.id)));

    // A model or a behavior from the project scripts, with its own params
    const source = def?.source;
    const nameOf = (c: ComponentData) => (source ? (c[source.key] as string | undefined) ?? "" : "");
    const sourceName = nameOf(component);
    const sourceMixed = components.some((other) => nameOf(other) !== sourceName);
    const sourceDef = sourceMixed ? undefined : source?.get(store.registry, sourceName);

    // A name that is saved in the scene but missing from the scripts stays selectable
    const names = source?.list(store.registry).map((d) => d.name) ?? [];
    if (sourceName && !names.includes(sourceName)) names.push(sourceName);

    // Components an entity has several of are told apart by what they run: "Spin (Script)"
    const title = def?.multiple ? `${sourceDef?.label ?? sourceName} (${def.label})` : def?.label ?? component.type;

    // What a prefab instance changes in this component
    const override = single ? store.overrideOf(entity.id)?.components?.[key] : undefined;
    // A component the instance has and its prefab does not
    const added = single && store.overrideOf(entity.id)?.addComponents?.some((other) => componentKey(other) === key);

    return (
        <Section
            title={added ? <span className="overridden" title="Added in this instance: the prefab does not have this component">{title}</span> : title}
            onRemove={() => each((id) => store.removeComponent(id, key))}
            removeTitle={single ? undefined : "Remove the component from all the selected objects"}
            extra={single && component.type === "collider" && !store.playing && (
                <button
                    className={`btn ghost ${store.colliderEdit ? "active" : ""}`}
                    title="Edit in the viewport: drag the dots on the sides of the collider to resize it, the square to move it"
                    onClick={() => store.setColliderEdit(!store.colliderEdit)}
                >
                    <Icon name="collider" size={12} />
                </button>
            )}
        >
            {def && (
                <Fields
                    defs={def.fields}
                    values={component as Params}
                    onChange={(field, value) => each((id) => store.setComponentField(id, key, field, value))}
                    changed={override}
                    onRevert={(field) => store.revertOverrideField(entity.id, ["components", key, field])}
                    mixed={single ? undefined : mixedKeys(def.fields, components as Params[])}
                />
            )}

            {source && !def.multiple && (
                <div className="field">
                    <label
                        className={override && source.key in override ? "overridden" : undefined}
                        title={override && source.key in override ? CHANGED_TITLE : sourceMixed ? MIXED_TITLE : undefined}
                        onContextMenu={override && source.key in override
                            ? (e) => revertMenu(e, () => store.revertOverrideField(entity.id, ["components", key]))
                            : undefined}
                    >
                        {humanize(source.key)}
                    </label>
                    <div className="control">
                        <select
                            className="select"
                            value={sourceMixed ? MIXED_OPTION : sourceName}
                            onChange={(e) => each((id) => store.setComponentField(id, key, source.key, e.target.value))}
                        >
                            {sourceMixed && <option value={MIXED_OPTION} disabled hidden>{MIXED_MARK}</option>}
                            <option value="">(none)</option>
                            {names.map((name) => (
                                <option key={name} value={name}>{name}</option>
                            ))}
                        </select>
                    </div>
                </div>
            )}
            {sourceDef && (
                <Fields
                    defs={sourceDef.params ?? {}}
                    values={(component.params as Params | undefined) ?? {}}
                    onChange={(param, value) => each((id) => store.setComponentParam(id, key, param, value))}
                    changed={override?.params as Params | undefined}
                    onRevert={(param) => store.revertOverrideField(entity.id, ["components", key, "params", param])}
                    mixed={single ? undefined : mixedKeys(sourceDef.params ?? {}, components.map((c) => (c.params as Params | undefined) ?? {}))}
                />
            )}
            {source && sourceName && !sourceDef && !sourceMixed && (
                <div className="note">
                    The {source.what} <b>{sourceName}</b> is not defined in the project's scripts/ folder.
                </div>
            )}
        </Section>
    );
}

// Several objects: what can be done to all of them at once, and the fields they all have. The components
// are those every one of them has; the values shown are of the main object (the last one selected).
function MultiInspector({ entities }: { entities: EntityData[] }) {
    const store = useSceneStore();
    const main = entities[entities.length - 1];
    // The components of an instance are those of the root of its prefab
    const lists = entities.map((entity) => (entity.prefab ? store.expand(entity)?.components : entity.components) ?? []);
    const shared = (lists[lists.length - 1] ?? [])
        .map((component) => lists.map((list) => list.find((other) => componentKey(other) === componentKey(component))))
        .filter((found): found is ComponentData[] => found.every((component) => component !== undefined));
    if (!main) return null;
    const active = main.active ?? true;

    return (
        <>
            <div className="inspector-head">
                <input
                    className="checkbox"
                    type="checkbox"
                    title="Active: an inactive object is hidden together with its children"
                    ref={(el) => {
                        if (el) el.indeterminate = entities.some((entity) => (entity.active ?? true) !== active);
                    }}
                    checked={active}
                    onChange={(e) => store.batch(() => entities.forEach((entity) => store.setActive(entity.id, e.target.checked)))}
                />
                <Icon name="cube" /> <b style={{ flex: 1 }}>{entities.length} objects selected</b>
            </div>
            <div className="note">
                <button className="btn" title="Copies next to the originals (Ctrl+D)" onClick={() => store.duplicateSelected()}>
                    <Icon name="copy" /> Duplicate
                </button>
                <button className="btn" title="Put them under a new empty object (Ctrl+G)" onClick={() => store.groupSelected()}>
                    <Icon name="folder" /> Group
                </button>
                <button className="btn danger" title="Delete (Del)" onClick={() => store.removeSelected()}>
                    <Icon name="trash" /> Delete
                </button>
            </div>
            <div className="note">{entities.map((entity) => entity.name).join(", ")}</div>

            <TransformSection entities={entities} />

            {shared.map((components) => (
                <ComponentSection key={componentKey(components[0])} entities={entities} components={components} />
            ))}

            <div className="empty">
                A value given here goes to all the selected objects; {MIXED_MARK} stands where they differ.
                Only the components all of them have are shown. The gizmo holds the last one picked.
            </div>
        </>
    );
}

function EntityInspector({ entity }: { entity: EntityData }) {
    const store = useSceneStore();
    const isPrefabRoot = store.editingPrefab !== null && store.entities[0] === entity;
    // Something inside a prefab instance: what is changed here is kept by the instance as an override
    const inner = store.isInner(entity.id);
    const instance = store.instanceOf(entity.id);
    const fromPrefab = inner || entity.prefab !== undefined;
    // One of the entities an instance adds to its prefab
    const addedIn = store.addedIn(entity.id);
    // The components of the prefab this instance has removed
    const removedComponents = (fromPrefab && store.overrideOf(entity.id)?.removeComponents) || [];
    // The components of an instance are those of the root of its prefab
    const components = (entity.prefab ? store.expand(entity)?.components : entity.components) ?? [];

    // Add Component: the types the entity does not have yet, then, for the types it can have several of
    // (scripts), what is not attached yet
    const types = Object.keys(componentDefs);
    const addSections: MenuSection[] = [
        {
            items: types
                .filter((type) => !componentDefs[type].multiple && !components.some((c) => c.type === type))
                .map((type) => ({ key: type, label: componentDefs[type].label }))
        },
        ...types.filter((type) => componentDefs[type].multiple).map((type) => ({
            title: `${componentDefs[type].label}s`,
            items: (componentDefs[type].source?.list(store.registry) ?? [])
                .filter((d) => !components.some((c) => componentKey(c) === `${type}:${d.name}`))
                .map((d) => ({ key: `${type}:${d.name}`, label: d.label ?? d.name, icon: "script" as const }))
        }))
    ];

    const duplicate = () => {
        const copy = store.duplicate(entity.id);
        if (copy) store.select(copy.id);
    };

    return (
        <>
            <div className="inspector-head">
                <input
                    className={`checkbox ${store.overrideOf(entity.id)?.active !== undefined ? "overridden" : ""}`}
                    type="checkbox"
                    title={`Active: an inactive object is hidden together with its children${
                        store.overrideOf(entity.id)?.active !== undefined ? `. ${CHANGED_TITLE}` : ""
                    }`}
                    checked={entity.active ?? true}
                    onChange={(e) => store.setActive(entity.id, e.target.checked)}
                />
                <Icon name={entityIcon(entity)} />
                <input
                    className="input"
                    value={entity.name}
                    title={inner ? "The name the prefab gives can be changed for this instance" : undefined}
                    onChange={(e) => store.rename(entity.id, e.target.value)}
                />
                {!isPrefabRoot && (
                    <>
                        <button className="btn ghost" title="Duplicate (Ctrl+D)" onClick={duplicate}>
                            <Icon name="copy" />
                        </button>
                        <button
                            className="btn ghost danger"
                            title={inner ? "Remove from this instance; the prefab keeps it (Del)" : "Delete (Del)"}
                            onClick={() => store.removeEntity(entity.id)}
                        >
                            <Icon name="trash" />
                        </button>
                    </>
                )}
            </div>

            {entity.prefab && (
                <div className="note prefab">
                    <Icon name="prefab" /> Instance of prefab <b>{entity.prefab}</b>
                    <span style={{ flex: 1 }} />
                    <button className="btn" title="Edit the prefab; every instance follows" onClick={() => openPrefab(entity.prefab!)}>
                        Edit Prefab
                    </button>
                    <button className="btn" title="Turn into ordinary objects, no longer linked to the prefab" onClick={() => store.unpack(entity.id)}>
                        <Icon name="unlink" /> Unpack
                    </button>
                </div>
            )}
            {inner && (
                <div className="note prefab">
                    <Icon name="prefab" /> Inside an instance of prefab <b>{instance?.prefab}</b>
                </div>
            )}
            {addedIn && (
                <div className="note prefab">
                    <Icon name="plus" /> Added in an instance of prefab <b>{addedIn.prefab}</b>: the prefab does not have it
                </div>
            )}
            {fromPrefab && (
                <div className="note">
                    {store.hasOverrides(entity.id) ? (
                        <>
                            {inner ? "Changed here (marked fields)." : "Has changes of its own."}
                            <button
                                className="btn"
                                title="Write the changes into the prefab: every instance of it gets them"
                                disabled={store.playing || store.editingPrefab === instance?.prefab}
                                onClick={() => applyOverrides(entity.id)}
                            >
                                <Icon name="prefab" /> {inner ? "Apply" : "Apply All"}
                            </button>
                            <button
                                className="btn"
                                title="Drop the changes: back to what the prefab gives"
                                onClick={() => store.revertOverrides(entity.id)}
                            >
                                <Icon name="back" /> {inner ? "Revert" : "Revert All"}
                            </button>
                        </>
                    ) : (
                        "What you change here changes this instance only; the prefab and its other instances stay as they are."
                    )}
                </div>
            )}

            <div className="section-body">
                <div className="field">
                    <label title="A word to find the object by in the running game: self.findAll({ tag: &quot;enemy&quot; })">Tag</label>
                    <div className="control">
                        <input
                            className="input"
                            list="white-tags"
                            value={entity.tag ?? ""}
                            // An instance without a tag of its own has the one of its prefab
                            placeholder={(entity.prefab && store.expand(entity)?.tag) || "none"}
                            disabled={inner}
                            title={inner ? "The tag comes from the prefab" : undefined}
                            onChange={(e) => store.setTag(entity.id, e.target.value.trim())}
                        />
                        {/* The tags of the project, and those the scene uses besides */}
                        <datalist id="white-tags">
                            {[...new Set([...store.registry.settings.tags, ...store.tags])].map((tag) => <option key={tag} value={tag} />)}
                        </datalist>
                    </div>
                </div>
            </div>

            <TransformSection entities={[entity]} />

            {components.map((component) => (
                <ComponentSection key={componentKey(component)} entities={[entity]} components={[component]} />
            ))}

            {removedComponents.map((key) => (
                <div key={key} className="note">
                    Removed in this instance: <b>{key}</b>
                    <button className="btn" title="The instance has the component of the prefab again" onClick={() => store.restoreComponent(entity.id, key)}>
                        <Icon name="back" /> Restore
                    </button>
                </div>
            ))}

            {(
                <>

                    {addSections.some((section) => section.items.length > 0) && (
                        <div className="add-component">
                            <Menu
                                up={components.length > 1}
                                sections={addSections}
                                onPick={(key) => {
                                    const [type, ...source] = key.split(":");
                                    store.addComponent(entity.id, type, source.join(":") || undefined);
                                }}
                                trigger={(toggle) => (
                                    <button className="btn" onClick={toggle}>
                                        <Icon name="plus" /> Add Component
                                    </button>
                                )}
                            />
                        </div>
                    )}

                    {!store.editingPrefab && !fromPrefab && (
                        <div className="note">
                            Reuse this object in many places:
                            <button className="btn" onClick={() => createPrefab(entity.id)}>
                                <Icon name="prefab" /> Create Prefab
                            </button>
                        </div>
                    )}
                </>
            )}
        </>
    );
}

// One of the two lists of a look: its surfaces or its screen effects. With "extends" the list starts with the
// entries of the base look; changing one of those writes the change into this look, the base stays as it is.
function LookList({ name, list, what }: { name: string; list: "surfaces" | "effects"; what: "surface" | "effect" }) {
    const { registry } = useSceneStore();
    const data = registry.getLookData(name) ?? {};
    type Entry = Record<string, ParamValue | undefined>;
    const nameOf = (entry: Entry) => entry[what] as string;
    const own = (data[list] ?? []) as Entry[];
    const resolved = (resolveLook(registry, name)?.[list] ?? []) as Entry[];
    const base = ((data.extends ? resolveLook(registry, data.extends)?.[list] : null) ?? []) as Entry[];
    const defs: { name: string; label?: string; params?: Record<string, ParamDef> }[] =
        list === "surfaces" ? registry.surfaces() : registry.effects();
    const title = what === "surface" ? "Surface" : "Effect";

    const save = (entries: Entry[]) => updateLook(name, { ...data, [list]: entries });
    // Writes params of one entry; one that so far only came from the base look gets its own entry
    const set = (entry: string, patch: Entry) => {
        const exists = own.some((e) => nameOf(e) === entry);
        save(exists ? own.map((e) => (nameOf(e) === entry ? { ...e, ...patch } : e)) : [...own, { [what]: entry, ...patch }]);
    };
    const move = (entry: string, by: number) => {
        const from = own.findIndex((e) => nameOf(e) === entry);
        const to = from + by;
        if (from < 0 || to < 0 || to >= own.length) return;
        const entries = [...own];
        [entries[from], entries[to]] = [entries[to], entries[from]];
        save(entries);
    };

    const addable = defs.filter((def) => !resolved.some((e) => nameOf(e) === def.name));

    return (
        <>
            {resolved.map((entry) => {
                const entryName = nameOf(entry);
                const def = defs.find((d) => d.name === entryName);
                const isOwn = own.some((e) => nameOf(e) === entryName);
                const inherited = base.some((e) => nameOf(e) === entryName);
                const index = own.findIndex((e) => nameOf(e) === entryName);
                return (
                    <Section
                        key={entryName}
                        title={(
                            <>
                                <input
                                    className="checkbox"
                                    type="checkbox"
                                    title="Enabled"
                                    checked={entry.enabled !== false}
                                    onChange={(e) => set(entryName, { enabled: e.target.checked })}
                                />
                                {def?.label ?? entryName}{inherited ? ` (from ${data.extends})` : ""}
                            </>
                        )}
                        extra={isOwn && !inherited && (
                            <>
                                <button className="btn ghost" title="Apply earlier" disabled={index <= 0} onClick={() => move(entryName, -1)}>
                                    <Icon name="up" size={12} />
                                </button>
                                <button className="btn ghost" title="Apply later" disabled={index >= own.length - 1} onClick={() => move(entryName, 1)}>
                                    <Icon name="down" size={12} />
                                </button>
                            </>
                        )}
                        removeTitle={inherited ? "Drop the changes made here, back to the base look" : `Remove ${what}`}
                        onRemove={isOwn ? () => save(own.filter((e) => nameOf(e) !== entryName)) : undefined}
                    >
                        {def ? (
                            <Fields
                                defs={def.params ?? {}}
                                values={entry as Params}
                                onChange={(key, value) => set(entryName, { [key]: value })}
                            />
                        ) : (
                            <div className="note">The {what} <b>{entryName}</b> is not defined in the project's scripts/ folder.</div>
                        )}
                    </Section>
                );
            })}

            {addable.length > 0 && (
                <div className="add-component">
                    <Menu
                        up={resolved.length > 1}
                        sections={[{ items: addable.map((def) => ({ key: def.name, label: def.label ?? def.name })) }]}
                        onPick={(entry) => set(entry, {})}
                        trigger={(toggle) => (
                            <button className="btn" onClick={toggle}>
                                <Icon name="plus" /> Add {title}
                            </button>
                        )}
                    />
                </div>
            )}
        </>
    );
}

// A look asset: its settings, what it adds to the materials (surfaces) and its screen effects
function LookInspector({ name }: { name: string }) {
    const store = useSceneStore();
    const { registry } = store;
    const data = registry.getLookData(name) ?? {};
    const base = data.extends ? resolveLook(registry, data.extends) : null;
    const used = store.environment.look === name;

    const save = (patch: Partial<LookData>) => updateLook(name, { ...data, ...patch });
    const others = registry.lookNames().filter((n) => n !== name);

    return (
        <>
            <div className="inspector-head">
                <Icon name="look" /> <AssetName kind="look" name={name} />
                <button className="btn ghost danger" title="Delete the look" onClick={() => deleteLook(name)}>
                    <Icon name="trash" />
                </button>
            </div>
            <div className="note">
                {used
                    ? "The open scene uses this look."
                    : <button className="btn primary" onClick={() => store.setEnvironment("look", name)}>Use in this scene</button>}
            </div>

            <Section title="Look">
                <div className="field">
                    <label title="extends">Based On</label>
                    <div className="control">
                        <select
                            className="select"
                            value={data.extends ?? ""}
                            onChange={(e) => {
                                const rest = { ...data };
                                delete rest.extends;
                                updateLook(name, e.target.value ? { ...rest, extends: e.target.value } : rest);
                            }}
                        >
                            <option value="">(nothing)</option>
                            {others.map((n) => (
                                <option key={n} value={n}>{n}</option>
                            ))}
                        </select>
                    </div>
                </div>
                <Fields
                    defs={lookFields}
                    values={{ ...(base as unknown as Params | null), ...(data as Params) }}
                    onChange={(key, value) => save({ [key]: value })}
                />
            </Section>

            <LookList name={name} list="surfaces" what="surface" />
            <div className="note">
                Surfaces change how every object of the scene is drawn: where its vertices land, how light falls on it.
                New ones are written in the project's scripts/ folder with defineSurface.
            </div>

            <LookList name={name} list="effects" what="effect" />
            <div className="note">
                Effects work on the finished picture, from top to bottom. Changes are saved at once. New effects are
                written in the project's scripts/ folder with defineEffect.
            </div>
        </>
    );
}

// The name of a material or a look, in the head of its Inspector. Typing another one and pressing Enter (or
// leaving the field) renames the asset together with everything that refers to it.
function AssetName({ kind, name }: { kind: "material" | "look" | "prefab" | "scene"; name: string }) {
    const [text, setText] = useState(name);
    const commit = () => {
        const next = text.trim();
        if (next && next !== name) {
            if (kind === "scene") renameScene(name, next);
            else renameAsset(kind, name, next);
        }
        // If the name was refused, the field shows the real one again
        setText(name);
    };
    return (
        <input
            className="input"
            style={{ flex: 1 }}
            value={text}
            title="Rename: Enter to apply, Esc to cancel. What uses it follows"
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                    setText(name);
                    e.currentTarget.blur();
                }
            }}
        />
    );
}

// A behavior, an effect or a surface: what the scripts of the project (or the engine) define. Nothing to
// edit here: it shows the params, where it is used, and puts it to use.
function ScriptInspector({ kind, name }: { kind: "behavior" | "effect" | "surface"; name: string }) {
    const store = useSceneStore();
    const { registry } = store;
    const def = kind === "behavior" ? registry.getBehavior(name) : kind === "effect" ? registry.getEffect(name) : registry.getSurface(name);
    const builtin = (kind === "effect" && builtinEffects.some((d) => d === def)) || (kind === "surface" && builtinSurfaces.some((d) => d === def));
    const params = Object.entries(def?.params ?? {});

    // Looks that list the effect or surface; objects of the open scene that carry the behavior
    const users: string[] = [];
    if (kind === "behavior") {
        const visit = (entities: EntityData[]) => entities.forEach((entity) => {
            if (getComponent(store.expand(entity) ?? entity, `script:${name}`)) users.push(entity.name);
            visit(entity.children);
        });
        visit(store.entities);
    } else {
        const list = kind === "effect" ? "effects" : "surfaces";
        for (const look of registry.lookNames()) {
            const entries = (resolveLook(registry, look)?.[list] ?? []) as Record<string, unknown>[];
            if (entries.some((entry) => entry[kind] === name)) users.push(look);
        }
    }

    return (
        <>
            <div className="inspector-head">
                <Icon name="script" /> <b style={{ flex: 1 }}>{def?.label ?? name}</b>
            </div>
            <div className="note">
                {kind === "behavior" ? (
                    <button
                        className="btn primary"
                        disabled={!store.selectedId}
                        onClick={() => store.selectedId && store.addComponent(store.selectedId, "script", name)}
                    >
                        <Icon name="plus" /> Add to selected object
                    </button>
                ) : (
                    <button className="btn primary" onClick={() => addToLook(kind === "effect" ? "effects" : "surfaces", name)}>
                        <Icon name="plus" /> Add to the look of the scene
                    </button>
                )}
            </div>
            <div className="note">
                {kind === "behavior" && "A behavior: code that moves an object while the game runs. "}
                {kind === "effect" && "A screen effect: changes the finished picture. "}
                {kind === "surface" && "A surface: changes how every object is drawn. "}
                {builtin
                    ? <>Built into the engine as <b>{name}</b>.</>
                    : <>Defined as <b>{name}</b> in the project's scripts/ folder; edit it in VS Code, the editor reloads it on save.</>}
            </div>

            <Section title="Params">
                {params.map(([key, param]) => (
                    <div key={key} className="field">
                        <label title={key}>{key}</label>
                        <div className="control">
                            <span className="muted">
                                {param.type}{param.type === "select" ? ` (${param.options.join(", ")})` : ""} · default {JSON.stringify(param.default)}
                            </span>
                        </div>
                    </div>
                ))}
                {params.length === 0 && <div className="muted">No params.</div>}
            </Section>

            <Section title={kind === "behavior" ? "On objects of this scene" : "Used by looks"}>
                <div className="muted">{users.length > 0 ? users.join(", ") : "Nothing uses it."}</div>
            </Section>
        </>
    );
}

function AssetInspector({ asset }: { asset: AssetRef }) {
    const store = useSceneStore();
    const { registry } = store;

    if (asset.kind === "look") return <LookInspector name={asset.name} />;
    if (asset.kind === "texture") {
        const users = registry.materialNames().filter((name) => registry.getMaterialData(name)?.texture === asset.name);
        return (
            <>
                <div className="inspector-head">
                    <Icon name="image" /> <b style={{ flex: 1 }}>{asset.name}</b>
                    <button
                        className="btn ghost danger"
                        title="Delete the image file"
                        onClick={(e) => confirmAt(e, `Delete texture ${asset.name}? This cannot be undone`, "Delete", () => deleteTexture(asset.name))}
                    >
                        <Icon name="trash" />
                    </button>
                </div>
                <img className="texture-preview" src={registry.textureUrl(asset.name)} alt={asset.name} />
                <div className="note">
                    An image of the project's assets/ folder. A material uses it through its Texture field; drag it onto an
                    object to give that object a material with it.
                </div>
                <Section title="Used by materials">
                    <div className="muted">{users.length > 0 ? users.join(", ") : "No material uses it."}</div>
                </Section>
            </>
        );
    }
    if (asset.kind === "sound") {
        const users = store.usersOf("sound", asset.name).map((entity) => entity.name);
        return (
            <>
                <div className="inspector-head">
                    <Icon name="sound" /> <b style={{ flex: 1 }}>{asset.name}</b>
                    <button
                        className="btn ghost danger"
                        title="Delete the audio file"
                        onClick={(e) => confirmAt(e, `Delete sound ${asset.name}? This cannot be undone`, "Delete", () => deleteTexture(asset.name))}
                    >
                        <Icon name="trash" />
                    </button>
                </div>
                <audio className="sound-preview" controls src={registry.soundUrl(asset.name)} />
                <div className="note">
                    An audio file of the project's assets/ folder. An object plays it with a Sound component (drag it onto
                    the object), a behavior with self.playSound("{asset.name}").
                </div>
                <Section title="Sound components of this scene">
                    <div className="muted">{users.length > 0 ? users.join(", ") : "No object has it."}</div>
                </Section>
            </>
        );
    }
    if (asset.kind === "behavior" || asset.kind === "effect" || asset.kind === "surface") {
        return <ScriptInspector kind={asset.kind} name={asset.name} />;
    }

    if (asset.kind === "material") {
        return (
            <>
                <div className="inspector-head">
                    <Icon name="material" /> <AssetName kind="material" name={asset.name} />
                    <button className="btn ghost danger" title="Delete the material" onClick={() => deleteMaterial(asset.name)}>
                        <Icon name="trash" />
                    </button>
                </div>
                <Section title="Material">
                    <Fields
                        defs={materialFields}
                        values={(registry.getMaterialData(asset.name) ?? {}) as Params}
                        onChange={(key, value) => updateMaterial(asset.name, key as keyof MaterialData, value as never)}
                    />
                </Section>
                <div className="note">Changes are saved at once and apply to every object that uses this material.</div>
            </>
        );
    }

    if (asset.kind === "prefab") {
        return (
            <>
                <div className="inspector-head">
                    <Icon name="prefab" /> <AssetName kind="prefab" name={asset.name} />
                    <button
                        className="btn ghost danger"
                        title="Delete the prefab"
                        onClick={(e) => confirmAt(e, `Delete prefab ${asset.name}? This cannot be undone`, "Delete", () => deletePrefab(asset.name))}
                    >
                        <Icon name="trash" />
                    </button>
                </div>
                <div className="note">
                    <button className="btn primary" onClick={() => openPrefab(asset.name)}>Edit Prefab</button>
                    <button className="btn" onClick={() => instantiatePrefab(asset.name)}>
                        <Icon name="plus" /> Add to scene
                    </button>
                </div>
                <div className="note">A prefab is a reusable object. Editing it changes every instance placed in the scenes.</div>
            </>
        );
    }

    if (asset.kind === "model") {
        const model = registry.getModel(asset.name);
        return (
            <>
                <div className="inspector-head">
                    <Icon name="script" /> <b style={{ flex: 1 }}>{model?.label ?? asset.name}</b>
                </div>
                <div className="note">
                    <button className="btn primary" onClick={() => instantiateModel(asset.name)}>
                        <Icon name="plus" /> Add to scene
                    </button>
                </div>
                <div className="note">
                    A model built by code: <b>{asset.name}</b> from the project's scripts/ folder. Edit it in VS Code; the
                    editor reloads it on save.
                </div>
            </>
        );
    }

    return (
        <>
            <div className="inspector-head">
                <Icon name="scene" /> <AssetName kind="scene" name={asset.name} />
                {asset.name !== store.sceneName && (
                    <button
                        className="btn ghost danger"
                        title="Delete the scene file"
                        onClick={(e) => confirmAt(e, `Delete scene ${asset.name}? This cannot be undone`, "Delete", () => deleteScene(asset.name))}
                    >
                        <Icon name="trash" />
                    </button>
                )}
            </div>
            <div className="note">
                {asset.name === store.sceneName
                    ? "This scene is open."
                    : <button className="btn primary" onClick={() => openScene(asset.name)}>Open Scene</button>}
            </div>
        </>
    );
}

// What the game of the project starts with and what shape its picture has (project.json)
export function GameSection() {
    const store = useSceneStore();
    const { settings } = store.registry;
    // A scene the settings name but the project no longer has stays visible
    const scenes = settings.startScene && !store.scenes.includes(settings.startScene) ? [...store.scenes, settings.startScene] : store.scenes;
    return (
        <Section title="Game">
            <div className="field">
                <label title="The scene a built game starts with. A behavior goes to another with self.loadScene(name)">Start scene</label>
                <div className="control">
                    <select className="select" value={settings.startScene} onChange={(e) => updateSettings({ ...settings, startScene: e.target.value })}>
                        <option value="">(main, or the first one)</option>
                        {scenes.map((name) => <option key={name} value={name}>{name}</option>)}
                    </select>
                </div>
            </div>
            <div className="field">
                <label title="The shape of the picture of the game: in the Game view of Play and in the built game. The rest of the window stays black">Aspect</label>
                <div className="control">
                    <select className="select" value={settings.aspect} onChange={(e) => updateSettings({ ...settings, aspect: e.target.value })}>
                        {ASPECTS.map((aspect) => <option key={aspect} value={aspect}>{aspect === "free" ? "Free (fills the window)" : aspect}</option>)}
                    </select>
                </div>
            </div>
            <div className="field">
                <label title="How fast the bodies of the physics gain speed downwards, meters per second squared">Gravity</label>
                <div className="control">
                    <NumberInput value={settings.gravity} step={1} onChange={(gravity) => updateSettings({ ...settings, gravity })} />
                </div>
            </div>
            <div className="field">
                <label title="The bottom of the world, meters: a body of the physics that falls below it is removed">World bottom</label>
                <div className="control">
                    <NumberInput value={settings.bottom} step={10} onChange={(bottom) => updateSettings({ ...settings, bottom })} />
                </div>
            </div>
            <div className="field">
                <label title="What walks with self.move() cannot shove a body heavier than this, kilograms: it is a wall for it. 0: it shoves any">Push limit</label>
                <div className="control">
                    <NumberInput value={settings.pushMass} step={0.5} min={0} onChange={(pushMass) => updateSettings({ ...settings, pushMass })} />
                </div>
            </div>
        </Section>
    );
}

// The tags of the project (project.json). With a list, the Inspector offers these and check tells about a
// tag that is not among them; without one any word can be a tag.
export function TagsSection() {
    const store = useSceneStore();
    const { settings } = store.registry;
    const [name, setName] = useState("");
    const add = () => {
        const tag = name.trim();
        if (!tag || settings.tags.includes(tag)) return;
        updateSettings({ ...settings, tags: [...settings.tags, tag] });
        setName("");
    };
    // The tags the open scene uses that the list does not have yet
    const loose = store.tags.filter((tag) => !settings.tags.includes(tag));
    return (
        <Section title="Tags">
            {settings.tags.map((tag) => (
                <div key={tag} className="field">
                    <label>Tag</label>
                    <div className="control">
                        <span style={{ flex: 1 }}>{tag}</span>
                        <button
                            className="btn ghost"
                            title="Remove the tag from the list; objects that have it keep it"
                            onClick={() => updateSettings({ ...settings, tags: settings.tags.filter((other) => other !== tag) })}
                        >
                            <Icon name="close" size={12} />
                        </button>
                    </div>
                </div>
            ))}
            <div className="field">
                <label>New tag</label>
                <div className="control">
                    <input className="input" value={name} placeholder="word" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
                    <button className="btn ghost" title="Add the tag" onClick={add}>
                        <Icon name="plus" size={12} />
                    </button>
                </div>
            </div>
            {loose.length > 0 && (
                <div className="note">
                    Used in this scene, not in the list: {loose.join(", ")}
                    <button className="btn" onClick={() => updateSettings({ ...settings, tags: [...settings.tags, ...loose] })}>Add them</button>
                </div>
            )}
            <div className="note">
                An object has one tag (Inspector); behaviors find objects by it: self.findAll({"{"} tag {"}"}).
                {settings.tags.length === 0 ? " The list is empty, so any word can be a tag." : " A tag that is not in the list is reported by check."}
            </div>
        </Section>
    );
}

// The collision layers of the project (project.json): their names, and which pairs of them collide.
// Shown in the Settings window, on the Project page.
export function LayersSection() {
    const store = useSceneStore();
    const { settings } = store.registry;
    const [name, setName] = useState("");
    const layers = [DEFAULT_LAYER, ...settings.layers];

    const add = () => {
        const layer = name.trim();
        if (!layer || layers.includes(layer)) return;
        updateSettings({ ...settings, layers: [...settings.layers, layer] });
        setName("");
    };
    const remove = (layer: string) => updateSettings({
        ...settings,
        layers: settings.layers.filter((other) => other !== layer),
        noCollision: settings.noCollision.filter((pair) => !pair.includes(layer))
    });

    return (
        <Section title="Collision Layers">
            {settings.layers.map((layer) => (
                <div key={layer} className="field">
                    <label title={layer}>Layer</label>
                    <div className="control">
                        {/* Another name is written into every collider that has the old one */}
                        <input
                            className="input"
                            defaultValue={layer}
                            title="Type another name and press Enter: the colliders of the scenes and prefabs follow"
                            onBlur={(e) => {
                                e.target.value = layer;
                            }}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") renameLayer(layer, e.currentTarget.value);
                                if (e.key === "Escape") e.currentTarget.blur();
                            }}
                        />
                        <button className="btn ghost" title="Remove the layer; colliders that name it must be given another" onClick={() => remove(layer)}>
                            <Icon name="close" size={12} />
                        </button>
                    </div>
                </div>
            ))}
            <div className="field">
                <label>New layer</label>
                <div className="control">
                    <input
                        className="input"
                        value={name}
                        placeholder="name"
                        onChange={(e) => setName(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && add()}
                    />
                    <button className="btn ghost" title="Add the layer" onClick={add}>
                        <Icon name="plus" size={12} />
                    </button>
                </div>
            </div>
            {layers.length > 1 && (
                <table className="layer-matrix">
                    <thead>
                        <tr>
                            <th />
                            {layers.map((layer) => <th key={layer}><span>{layer}</span></th>)}
                        </tr>
                    </thead>
                    <tbody>
                        {layers.map((row, i) => (
                            <tr key={row}>
                                <th>{row}</th>
                                {layers.map((column, j) => (
                                    <td key={column}>
                                        {/* Each pair once: the order of the two does not matter */}
                                        {j <= i && (
                                            <input
                                                className="checkbox"
                                                type="checkbox"
                                                title={`${row} and ${column}: ${layersCollide(settings, row, column) ? "collide" : "do not notice each other"}`}
                                                checked={layersCollide(settings, row, column)}
                                                onChange={(e) => updateSettings(setLayersCollide(settings, row, column, e.target.checked))}
                                            />
                                        )}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            <div className="note">
                A collider names its layer. Unchecked pairs do not notice each other: they neither stop each other nor get enter / exit.
            </div>
        </Section>
    );
}

export default function Inspector() {
    const store = useSceneStore();
    const selected = store.selected;
    const asset = store.selectedAsset;

    return (
        <div className="panel right">
            <div className="panel-header">Inspector</div>
            <div className="panel-body">
                {asset ? (
                    <AssetInspector key={`${asset.kind}:${asset.name}:${store.restores}`} asset={asset} />
                ) : store.selectedIds.length > 1 ? (
                    <MultiInspector
                        key={`${store.selectedIds.join()}:${store.restores}`}
                        entities={store.selectedIds.map((id) => store.findEntity(id)).filter((entity) => entity !== null)}
                    />
                ) : selected ? (
                    <EntityInspector key={`${selected.id}:${store.restores}`} entity={selected} />
                ) : store.editingPrefab ? (
                    <div className="empty">Select an object of the prefab to edit it.</div>
                ) : (
                    // Nothing selected: the settings of the scene itself
                    <>
                        <div className="inspector-head">
                            <Icon name="scene" /> <b>Scene settings</b>
                        </div>
                        <Section title="Environment">
                            <Fields
                                defs={environmentFields}
                                values={store.environment as unknown as Params}
                                onChange={(key, value) => store.setEnvironment(key as keyof EnvironmentData, value as never)}
                            />
                        </Section>
                        <div className="note">
                            Layers, editor options and the list of keys:
                            <button className="btn" onClick={() => store.openSettings("project")}>
                                <Icon name="settings" /> Settings
                            </button>
                        </div>
                        <div className="empty">Select an object in the Hierarchy or the viewport to edit it.</div>
                    </>
                )}
            </div>
        </div>
    );
}
