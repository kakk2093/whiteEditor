import * as THREE from "three";
import { addRiverPoint, insertRiverPoint, animatorOf, animationOf, brushTerrain, cloneTerrain, componentDefs, Game, parsePrefab, parseScene, Registry, terrainSize, updateWorlds, validateWorld } from "../../engine";
import type { EntityData, PrefabData, RiverPoint, SceneData, TerrainData } from "../../engine";
import { applyOverrides, closePrefab, createPiece, createWorldPiece, generateWorld, createPrefab, addTerrainToScene, createBiome, createTerrainAsset, deleteGround, editRivers, duplicateGround, generateTerrainAsset, openProject, renameGround, updateBiome, resizeTerrainAsset, save, setTerrainGenerator, setTerrainPalette, strokeTerrain, updateMaterial } from "../core/actions";
import { editorLog } from "../core/log";
import { deleteAsset, listAssets, readAsset, writeAsset } from "../core/project";
import type { AssetSection } from "../core/project";
import { sceneStore as store } from "../core/SceneStore";

// The checks of the editor itself: `npm run test` opens the editor in a browser without a window, on a
// project made for the run (tools/test.mjs writes it and removes it), and this file drives it the way the
// panels do: through the methods of the store and the actions. What is on disk is read back through the API.
// Nothing here presses real buttons: the mouse, the gizmo and drag-and-drop are not checked.

const PROJECT = "t";

const failures: string[] = [];
let checks = 0;
let group = "";

function fail(what: string) {
    failures.push(`${group}: ${what}`);
}

function ok(what: string, condition: unknown) {
    checks++;
    if (!condition) fail(what);
}

