import { useState } from "react";
import * as THREE from "three";
import { DEFAULT_PALETTE, generatorFields, generatorOf, isPainted, MAX_TERRAIN_COLORS, terrainSize } from "../engine";
import type { ComponentData, EntityData, Params } from "../engine";
import { createTerrainAsset, generateTerrainAsset, resizeTerrainAsset, setTerrainGenerator, setTerrainPalette } from "./core/actions";
import type { TerrainBrushSettings } from "./core/SceneStore";
import { useSceneStore } from "./core/useSceneStore";
import { Fields, NumberInput } from "./Inspector";

const TOOLS: { tool: TerrainBrushSettings["tool"]; label: string; title: string }[] = [
    { tool: "raise", label: "Raise", title: "Raise the ground under the brush; with Shift, lower it" },
    { tool: "lower", label: "Lower", title: "Lower the ground under the brush; with Shift, raise it" },
    { tool: "smooth", label: "Smooth", title: "Even out bumps and sharp edges" },
    { tool: "flatten", label: "Flatten", title: "Level the ground to the height where the stroke began" },
    { tool: "paint", label: "Paint", title: "Paint the ground with a color of the palette" },
    { tool: "generate", label: "Generate", title: "Make the ground under the brush what the settings of Generate give there; the rest stays as it is" },
];

