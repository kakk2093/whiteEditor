import { useState } from "react";
import type { ReactNode } from "react";
import { componentDefs, componentKey, environmentFields, materialFields, paramDefaults } from "../engine";
import type { ComponentData, EntityData, EnvironmentData, MaterialData, ParamDef, ParamValue, Params } from "../engine";
import { createPrefab, deleteMaterial, deletePrefab, deleteScene, openPrefab, openScene, updateMaterial } from "./core/actions";
import { instantiateModel, instantiatePrefab } from "./core/dnd";
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
                    <option value="">Default (gray)</option>
                    {sceneStore.registry.materialNames().map((name) => (
                        <option key={name} value={name}>{name}</option>
                    ))}
                </select>
            );
        case "string":
            return <input className="input" value={value as string} onChange={(e) => onChange(e.target.value)} />;
    }
}

// One row per field, values missing in `values` show the default
function Fields({ defs, values, onChange }: {
    defs: Record<string, ParamDef>;
    values: Params;
    onChange: (key: string, value: ParamValue) => void;
}) {
    const defaults = paramDefaults(defs);
    return (
        <>
            {Object.entries(defs).map(([key, def]) => (
                <div key={key} className="field">
                    <label title={key}>{humanize(key)}</label>
                    <div className="control">
                        <ParamField def={def} value={values[key] ?? defaults[key]} onChange={(value) => onChange(key, value)} />
                    </div>
                </div>
            ))}
        </>
    );
}

function Section({ title, onRemove, children }: { title: string; onRemove?: () => void; children: ReactNode }) {
    return (
        <div className="section">
            <div className="section-header">
                {title}
                <span className="spacer" />
                {onRemove && (
                    <button className="btn ghost" title="Remove component" onClick={onRemove}>
                        <Icon name="close" size={12} />
                    </button>
                )}
            </div>
            <div className="section-body">{children}</div>
        </div>
    );
}

function TransformSection({ entity }: { entity: EntityData }) {
    return (
        <Section title="Transform">
            {TRANSFORMS.map(({ property, title }) => (
                <div key={property} className="field">
                    <label>{title}</label>
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

function ComponentSection({ entity, component }: { entity: EntityData; component: ComponentData }) {
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

    return (
        <Section title={title} onRemove={() => store.removeComponent(entity.id, key)}>
            {def && (
                <Fields
                    defs={def.fields}
                    values={component as Params}
                    onChange={(field, value) => store.setComponentField(entity.id, key, field, value)}
                />
            )}

            {source && !def.multiple && (
                <div className="field">
                    <label>{humanize(source.key)}</label>
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
                    className="checkbox"
                    type="checkbox"
                    title="Active: an inactive object is hidden together with its children"
                    checked={entity.active ?? true}
                    onChange={(e) => store.setActive(entity.id, e.target.checked)}
                />
                <Icon name={entityIcon(entity)} />
                <input className="input" value={entity.name} onChange={(e) => store.rename(entity.id, e.target.value)} />
                {!isPrefabRoot && (
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

            <TransformSection entity={entity} />

            {!entity.prefab && (
                <>
                    {entity.components.map((component) => (
                        <ComponentSection key={componentKey(component)} entity={entity} component={component} />
                    ))}

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

function AssetInspector({ asset }: { asset: AssetRef }) {
    const store = useSceneStore();
    const { registry } = store;

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
                    <AssetInspector asset={asset} />
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