function equal(what: string, actual: unknown, expected: unknown) {
    checks++;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// Numbers that went through the matrices of three.js
function near(what: string, actual: number[] | undefined, expected: number[]) {
    checks++;
    if (!actual || actual.length !== expected.length || actual.some((value, i) => Math.abs(value - expected[i]) > 1e-3)) {
        fail(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits for what is written a moment later (a file after an undo, a field after a debounce)
async function until(what: string, condition: () => Promise<boolean> | boolean) {
    checks++;
    for (let i = 0; i < 40; i++) {
        if (await condition()) return;
        await wait(50);
    }
    fail(`${what}: did not happen in 2 s`);
}

// Changes that come one right after another are one step of undo; this makes the next one a step of its own
const settle = () => Reflect.set(store, "lastChange", 0);

const json = () => JSON.stringify(store.toJSON());
const real = (id: string) => store.realEntity(id);
const worldPosition = (id: string) => store.objectOf(id)?.getWorldPosition(new THREE.Vector3()).toArray();
const prefabFile = async (name: string) => ((await readAsset(PROJECT, "prefabs", name)) as PrefabData).root;
const child = (entity: EntityData | null | undefined, name: string) => entity?.children.find((other) => other.name === name);

// The root of a prefab as text, whichever way it is written: with every default filled in and without the
// ids, which are made up when a file that has none is read
function plain(root: EntityData) {
    return JSON.stringify(parsePrefab({ version: 3, root }).root, (key, value: unknown) => (key === "id" ? undefined : value));
}

function undoAll() {
    let steps = 0;
    while (store.canUndo && steps < 200) {
        store.undo();
        steps++;
    }
    return steps;
}

// The files of the project as they were when the run started; every group of checks starts from them
const SECTIONS: AssetSection[] = ["scenes", "materials", "prefabs", "looks", "terrains", "biomes"];
const initial = new Map<string, unknown>();

async function reset() {
    store.stop();
    // A material is written a moment after its change
    await wait(350);
    for (const section of SECTIONS) {
        for (const name of await listAssets(PROJECT, section)) {
            if (!initial.has(`${section}/${name}`)) await deleteAsset(PROJECT, section, name);
        }
    }
    for (const [key, data] of initial) {
        const [section, name] = key.split("/") as [AssetSection, string];
        await writeAsset(PROJECT, section, name, data);
    }
    await openProject(PROJECT);
}

async function test(name: string, run: () => Promise<void> | void) {
    group = name;
    try {
        await reset();
        await run();
    } catch (e) {
        fail(`threw ${e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e)}`);
    }
}

async function run() {
    for (const section of SECTIONS) {
        for (const name of await listAssets(PROJECT, section)) initial.set(`${section}/${name}`, await readAsset(PROJECT, section, name));
    }

    await test("the project opens", () => {
        equal("project", store.project, PROJECT);
        equal("scene", store.sceneName, "main");
        equal("objects", store.entities.map((entity) => entity.name), ["Camera", "Box", "Holder", "Desk", "Room"]);
        equal("prefabs", store.registry.prefabNames().sort(), ["Desk", "Lamp", "Room"]);
        ok("the behavior of the project", store.registry.getBehavior("turn"));
        ok("not changed yet", !store.dirty && !store.canUndo);
        ok("what the instances bring is built", store.objectOf("d/Lamp/Shade") && store.objectOf("r/Desk/Lamp/Bulb/Glow"));
        near("where it stands", worldPosition("r/Desk/Lamp/Shade"), [13, 1.5, 0]);
        equal("the Console has no errors", editorLog.entries.filter((entry) => entry.level === "error").map((entry) => entry.text), []);
    });

    await test("edits of the scene, undo and redo", () => {
        const start = json();
        const added = store.addEntity("New", [{ type: "mesh", shape: "box" }]);
        settle();
        store.setTransform(added.id, "position", 0, 4);
        settle();
        store.rename(added.id, "Renamed");
        settle();
        store.addComponent(added.id, "collider");
        settle();
        store.setComponentField(added.id, "mesh", "shape", "sphere");
        settle();
        const copy = store.duplicate(added.id)!;
        settle();
        store.reparent("kid", null);
        settle();
        store.removeEntity(copy.id);
        settle();
        const end = json();

        const entity = real(added.id);
        equal("the new object", [entity?.name, entity?.position, entity?.components.map((c) => c.type)], ["Renamed", [4, 0, 0], ["mesh", "collider"]]);
        equal("its field", entity?.components[0].shape, "sphere");
        near("its three.js object", worldPosition(added.id), [4, 0, 0]);
        ok("the copy is gone", !real(copy.id) && !store.objectOf(copy.id));
        ok("a copy has another name", copy.name !== "Renamed");
        // Holder stands at z 5 turned by 90 degrees, Kid was one to its side: it stays where it was in the world
        ok("taken out of its parent", store.entities.some((other) => other.id === "kid"));
        near("where it is in the scene", real("kid")?.position, [0, 0, 4]);
        near("and how it is turned", real("kid")?.rotation, [0, 90, 0]);
        ok("the scene is changed", store.dirty);

        equal("steps", undoAll(), 8);
        equal("undo to the start", json(), start);
        ok("the object is gone with it", !store.objectOf(added.id));
        near("the child is back under its parent", worldPosition("kid"), [0, 0, 4]);
        equal("and has its own place there", real("kid")?.position, [1, 0, 0]);
        while (store.canRedo) store.redo();
        equal("redo to the end", json(), end);
        near("the object is back", worldPosition(added.id), [4, 0, 0]);
    });

    await test("selection, group, copy and paste", () => {
        const start = json();
        store.selectMany(["box", "hold"]);
        equal("two selected, the last is the main one", [store.selectedIds, store.selectedId], [["box", "hold"], "hold"]);
        store.groupSelected();
        const made = store.selected;
        equal("the group", [made?.name, made?.children.map((entity) => entity.id)], ["Group", ["box", "hold"]]);
        near("the group stands between them", made?.position, [0.5, 0, 2.5]);
        near("what is in it stays where it was", worldPosition("box"), [1, 0, 0]);
        near("and its children too", worldPosition("kid"), [0, 0, 4]);
        store.undo();
        equal("one step of undo", json(), start);

        store.select("box");
        const text = store.copySelected();
        ok("copied as JSON", text && (JSON.parse(text) as EntityData[])[0].name === "Box");
        equal("pasted", store.paste(), true);
        const pasted = store.selected;
        ok("the copy is another object", pasted && pasted.id !== "box" && pasted.name !== "Box");
        equal("with the same components", pasted?.components, real("box")?.components);
        equal("a hand-written object", store.paste('{ "name": "Typed", "position": [1, 2, 3] }'), true);
        equal("is read like a file", [store.selected?.name, store.selected?.position, store.selected?.scale], ["Typed", [1, 2, 3], [1, 1, 1]]);
        equal("not an object", store.paste("hello"), false);

        store.selectMany(["box", "hold"]);
        store.removeSelected();
        ok("both removed", !real("box") && !real("hold") && !real("kid"));
        store.select("d/Lamp/Shade");
        equal("something inside an instance is selected", store.selectedId, "d/Lamp/Shade");
    });

    await test("edits inside a prefab instance", () => {
        const start = json();
        store.setTransform("d/Lamp/Shade", "position", 1, 2);
        equal("a moved object is an override", real("d")?.overrides, { "Lamp/Shade": { position: [0, 2, 0] } });
        near("its three.js object", store.objectOf("d/Lamp/Shade")?.position.toArray(), [0, 2, 0]);
        ok("the Inspector can mark it", store.hasOverrides("d/Lamp/Shade") && !store.hasOverrides("d/Top"));
        store.setTransform("d/Lamp/Shade", "position", 1, 0.5);
        equal("back to the value of the prefab: no override", real("d")?.overrides, undefined);
        equal("and nothing is changed", json(), start);

        store.setComponentField("d/Lamp", "light", "intensity", 7);
        store.setComponentField("d", "mesh", "shape", "sphere");
        equal("fields of components", real("d")?.overrides, {
            Lamp: { components: { light: { intensity: 7 } } },
            ".": { components: { mesh: { shape: "sphere" } } },
        });
        store.revertOverrideField("d/Lamp", ["components", "light", "intensity"]);
        equal("one field back", Object.keys(real("d")?.overrides ?? {}), ["."]);
        store.revertOverrides("d");
        equal("all of them back", real("d")?.overrides, undefined);

        store.addComponent("d/Top", "light");
        store.removeComponent("d/Top", "collider");
        equal("added and removed components", real("d")?.overrides, { Top: { addComponents: [{ type: "light" }], removeComponents: ["collider"] } });
        equal("what the object has now", store.findEntity("d/Top")?.components.map((c) => c.type), ["mesh", "light"]);
        store.restoreComponent("d/Top", "collider");
        store.removeComponent("d/Top", "light");
        equal("both taken back", real("d")?.overrides, undefined);

        store.rename("d/Lamp/Bulb", "Big");
        equal("another name", real("d")?.overrides, { "Lamp/Bulb": { name: "Big" } });
        equal("shown", [store.findEntity("d/Lamp/Bulb")?.name, store.objectOf("d/Lamp/Bulb")?.name], ["Big", "Big"]);
        store.removeEntity("d/Lamp/Bulb");
        equal("left out", real("d")?.overrides, { "Lamp/Bulb": { removed: true } });
        ok("its objects are gone", !store.objectOf("d/Lamp/Bulb") && !store.objectOf("d/Lamp/Bulb/Glow"));
        equal("listed as removed", store.removedUnder("d/Lamp"), ["Bulb"]);
        store.restoreRemoved("d/Lamp", "Bulb");
        ok("brought back", store.objectOf("d/Lamp/Bulb/Glow") && real("d")?.overrides === undefined);

        const cup = store.addEntity("Cup", [], "d/Top");
        equal("a child under an object of the prefab", [cup.id, real("d")?.overrides?.Top.addChildren?.map((entity) => entity.name)], ["d/Top/Cup", ["Cup"]]);
        ok("is a real object", real("d/Top/Cup") && store.objectOf("d/Top/Cup") && !store.isInner("d/Top/Cup"));
        store.setTransform("d/Top/Cup", "position", 1, 1);
        equal("changed right there", real("d")?.overrides?.Top.addChildren?.[0].position, [0, 1, 0]);
        store.rename("d/Top/Cup", "Mug");
        ok("its id follows its name", real("d/Top/Mug") && store.objectOf("d/Top/Mug") && !store.objectOf("d/Top/Cup"));

        store.reparent("box", "d/Top");
        ok("an object of the scene moved into the instance", real("d/Top/Box") && !real("box"));
        near("stays where it was", worldPosition("d/Top/Box"), [1, 0, 0]);
        store.reparent("d/Top/Box", null);
        const out = store.entities.find((entity) => entity.name === "Box");
        ok("and out again, with an ordinary id", out && !out.id.includes("/"));
        near("still there", out?.position, [1, 0, 0]);

        store.select("d/Top");
        const [twin] = store.duplicateSelected();
        ok("a copy of an object of the prefab is one the instance adds", twin && real("d")?.overrides?.["."].addChildren?.some((entity) => entity.id === twin.id));

        store.setTransform("r/Desk/Lamp/Shade", "rotation", 1, 45);
        equal("through two prefabs", real("r")?.overrides, { "Desk/Lamp/Shade": { rotation: [0, 45, 0] } });
        near("the override of the desk is under it", store.objectOf("r/Desk/Lamp/Shade")?.scale.toArray(), [2, 2, 2]);

        ok("undo", undoAll() > 0);
        // The id of Box was made anew when it left the instance
        equal("back to the start", store.entities.map((entity) => [entity.name, entity.overrides]), (JSON.parse(start) as SceneData).entities.map((entity) => [entity.name, entity.overrides]));
    });

    await test("unpack", () => {
        store.setTransform("d/Lamp/Shade", "position", 0, 3);
        store.setTransform("d/Top", "position", 0, 4);
        store.unpack("d");
        const desk = real("d");
        ok("an ordinary object", desk && !desk.prefab && !desk.overrides);
        equal("with the content of the prefab", [desk?.components.map((c) => c.type), desk?.children.map((entity) => entity.name)], [["mesh"], ["Top", "Lamp"]]);
        equal("and what the instance changed", child(desk, "Top")?.position, [4, 1, 0]);
        const lamp = child(desk, "Lamp");
        equal("the prefab inside stays an instance", [lamp?.prefab, lamp?.children], ["Lamp", []]);
        equal("with both overrides", lamp?.overrides?.Shade, { scale: [2, 2, 2], position: [3, 0.5, 0] });
        ok("its objects are found by the new ids", lamp && store.objectOf(`${lamp.id}/Shade`));
        store.undo();
        ok("undo makes it an instance again", real("d")?.prefab === "Desk" && store.objectOf("d/Lamp/Shade"));
    });

    await test("Apply", async () => {
        const before = await prefabFile("Desk");
        const lampBefore = await prefabFile("Lamp");
        store.setTransform("d/Top", "position", 0, 4);
        store.setTransform("d/Lamp/Shade", "position", 1, 3);
        settle();

        await applyOverrides("d/Top");
        equal("one object: the file", child(await prefabFile("Desk"), "Top")?.position, [4, 1, 0]);
        equal("its override is gone, the other stays", real("d")?.overrides, { "Lamp/Shade": { position: [0, 3, 0] } });
        equal("the other instance follows", store.findEntity("r/Desk/Top")?.position, [4, 1, 0]);
        near("and its three.js object", worldPosition("r/Desk/Top"), [17, 1, 0]);
        near("this one looks the same", worldPosition("d/Top"), [1, 1, 0]);
        settle();

        await applyOverrides("d");
        const lamp = child(await prefabFile("Desk"), "Lamp");
        equal("all: the override has become that of the lamp in the desk", lamp?.overrides?.Shade, { scale: [2, 2, 2], position: [0, 3, 0] });
        equal("the instance has no overrides", real("d")?.overrides, undefined);
        near("the other instance follows", store.objectOf("r/Desk/Lamp/Shade")?.position.toArray(), [0, 3, 0]);
        equal("the lamp prefab is not written", await prefabFile("Lamp"), lampBefore);
        ok("the file of the desk is changed", plain(await prefabFile("Desk")) !== plain(before));

        // Each Apply is two steps: the instance gets its changes back, then the prefab its old content
        equal("steps", undoAll(), 5);
        await until("undo: the file is as it was", async () => plain(await prefabFile("Desk")) === plain(before));
        equal("undo: the prefab in the editor", plain(store.registry.getPrefab("Desk")!), plain(before));
        ok("undo: nothing is changed", !store.dirty && real("d")?.overrides === undefined);
        near("undo: the other instance", worldPosition("r/Desk/Top"), [13, 1, 0]);
    });

    await test("Create Prefab", async () => {
        await createPrefab("hold");
        equal("the file", [(await prefabFile("Holder")).name, (await prefabFile("Holder")).children.map((entity) => entity.name)], ["Holder", ["Kid"]]);
        equal("its root stands at zero", (await prefabFile("Holder")).position, [0, 0, 0]);
        const instance = real("hold");
        equal("the object is an instance", [instance?.prefab, instance?.children, instance?.position], ["Holder", [], [0, 0, 5]]);
        near("and looks the same", worldPosition("hold/Kid"), [0, 0, 4]);
        store.undo();
        ok("undo: an object again", !real("hold")?.prefab && real("kid"));
        store.undo();
        await until("undo: the file is gone", async () => !(await listAssets(PROJECT, "prefabs")).includes("Holder"));
        ok("and the prefab", !store.registry.getPrefab("Holder"));
    });

    await test("editing a prefab", async () => {
        store.setTransform("box", "position", 0, 2);
        store.openPrefab("Lamp");
        equal("the prefab alone", [store.editingPrefab, store.entities.map((entity) => entity.name)], ["Lamp", ["Lamp"]]);
        ok("with a history of its own", !store.canUndo && !store.dirty);
        const shade = child(store.entities[0], "Shade")!;
        store.setTransform(shade.id, "position", 0, 1);
        ok("changed", store.dirty);
        await closePrefab();
        equal("saved on the way out", child(await prefabFile("Lamp"), "Shade")?.position, [1, 0.5, 0]);
        equal("the scene is back", [store.editingPrefab, store.entities.length], [null, 5]);
        ok("with its change and its history", real("box")?.position[0] === 2 && store.canUndo && store.dirty);
        near("its instances show the prefab", store.objectOf("d/Lamp/Shade")?.position.toArray(), [1, 0.5, 0]);
        near("through two prefabs too", store.objectOf("r/Desk/Lamp/Shade")?.position.toArray(), [1, 0.5, 0]);
    });

    await test("Play", () => {
        const start = json();
        store.play();
        ok("runs, in the Game view", store.playing && store.hasGameCamera && store.gameView);
        store.togglePause();
        ok("paused", store.paused);
        const game = store.runningGame!;
        const box = game.root.getObjectByName("Box")!;
        const turned = box.rotation.y;
        for (let i = 0; i < 30; i++) store.step();
        // The behavior turns it by 90 degrees a second, a step is 1/60 s
        near("30 steps of the behavior", [box.rotation.y - turned], [Math.PI / 4]);
        equal("the scene being edited is not touched", [real("box")?.rotation, json()], [[0, 0, 0], start]);
        const ids: string[] = [];
        game.root.traverse((object) => {
            if (typeof object.userData.innerId === "string") ids.push(object.userData.innerId);
        });
        ok("what the instances bring runs too", ids.includes("r/Desk/Lamp/Shade") && ids.includes("d/Lamp/Bulb/Glow"));

        store.setTransform("box", "position", 1, 5);
        near("an edit during Play reaches the running copy", [box.position.y], [5]);
        store.requestStop();
        ok("Stop asks about the edit", store.confirmingStop && store.playing);
        store.cancelStop();
        store.stop();
        equal("Stop without keeping", [store.playing, json()], [false, start]);

        store.play();
        store.setTransform("box", "position", 1, 5);
        store.setTransform("d/Top", "position", 0, 4);
        store.stop(true);
        equal("Stop that keeps the edits", [store.playing, real("box")?.position, real("d")?.overrides], [false, [1, 5, 0], { Top: { position: [4, 1, 0] } }]);
        ok("the scene is changed", store.dirty);
    });

    await test("saving", async () => {
        store.setTransform("box", "position", 1, 5);
        store.setTransform("d/Lamp/Shade", "position", 1, 2);
        await save();
        const file = (await readAsset(PROJECT, "scenes", "main")) as SceneData;
        equal("the file", [child({ children: file.entities } as EntityData, "Box")?.position, file.entities.find((entity) => entity.id === "d")?.overrides], [[1, 5, 0], { "Lamp/Shade": { position: [0, 2, 0] } }]);
        ok("nothing left to save", !store.dirty);
        store.undo();
        ok("an undo after that is a change again", store.dirty);
    });

    await test("a material", async () => {
        updateMaterial("Red", "color", "#00ff00");
        equal("at once in the editor", store.registry.getMaterialData("Red")?.color, "#00ff00");
        await until("and in the file", async () => ((await readAsset(PROJECT, "materials", "Red")) as { color: string }).color === "#00ff00");
        store.undo();
        equal("undo in the editor", store.registry.getMaterialData("Red")?.color, "#ff0000");
        await until("and in the file", async () => ((await readAsset(PROJECT, "materials", "Red")) as { color: string }).color === "#ff0000");
    });

    await test("a terrain", async () => {
        const ground = store.addEntity("Ground", [{ type: "terrain" }]);
        settle();
        store.select(ground.id);
        equal("without an asset it shows the level piece", store.terrainTarget?.name, "");
        const name = await createTerrainAsset(ground.id);
        equal("a new terrain", [name, store.registry.terrainNames()], ["Terrain", ["Terrain"]]);
        equal("is on the object", store.findEntity(ground.id)?.components[0].terrain, "Terrain");
        await until("and in its file", async () => (await listAssets(PROJECT, "terrains")).includes("Terrain"));
        // null while the server is in the middle of writing it
        const file = async () => (await readAsset(PROJECT, "terrains", "Terrain").catch(() => null)) as TerrainData | null;
        const data = () => store.registry.getTerrain("Terrain")!;
        equal("64 x 64 m, painted with the first color", [terrainSize(data()), data().colors?.[0][0], data().palette?.length], [[64, 64], 0, 5]);
        // The height the mesh of the object shows at the middle of the ground
        const shown = () => {
            const mesh = store.terrainTarget!.mesh;
            const rows = data().heights.length;
            const columns = data().heights[0].length;
            return Math.round(mesh.geometry.getAttribute("position").getY(((rows - 1) / 2) * columns + (columns - 1) / 2) * 100) / 100;
        };
        equal("its mesh is the one of the object", [store.terrainMeshes("Terrain").length, shown()], [1, 0]);

        // A stroke, the way the brush makes it: a copy is worked and given back
        settle();
        const before = data();
        const worked = cloneTerrain(before);
        brushTerrain(worked, "raise", 0, 0, 4, 2);
        strokeTerrain("Terrain", before, worked);
        equal("a stroke: the terrain is what the brush left", data().heights[32][32], 2);
        await until("and so is the file", async () => (await file())?.heights[32][32] === 2);
        const again = cloneTerrain(data());
        brushTerrain(again, "raise", 0, 0, 4, 1);
        strokeTerrain("Terrain", data(), again);
        equal("a second stroke right after", data().heights[32][32], 3);
        store.undo();
        equal("is a step of its own", [data().heights[32][32], shown()], [2, 2]);
        store.undo();
        equal("undo of the first", [data().heights[32][32], shown()], [0, 0]);
        await until("in the file too", async () => (await file())?.heights[32][32] === 0);
        store.redo();
        equal("redo", [data().heights[32][32], shown()], [2, 2]);

        setTerrainPalette("Terrain", [...data().palette!, "#123456"]);
        equal("one more color", data().palette?.length, 6);
        const painted = cloneTerrain(data());
        brushTerrain(painted, "paint", 0, 0, 2, 0, { color: 5 });
        strokeTerrain("Terrain", data(), painted);
        equal("painted with it", data().colors?.[32][32], 5);
        settle();
        setTerrainPalette("Terrain", data().palette!.slice(0, -1));
        equal("the color is removed: its ground gets the first one", [data().palette?.length, data().colors?.[32][32]], [5, 0]);

        settle();
        resizeTerrainAsset("Terrain", 32, 48, 2);
        equal("resized", [terrainSize(data()), data().heights.length, data().heights[0].length], [[32, 48], 25, 17]);
        equal("the hill is where it was, and the mesh is made anew", [data().heights[12][8], shown()], [2, 2]);
        store.undo();
        equal("undo of the resize", terrainSize(data()), [64, 64]);

        // Generating: the settings go into the file, the ground is made by them, undo takes it back
        settle();
        const mesh = store.terrainTarget!.mesh;
        setTerrainGenerator("Terrain", { seed: 5, height: 30 });
        equal("the settings of the generator are kept with the terrain", [data().generator, data().heights[32][32]], [{ seed: 5, height: 30 }, 2]);
        ok("changing them builds nothing anew", store.terrainTarget!.mesh === mesh && (mesh.userData.terrain as { data: TerrainData }).data === data());
        await until("and they are in the file", async () => (await file())?.generator?.seed === 5);
        settle();
        generateTerrainAsset("Terrain", { x: 0, z: 0 });
        const made = data().heights.map((row) => [...row]);
        const spread = Math.max(...made.flat()) - Math.min(...made.flat());
        ok(`generated: hills (${spread.toFixed(1)} m from the lowest to the highest)`, spread > 8);
        equal("the mesh shows them", shown(), made[32][32]);
        store.undo();
        equal("undo gives the ground back, the settings stay", [data().heights[32][32], data().generator?.seed], [2, 5]);
        store.redo();
        equal("redo", data().heights[32][32], made[32][32]);
        generateTerrainAsset("Terrain", { x: 0, z: 0 });
        equal("the same settings give the same ground again", data().heights, made);

        // A biome: an asset of its own that the terrain names
        settle();
        const biome = await createBiome("Terrain");
        equal("a new biome", [biome, store.registry.biomeNames(), data().generator?.biome], ["Biome", ["Biome"], "Biome"]);
        await until("is in its file", async () => (await listAssets(PROJECT, "biomes")).includes("Biome"));
        settle();
        updateBiome("Biome", { ...store.registry.getBiome("Biome"), base: 50, ground: "#112233", props: [{ prefab: "Lamp", spacing: 8 }] });
        equal("changed in the editor", store.registry.getBiome("Biome")?.base, 50);
        await until("and in the file", async () => ((await readAsset(PROJECT, "biomes", "Biome").catch(() => null)) as { base?: number } | null)?.base === 50);
        ok("the ground waits for Generate", Math.abs(data().heights[32][32]) < 20);
        settle();
        generateTerrainAsset("Terrain", { x: 0, z: 0 });
        ok(`generated by the biome: the land lies where it says (${data().heights[32][32]})`, data().heights[32][32] > 35);
        ok("painted with its color", data().palette?.includes("#112233"));
        const lamps = data().scatter?.find((layer) => layer.prefab === "Lamp")?.items.length ?? 0;
        ok(`and its props stand on it (${lamps})`, lamps > 20);
        const drawnProps = store.terrainTarget!.mesh.children.find((child) => child.userData.scatter)?.children as THREE.InstancedMesh[] | undefined;
        ok("drawn as copies", (drawnProps?.length ?? 0) > 0 && drawnProps!.every((mesh) => mesh.count === lamps));
        // The ground remembers that all of it is this biome: a mound made by hand on it does not outlive Generate
        equal("where the biome lies is written down", [data().biomes, data().biomeMap?.[0][0]], [["Biome"], 0]);
        const dug = cloneTerrain(data());
        brushTerrain(dug, "raise", 0, 0, 4, 30);
        strokeTerrain("Terrain", data(), dug);
        const before2 = data().heights[32][32];
        generateTerrainAsset("Terrain", { x: 0, z: 0 });
        ok("Generate makes the land of the biome again", data().heights[32][32] < before2 - 20);
        generateTerrainAsset("Terrain", { x: 0, z: 0 }, true);
        equal("Fill: the whole ground is the biome named now", data().biomeMap?.every((row) => row.every((k) => k === 0)), true);
        // A river: two clicks of its brush
        settle();
        editRivers("Terrain", (rivers, ground) => void addRiverPoint({ ...ground, rivers }, 0, -20, 0));
        settle();
        editRivers("Terrain", (rivers, ground) => void addRiverPoint({ ...ground, rivers }, 0, 20, 0));
        const level = data().rivers?.[0].points[0][2] ?? 0;
        ok(`a river: its bed is cut into the ground (water at ${level}, bed at ${data().heights[32][12]})`, data().rivers?.[0].points.length === 2 && Math.abs(data().heights[32][12] - (level - 1.2)) < 0.1);
        ok("its water is drawn", store.terrainTarget!.mesh.children.some((child) => child.userData.rivers && child.children.length === 1));
        ok("and nothing stands in it", (data().scatter ?? []).every((layer) => layer.items.every(([x, z]) => !(Math.abs(x) < 18 && Math.abs(z) < 2))));
        settle();
        editRivers("Terrain", (rivers) => void (rivers[0] = { ...rivers[0], width: 10 }));
        equal("a wider one", data().rivers?.[0].width, 10);
        // Ctrl + click on the ground, then the new point dragged by its mark (as the brush does it)
        settle();
        editRivers("Terrain", (rivers, ground) => void insertRiverPoint({ ...ground, rivers }, 0, 0, 3));
        equal("a point put into the line", data().rivers?.[0].points.map(([x, z]) => [x, z]), [[-20, 0], [0, 3], [20, 0]]);
        settle();
        const dragged = data().rivers!.map((river) => ({ ...river, points: river.points.map((point, n) => (n === 1 ? [0, 8, point[2]] as RiverPoint : point)) }));
        editRivers("Terrain", (rivers) => void rivers.splice(0, rivers.length, ...dragged));
        ok(`a point moved: the bed is cut where it is now (${data().heights[40][32]} under water at ${level})`, data().rivers?.[0].points[1][1] === 8 && data().heights[40][32] < level - 1);
        ok("its water is drawn there", store.terrainTarget!.mesh.children.some((child) => child.userData.rivers && child.children.length === 1));
        store.undo();
        equal("undo puts the point back", data().rivers?.[0].points[1].slice(0, 2), [0, 3]);
        store.undo();
        store.undo();
        store.undo();
        store.undo();
        equal("undo takes the river away", data().rivers, undefined);
        store.undo();
        store.undo();
        store.undo();
        store.undo();
        equal("undo takes the land back, props and all", [data().scatter, data().heights[32][32] < 20], [undefined, true]);
        store.undo();
        equal("undo of the change of the biome", store.registry.getBiome("Biome")?.base, 0);

        // The assets as the Project panel handles them: a copy, another name (with what refers to it), deleting
        settle();
        await save();
        await duplicateGround("terrain", "Terrain");
        equal("a copy of a terrain", [store.registry.terrainNames(), store.selectedAsset], [["Terrain", "Terrain_1"], { kind: "terrain", name: "Terrain_1" }]);
        addTerrainToScene("Terrain_1");
        equal("is put into the scene as an object of its own", [store.selected?.name, store.terrainTarget?.name], ["Terrain_1", "Terrain_1"]);
        store.undo();
        await renameGround("terrain", "Terrain", "Land");
        equal("renamed: the object of the scene names the new one", [store.registry.terrainNames(), store.findEntity(ground.id)?.components[0].terrain], [["Land", "Terrain_1"], "Land"]);
        await until("so does the scene file", async () => JSON.stringify(await readAsset(PROJECT, "scenes", "main")).includes('"terrain":"Land"'));
        ok("and the files are the new ones", (await listAssets(PROJECT, "terrains")).sort().join() === "Land,Terrain_1");
        await renameGround("biome", "Biome", "Hills");
        equal("a biome renamed: the terrain that names it follows", [store.registry.biomeNames(), store.registry.getTerrain("Land")?.generator?.biome], [["Hills"], "Hills"]);
        await until("in its file too", async () => ((await readAsset(PROJECT, "terrains", "Land").catch(() => null)) as TerrainData | null)?.generator?.biome === "Hills");
        store.undo();
        await until("undo of the rename", async () => store.registry.biomeNames().join() === "Biome" && store.registry.getTerrain("Land")?.generator?.biome === "Biome");
        await deleteGround("terrain", "Terrain_1");
        equal("deleted", store.registry.terrainNames(), ["Land"]);
        store.undo();
        equal("and back with undo", store.registry.terrainNames(), ["Land", "Terrain_1"]);
        await until("with its file", async () => (await listAssets(PROJECT, "terrains")).includes("Terrain_1"));
        await deleteGround("biome", "Biome");
        equal("a biome deleted", store.registry.biomeNames(), []);
        store.undo();
        equal("and back", store.registry.biomeNames(), ["Biome"]);
        await renameGround("terrain", "Land", "Terrain");

        store.setTerrainEdit(true);
        store.setColliderEdit(true);
        ok("one editing tool at a time", !store.terrainEdit && store.colliderEdit);
        store.setTerrainEdit(true);
        ok("and the other way", store.terrainEdit && !store.colliderEdit);
        store.setTerrainEdit(false);
        store.setColliderEdit(false);
        store.setBiomeView(true);
        store.setBrush({ tool: "biome" });
        equal("the map of the biomes is asked for, the Biome brush is in hand", [store.biomeView, store.brush.tool], [true, "biome"]);
        store.setBiomeView(false);
        store.setBrush({ tool: "raise" });
        equal("the Console has no errors", editorLog.entries.filter((entry) => entry.level === "error").map((entry) => entry.text), []);
    });

    await test("a world", async () => {
        // Far enough to see every piece wherever the camera of the viewport is
        const land = store.addEntity("Land", [{ type: "world", distance: 100000 }]);
        settle();
        store.select(land.id);
        await createWorldPiece(land.id, 32);
        const piece = (name: string) => store.registry.getTerrain(name)!;
        equal("the first piece of a world, and the world gets a name", [store.findEntity(land.id)?.components[0].world, terrainSize(piece("World_0_0"))], ["World", [32, 32]]);
        await until("in its file", async () => (await listAssets(PROJECT, "terrains")).includes("World_0_0"));
        updateWorlds(store.root, null);
        equal("it is shown, and it is what the brush works", store.terrainTarget?.name, "World_0_0");
        // A hill on its edge towards +X
        settle();
        const hill = cloneTerrain(piece("World_0_0"));
        brushTerrain(hill, "raise", 16, 0, 6, 3);
        strokeTerrain("World_0_0", piece("World_0_0"), hill);
        await createPiece(land.id, 1, 0);
        equal("a new piece beside it goes on from its edge", piece("World_1_0").heights.map((row) => row[0]), hill.heights.map((row) => row[32]));
        equal("each of its rows going on level from there", piece("World_1_0").heights[16][31], hill.heights[16][32]);
        updateWorlds(store.root, null);
        equal("both are shown, the new one is picked", [store.worldMarker(land.id)?.shown.size, store.terrainTarget?.name], [2, "World_1_0"]);
        equal("a good world", validateWorld(store.registry, "World"), []);
        // Each with its own seed: their edges would not meet by themselves
        settle();
        setTerrainGenerator("World_0_0", { seed: 3, height: 10 });
        setTerrainGenerator("World_1_0", { seed: 4, height: 10 });
        settle();
        generateWorld(land.id);
        const edges = () => [piece("World_0_0").heights.map((row) => row[32]), piece("World_1_0").heights.map((row) => row[0])];
        ok(`Generate World makes the pieces anew (${piece("World_0_0").heights[16][16]})`, piece("World_0_0").heights[16][16] !== hill.heights[16][16]);
        equal("and their edges meet", edges()[0], edges()[1]);
        equal("still a good world", validateWorld(store.registry, "World"), []);
        store.undo();
        equal("undo puts both back at once", [piece("World_0_0").heights, piece("World_1_0").heights.map((row) => row[0])], [hill.heights, hill.heights.map((row) => row[32])]);
        // One piece: its edges meet the neighbor, which changes only there
        const before = piece("World_0_0").heights.map((row) => [...row]);
        generateWorld(land.id, ["World_1_0"]);
        equal("Generate of one piece makes it meet its neighbor", edges()[0], edges()[1]);
        ok("which keeps the rest of its ground", piece("World_0_0").heights.every((row, j) => row.every((height, i) => i === 32 || height === before[j][i])));
        store.undo();
        // The scene is built again after an undo: the viewport shows the pieces in its next frame
        updateWorlds(store.root, null);
        store.setPieceTarget("World_0_0");
        equal("the piece the Inspector shows is picked", store.terrainTarget?.name, "World_0_0");

        // A built game loads the pieces when the camera comes near them, and lets them go when it leaves
        const asked: string[] = [];
        const lazy = new Registry();
        for (const name of ["World_0_0", "World_1_0"]) {
            const data = piece(name);
            lazy.setTerrainLater(name, 32, async () => {
                asked.push(name);
                return data;
            });
        }
        const game = new Game(lazy, parseScene({ version: 3, entities: [
            { name: "Land", components: [{ type: "world", world: "World", distance: 5 }] },
            { name: "Eye", position: [0, 20, 0], components: [{ type: "camera" }] },
            { name: "Faller", position: [0, 30, 0], components: [{ type: "collider" }, { type: "body" }] },
        ] }));
        game.sound.enabled = false;
        const shownPieces = () => {
            const names: string[] = [];
            game.root.traverse((object) => void (object.userData.terrainName && names.push(object.userData.terrainName as string)));
            return names;
        };
        try {
            game.start();
            game.update(1 / 60);
            equal("only the piece near the camera is asked for", asked, ["World_0_0"]);
            equal("and until it is there the game waits", game.root.getObjectByName("Faller")!.position.y, 30);
            await until("it comes", async () => {
                game.update(1 / 60);
                return lazy.getTerrain("World_0_0") !== undefined && shownPieces().includes("World_0_0");
            });
            game.update(1 / 60);
            ok("then the game goes on", game.root.getObjectByName("Faller")!.position.y < 30);
            game.root.getObjectByName("Eye")!.position.x = 32;
            await until("the camera goes to the other piece: it is loaded, the first one let go", async () => {
                game.update(1 / 60);
                return lazy.getTerrain("World_1_0") !== undefined && lazy.getTerrain("World_0_0") === undefined;
            });
            equal("both were asked for once each", asked, ["World_0_0", "World_1_0"]);
        } finally {
            game.dispose();
        }
        equal("the Console has no errors", editorLog.entries.filter((entry) => entry.level === "error").map((entry) => entry.text), []);
    });

    await test("an animation clip", () => {
        const start = json();
        ok("the clip of the project", store.registry.getClip("Slide"));
        store.addClip("kid", "Slide");
        equal("the component", real("kid")?.components, [{ type: "animation", clip: "Slide" }]);
        equal("is listed as a user of the clip", store.usersOf("clip", "Slide").map((entity) => entity.id), ["kid"]);
        store.undo();
        equal("one step of undo", json(), start);
        store.redo();

        store.play();
        store.togglePause();
        const kid = store.runningGame!.root.getObjectByName("Kid")!;
        // The first step puts the object where the clip says, whatever place it had
        store.step();
        const from = kid.position.x;
        for (let i = 0; i < 15; i++) store.step();
        // Two meters a second, a quarter of a second
        near("the clip moves the object in Play", [kid.position.x - from], [0.5]);
        equal("and not the scene being edited", real("kid")?.position, [1, 0, 0]);
        store.stop();
    });

    await test("a model file", async () => {
        const robot = store.addEntity("Robot", [{ type: "gltf", file: "robot.glb" }]);
        await until("the file is loaded", () => store.registry.modelClipNames("robot.glb") !== null);
        const clips = store.registry.modelClipNames("robot.glb") ?? [];
        equal("its clips", [...clips].sort(), ["Walk", "Wave"]);
        equal("are what the Inspector offers for the field", componentDefs.gltf.choices?.("animation", robot.components[0], store.registry, () => {}), clips);
        equal("and for no other field", componentDefs.gltf.choices?.("file", robot.components[0], store.registry, () => {}), null);

        settle();
        store.addComponent(robot.id, "collider");
        const collider = real(robot.id)?.components.find((c) => c.type === "collider") as Record<string, number> | undefined;
        // The robot stands on the ground and is taller than it is wide: not the default cube of one meter
        ok("a new collider is put around the model", collider && collider.sizeY > collider.sizeX && collider.centerY > 0.1 && Math.abs(collider.centerY - collider.sizeY / 2) < 0.05);
        store.undo();
        ok("one step of undo", real(robot.id)?.components.length === 1);
        store.addComponent("box", "collider");
        equal("a mesh keeps the default one", real("box")?.components.find((c) => c.type === "collider"), { type: "collider" });
        equal("Fit on a mesh", [store.fitCollider("box"), (real("box")?.components.find((c) => c.type === "collider") as Record<string, number>).sizeX], [true, 1]);
        equal("nothing to fit to", store.fitCollider("kid"), false);

        // The clip the component names plays while the scene is edited: the parts of the model move
        store.setComponentField(robot.id, "gltf", "animation", "Wave");
        const pose = () => {
            let sum = 0;
            store.objectOf(robot.id)?.traverse((part) => {
                sum += part.quaternion.x + part.quaternion.y + part.quaternion.z + part.position.y;
            });
            return sum;
        };
        const before = pose();
        await until("the model moves in the viewport", () => Math.abs(pose() - before) > 1e-4);
        equal("the entity itself stays where it is", real(robot.id)?.position, [0, 0, 0]);

        store.setComponentField(robot.id, "gltf", "animation", "");
        store.addComponent(robot.id, "animator", "bot");
        equal("the animator component", real(robot.id)?.components.find((c) => c.type === "animator"), { type: "animator", animator: "bot" });
        store.play();
        store.togglePause();
        store.step();
        const running = store.runningGame!.root.getObjectByName("Robot")!;
        const animator = animatorOf(running);
        equal("the start state plays its clip of the file", [animator?.state, animationOf(running, store.registry).playing], ["Wave", "Wave"]);
        animator?.set("walking", true);
        store.step();
        equal("a param leads to the other state", [animator?.state, animationOf(running, store.registry).playing], ["Walk", "Walk"]);
        store.stop();
    });

    await test("a shader that does not compile", async () => {
        const errors = () => editorLog.entries.filter((entry) => entry.level === "error").map((entry) => entry.text);
        equal("nothing before", errors(), []);
        store.setEnvironment("look", "Broken");
        // The viewport draws the next frame with the look and the driver refuses its effect
        await until("the Console names the effect and the line", () => errors().some((text) => text.includes(`Shader error in effect "broken", line 1: 'nothing'`)));
        equal("in a few words", errors().filter((text) => text.length > 400), []);
    });

    await reset();
}

function send(body: unknown) {
    return fetch("/__test/done", { method: "POST", body: JSON.stringify(body) });
}

window.addEventListener("error", (e) => failures.push(`an error on the page: ${e.message}`));
window.addEventListener("unhandledrejection", (e) => failures.push(`an error on the page: ${String((e.reason as Error | undefined)?.message ?? e.reason)}`));

// The editor starts by itself; when it has listed the projects, the checks begin
(async () => {
    for (let i = 0; i < 200 && !store.projects.includes(PROJECT); i++) await wait(50);
    if (!store.projects.includes(PROJECT)) return send({ failures: [`the editor did not start: no project "${PROJECT}" (it has: ${store.projects.join(", ") || "none"})`], checks });
    try {
        await run();
    } catch (e) {
        failures.push(`the run stopped: ${e instanceof Error ? e.message : String(e)}`);
    }
    return send({ failures, checks });
})();
