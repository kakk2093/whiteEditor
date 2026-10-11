import { useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import {
    componentDefs, componentKey, environmentFields, fieldApplies, lookFields, materialFields, MAX_COLORS, paramDefaults, resolveLook
} from "../engine";
import type {
    ComponentData, EntityData, EnvironmentData, LookData, MaterialData, ParamDef, ParamValue, Params
} from "../engine";
import {
    applyOverrides, createPrefab, deleteLook, deleteMaterial, deletePrefab, deleteScene, openPrefab, openScene, updateLook, updateMaterial
} from "./core/actions";
import { instantiateModel, instantiatePrefab } from "./core/dnd";
import { openContextMenu } from "./contextMenu";
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

// Shows a short value, but while the field is focused keeps exactly what is being typed
function NumberInput({ value, step, min, max, onChange }: {
    value: number;
    step?: number;
    min?: number;
    max?: number;
    onChange: (value: number) => void;
}) {
    const [text, setText] = useState<string | null>(null);

    return (
        <input
            className="input"
            type="number"
            step={step ?? 0.1}
            min={min}
            max={max}
            value={text ?? String(Math.round(value * 1000) / 1000)}
            onFocus={(e) => setText(e.target.value)}
            onBlur={() => setText(null)}
            onChange={(e) => {
                setText(e.target.value);
                const parsed = Number(e.target.value);
                if (e.target.value !== "" && !Number.isNaN(parsed)) onChange(parsed);
            }}
        />
    );
}

function ParamField({ def, value, onChange }: { def: ParamDef; value: ParamValue; onChange: (value: ParamValue) => void }) {
    switch (def.type) {
        case "number":
            return <NumberInput value={value as number} step={def.step} min={def.min} max={def.max} onChange={onChange} />;
        case "color":
            return (
                <>
                    <input className="color-swatch" type="color" value={value as string} onChange={(e) => onChange(e.target.value)} />
                    <input
                        className="input"
                        key={value as string}
                        defaultValue={value as string}
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
            return <input className="checkbox" type="checkbox" checked={value as boolean} onChange={(e) => onChange(e.target.checked)} />;
        case "select":
            return (
                <select className="select" value={value as string} onChange={(e) => onChange(e.target.value)}>
                    {def.options.map((option) => (
                        <option key={option} value={option}>{humanize(option)}</option>
                    ))}
                </select>
            );
        case "asset":
            return (
                <select className="select" value={value as string} onChange={(e) => onChange(e.target.value)}>
                    <option value="">{def.kind === "material" ? "Default (gray)" : "(none)"}</option>
                    {sceneStore.registry.assetNames(def.kind).map((name) => (
                        <option key={name} value={name}>{name}</option>
                    ))}
                </select>
            );
        case "string":
            return <input className="input" value={value as string} onChange={(e) => onChange(e.target.value)} />;
    }
}

// One row per field, values missing in `values` show the default
// Shown on what a prefab instance has changed for itself
const CHANGED_TITLE = "Changed in this instance: the prefab has another value. Right-click to revert";

// The right-click menu of a field a prefab instance has changed
function revertMenu(e: MouseEvent, run: () => void) {
    openContextMenu(e, [{ items: [{ label: "Revert to Prefab", icon: "back", run }] }]);
}

function Fields({ defs, values, onChange, changed, onRevert }: {
    defs: Record<string, ParamDef>;
    values: Params;
    onChange: (key: string, value: ParamValue) => void;
    // The fields a prefab instance overrides; they are marked
    changed?: Record<string, unknown>;
    // Puts such a field back to what the prefab gives
    onRevert?: (key: string) => void;
}) {
    const defaults = paramDefaults(defs);
    return (
        <>
            {Object.entries(defs).filter(([, def]) => fieldApplies(def, defs, values)).map(([key, def]) => (
                <div key={key} className="field">
                    <label
                        className={changed && key in changed ? "overridden" : undefined}
                        title={changed && key in changed ? `${key} — ${CHANGED_TITLE}` : key}
                        onContextMenu={changed && key in changed && onRevert ? (e) => revertMenu(e, () => onRevert(key)) : undefined}
                    >
                        {humanize(key)}
                    </label>
                    <div className="control">
                        <ParamField def={def} value={values[key] ?? defaults[key]} onChange={(value) => onChange(key, value)} />
                    </div>
                </div>
            ))}
        </>
    );
}

function Section({ title, onRemove, removeTitle = "Remove component", extra, children }: {
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

function TransformSection({ entity }: { entity: EntityData }) {
    const override = sceneStore.overrideOf(entity.id);
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
                                    step={property === "rotation" ? 5 : 0.1}
                                    onChange={(value) => sceneStore.setTransform(entity.id, property, i as 0 | 1 | 2, value)}
                                />
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </Section>
    );
}

// `locked` is for a component that comes from a prefab: its fields can be changed (an override of the
// instance), the component itself stays
function ComponentSection({ entity, component, locked = false }: { entity: EntityData; component: ComponentData; locked?: boolean }) {
    const store = useSceneStore();
    const def = componentDefs[component.type];
    const key = componentKey(component);

    // A model or a behavior from the project scripts, with its own params
    const source = def?.source;
    const sourceName = source ? (component[source.key] as string | undefined) ?? "" : "";
    const sourceDef = source?.get(store.registry, sourceName);

    // A name that is saved in the scene but missing from the scripts stays selectable
    const names = source?.list(store.registry).map((d) => d.name) ?? [];
    if (sourceName && !names.includes(sourceName)) names.push(sourceName);

    // Components an entity has several of are told apart by what they run: "Spin (Script)"
    const title = def?.multiple ? `${sourceDef?.label ?? sourceName} (${def.label})` : def?.label ?? component.type;

    // What a prefab instance changes in this component
    const override = store.overrideOf(entity.id)?.components?.[key];

    return (
        <Section title={title} onRemove={locked ? undefined : () => store.removeComponent(entity.id, key)}>
            {def && (
                <Fields
                    defs={def.fields}
                    values={component as Params}
                    onChange={(field, value) => store.setComponentField(entity.id, key, field, value)}
                    changed={override}
                    onRevert={(field) => store.revertOverrideField(entity.id, ["components", key, field])}
                />
            )}

            {source && !def.multiple && (
                <div className="field">
                    <label
                        className={override && source.key in override ? "overridden" : undefined}
                        title={override && source.key in override ? CHANGED_TITLE : undefined}
                        onContextMenu={override && source.key in override
                            ? (e) => revertMenu(e, () => store.revertOverrideField(entity.id, ["components", key]))
                            : undefined}
                    >
                        {humanize(source.key)}
                    </label>
                    <div className="control">
                        <select
                            className="select"
                            value={sourceName}
                            onChange={(e) => store.setComponentField(entity.id, key, source.key, e.target.value)}
                        >
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
                    onChange={(param, value) => store.setComponentParam(entity.id, key, param, value)}
                    changed={override?.params as Params | undefined}
                    onRevert={(param) => store.revertOverrideField(entity.id, ["components", key, "params", param])}
                />
            )}
            {source && sourceName && !sourceDef && (
                <div className="note">
                    The {source.what} <b>{sourceName}</b> is not defined in the project's scripts/ folder.
                </div>
            )}
        </Section>
    );
}

function EntityInspector({ entity }: { entity: EntityData }) {
    const store = useSceneStore();
    const isPrefabRoot = store.editingPrefab !== null && store.entities[0] === entity;
    // Something inside a prefab instance: what is changed here is kept by the instance as an override
    const inner = store.isInner(entity.id);
    const instance = store.instanceOf(entity.id);
    const fromPrefab = inner || entity.prefab !== undefined;
    // The components of an instance are those of the root of its prefab
    const components = (entity.prefab ? store.expand(entity)?.components : entity.components) ?? [];

    // Add Component: the types the entity does not have yet, then, for the types it can have several of
    // (scripts), what is not attached yet
    const types = Object.keys(componentDefs);
    const addSections: MenuSection[] = [
        {
            items: types
                .filter((type) => !componentDefs[type].multiple && !getComponent(entity, type))
                .map((type) => ({ key: type, label: componentDefs[type].label }))
        },
        ...types.filter((type) => componentDefs[type].multiple).map((type) => ({
            title: `${componentDefs[type].label}s`,
            items: (componentDefs[type].source?.list(store.registry) ?? [])
                .filter((d) => !getComponent(entity, `${type}:${d.name}`))
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
                    disabled={inner}
                    title={inner ? "The name comes from the prefab" : undefined}
                    onChange={(e) => store.rename(entity.id, e.target.value)}
                />
                {!isPrefabRoot && !inner && (
                    <>
                        <button className="btn ghost" title="Duplicate (Ctrl+D)" onClick={duplicate}>
                            <Icon name="copy" />
                        </button>
                        <button className="btn ghost danger" title="Delete (Del)" onClick={() => store.removeEntity(entity.id)}>
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

            <TransformSection entity={entity} />

            {components.map((component) => (
                <ComponentSection key={componentKey(component)} entity={entity} component={component} locked={fromPrefab} />
            ))}

            {!fromPrefab && (
                <>

                    {addSections.some((section) => section.items.length > 0) && (
                        <div className="add-component">
                            <Menu
                                up={entity.components.length > 1}
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

                    {!store.editingPrefab && (
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
                <Icon name="look" /> <b style={{ flex: 1 }}>{name}</b>
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

function AssetInspector({ asset }: { asset: AssetRef }) {
    const store = useSceneStore();
    const { registry } = store;

    if (asset.kind === "look") return <LookInspector name={asset.name} />;

    if (asset.kind === "material") {
        return (
            <>
                <div className="inspector-head">
                    <Icon name="material" /> <b style={{ flex: 1 }}>{asset.name}</b>
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
                    <Icon name="prefab" /> <b style={{ flex: 1 }}>{asset.name}</b>
                    <button className="btn ghost danger" title="Delete the prefab" onClick={() => deletePrefab(asset.name)}>
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
                <Icon name="scene" /> <b style={{ flex: 1 }}>{asset.name}</b>
                {asset.name !== store.sceneName && (
                    <button className="btn ghost danger" title="Delete the scene file" onClick={() => deleteScene(asset.name)}>
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
                        <div className="empty">Select an object in the Hierarchy or the viewport to edit it.</div>
                    </>
                )}
            </div>
        </div>
    );
}