// What the Terrain component shows in the Inspector under its fields: making the terrain asset, its size,
// generating its ground, and, while "Edit Terrain" is on, the brush
export function TerrainTools({ entity, component }: { entity: EntityData; component: ComponentData }) {
    const store = useSceneStore();
    const name = (component.terrain as string | undefined) ?? "";
    const data = store.registry.getTerrain(name);
    // The size being typed, until Resize is pressed: [meters along X, meters along Z, cell]
    const [typed, setTyped] = useState<{ of: string; size: [number, number, number] } | null>(null);

    if (store.playing) return null;
    if (!data) {
        return (
            <div className="field">
                <label />
                <div className="control">
                    <button className="btn" title="Makes a terrain file (level ground 64 x 64 m) and puts it on this object" onClick={() => createTerrainAsset(entity.id)}>
                        New Terrain
                    </button>
                </div>
            </div>
        );
    }

    const [width, depth] = terrainSize(data);
    const size = typed?.of === name ? typed.size : [width, depth, data.cell] as [number, number, number];
    const setSize = (index: number, value: number) => setTyped({ of: name, size: size.map((old, i) => (i === index ? value : old)) as [number, number, number] });
    const resized = size[0] !== width || size[1] !== depth || size[2] !== data.cell;
    const palette = data.palette?.length ? data.palette : DEFAULT_PALETTE;
    // Where the terrain stands: a height the generator gives depends on the place in the world
    const place = () => store.terrainTarget?.mesh.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3();
    const { brush } = store;
    const color = Math.min(brush.color, palette.length - 1);

    return (
        <>
            <div className="field">
                <label title="Meters along X and along Z, and the meters between two heights">Size</label>
                <div className="control">
                    <NumberInput value={size[0]} step={1} min={1} onChange={(value) => setSize(0, value)} />
                    <NumberInput value={size[1]} step={1} min={1} onChange={(value) => setSize(1, value)} />
                    <NumberInput value={size[2]} step={0.25} min={0.1} onChange={(value) => setSize(2, value)} />
                </div>
            </div>
            {resized && (
                <div className="field">
                    <label />
                    <div className="control">
                        <button
                            className="btn primary"
                            title="The ground keeps its shape; what is added around it goes on from its edge, what does not fit is cut off"
                            onClick={() => {
                                resizeTerrainAsset(name, size[0], size[1], size[2]);
                                setTyped(null);
                            }}
                        >
                            Resize to {Math.max(1, Math.round(size[0] / size[2])) * size[2]} x {Math.max(1, Math.round(size[1] / size[2])) * size[2]} m
                        </button>
                        <button className="btn ghost" onClick={() => setTyped(null)}>Cancel</button>
                    </div>
                </div>
            )}

            <div className="terrain-heading" title="Hills out of noise. The settings are kept in the file of the terrain">Generate</div>
            <Fields defs={generatorFields} values={generatorOf(data) as unknown as Params} onChange={(key, value) => setTerrainGenerator(name, { [key]: value as number | boolean })} />
            <div className="field">
                <label />
                <div className="control">
                    <button className="btn primary" title="Makes the whole ground anew by these settings: what was shaped and painted by hand is replaced. Ctrl+Z takes it back" onClick={() => generateTerrainAsset(name, place())}>
                        Generate
                    </button>
                    <button
                        className="btn"
                        title="Another seed, and the ground made by it"
                        onClick={() => {
                            setTerrainGenerator(name, { seed: Math.floor(Math.random() * 100000) });
                            generateTerrainAsset(name, place());
                        }}
                    >
                        New Seed
                    </button>
                </div>
            </div>

            {store.terrainEdit && (
                <>
                    <div className="terrain-tools">
                        {TOOLS.map(({ tool, label, title }) => (
                            <button key={tool} className={`btn ghost ${brush.tool === tool ? "active" : ""}`} title={title} onClick={() => store.setBrush({ tool })}>
                                {label}
                            </button>
                        ))}
                    </div>
                    <div className="field">
                        <label title="Meters">Radius</label>
                        <div className="control">
                            <NumberInput value={brush.radius} step={0.5} min={0.25} max={200} onChange={(radius) => store.setBrush({ radius })} />
                        </div>
                    </div>
                    {brush.tool !== "paint" && (
                        <div className="field">
                            <label title="Raise and Lower: meters per second in the middle of the brush. Smooth, Flatten and Generate: how fast they work">Strength</label>
                            <div className="control">
                                <NumberInput value={brush.strength} step={0.5} min={0.1} max={100} onChange={(strength) => store.setBrush({ strength })} />
                            </div>
                        </div>
                    )}
                    {brush.tool === "paint" && (
                        <>
                            <div className="field">
                                <label title="The kinds of ground of this terrain. Click one to paint with it">Palette</label>
                                <div className="control terrain-palette">
                                    {palette.map((swatch, i) => (
                                        <button
                                            key={i}
                                            className={`terrain-swatch ${i === color ? "active" : ""}`}
                                            style={{ background: swatch }}
                                            title={`${i}: ${swatch}`}
                                            onClick={() => store.setBrush({ color: i })}
                                        />
                                    ))}
                                    {palette.length < MAX_TERRAIN_COLORS && (
                                        <button
                                            className="btn ghost"
                                            title="One more color"
                                            onClick={() => {
                                                setTerrainPalette(name, [...palette, "#b0a070"]);
                                                store.setBrush({ color: palette.length });
                                            }}
                                        >
                                            +
                                        </button>
                                    )}
                                    {palette.length > 1 && (
                                        <button
                                            className="btn ghost"
                                            title="Remove the last color; what was painted with it gets the first one"
                                            onClick={() => {
                                                setTerrainPalette(name, palette.slice(0, -1));
                                                store.setBrush({ color: Math.min(color, palette.length - 2) });
                                            }}
                                        >
                                            −
                                        </button>
                                    )}
                                </div>
                            </div>
                            <div className="field">
                                <label title="The color of the kind of ground that is picked: changing it repaints all the ground of that kind">Color</label>
                                <div className="control">
                                    <input
                                        className="color-swatch"
                                        type="color"
                                        value={palette[color]}
                                        onChange={(e) => setTerrainPalette(name, palette.map((old, i) => (i === color ? e.target.value : old)))}
                                    />
                                    <span className="terrain-note">{palette[color]}</span>
                                </div>
                            </div>
                            {!isPainted(data) && <div className="terrain-note">Not painted yet: the first stroke paints all of it with the first color. The colors are multiplied by the material — use a white one, or none.</div>}
                        </>
                    )}
                    <div className="terrain-note">Hold the left button on the ground. The camera: right button and W A S D, the wheel.</div>
                </>
            )}
        </>
    );
}
