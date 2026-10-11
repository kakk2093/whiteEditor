import * as THREE from "three";
import type { Registry } from "./Registry";
import type { Vec3 } from "./types";

// Sound of the running game. A sound is an audio file of the project's assets/ folder, named with its
// extension: "coin.wav". Behaviors play one with self.playSound("coin.wav"); an entity plays one with its
// Sound component. Loudness by distance and left / right are counted here, from where the camera is (or the
// entity with a Sound Listener component).

// The audio files assets/ can hold
export const SOUND_FILE = /\.(mp3|ogg|wav)$/i;

export interface SoundOptions {
    // 1 is the file as it is, 0 is silence
    volume?: number;
    // Speed of playing: 2 is twice as fast and an octave higher
    pitch?: number;
    // Starts again when it ends, until it is stopped
    loop?: boolean;
    // Where in the world the sound comes from: a point, or an object it stays with. Then it gets quieter
    // with the distance from the camera. Without it the sound is heard the same everywhere.
    at?: THREE.Vector3 | Vec3 | THREE.Object3D;
    // With `at`: the distance from the camera, meters, at which nothing is heard any more
    range?: number;
}

// A sound that was started
export interface SoundHandle {
    // Can be changed while it plays
    volume: number;
    // false once it has ended or was stopped
    readonly playing: boolean;
    stop: () => void;
}

// What a file has turned out to be: its decoded samples, "element" if it can only be played by an <audio>
// element (a game opened straight from the disk cannot fetch its files), null if it cannot be played at all
type Loaded = AudioBuffer | "element" | null;

// One context for the page: browsers allow only a few
let context: AudioContext | null = null;

// By address, so the files of a project are decoded once however many times it is played
const files = new Map<string, Loaded | Promise<Loaded>>();

function audioContext() {
    if (typeof AudioContext === "undefined") return null;
    if (!context) {
        context = new AudioContext();
        // A page may not make a sound before the user has touched it: the context waits, and what was
        // started in the meantime begins at the first key or click
        const unlock = () => {
            if (context?.state === "suspended") context.resume().catch(() => {});
        };
        window.addEventListener("pointerdown", unlock, true);
        window.addEventListener("keydown", unlock, true);
    }
    return context;
}

function load(url: string): Loaded | Promise<Loaded> {
    let file = files.get(url);
    if (file === undefined) {
        const ctx = audioContext()!;
        file = fetch(url)
            .then((response) => {
                if (!response.ok) throw new Error(String(response.status));
                return response.arrayBuffer();
            })
            .then(
                (data) => ctx.decodeAudioData(data).catch(() => {
                    console.warn(`Sound "${url}" is not an audio file the browser can play`);
                    return null;
                }),
                () => "element" as const
            )
            .then((loaded) => {
                files.set(url, loaded);
                return loaded;
            });
        files.set(url, file);
    }
    return file;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

class Voice implements SoundHandle {
    volume: number;

    playing = true;

    // The loudness the distance leaves (0..1) and the side it comes from (-1 left .. 1 right)
    private near = 1;

    private side = 0;

    private pitch: number;

    private loop: boolean;

    private source?: AudioBufferSourceNode;

    private gain?: GainNode;

    private panner?: StereoPannerNode;

    private element?: HTMLAudioElement;

    private paused = false;

    readonly at?: THREE.Vector3 | THREE.Object3D;

    readonly range: number;

    private player: SoundPlayer;

    private ended: () => void;

    constructor(player: SoundPlayer, options: SoundOptions, ended: () => void) {
        this.player = player;
        this.ended = ended;
        this.volume = options.volume ?? 1;
        this.pitch = options.pitch ?? 1;
        this.loop = options.loop ?? false;
        this.at = Array.isArray(options.at) ? new THREE.Vector3(...options.at) : options.at;
        this.range = options.range ?? 20;
    }

    // The file has come: the sound begins, unless it was stopped while waiting
    start(loaded: Loaded, url: string, paused: boolean) {
        if (!this.playing) return;
        const ctx = audioContext();
        if (!loaded || !ctx) return this.stop();

        if (loaded === "element") {
            const element = new Audio(url);
            element.loop = this.loop;
            element.preservesPitch = false;
            element.addEventListener("ended", () => this.stop());
            element.addEventListener("error", () => this.stop());
            this.element = element;
        } else {
            this.source = ctx.createBufferSource();
            this.source.buffer = loaded;
            this.source.loop = this.loop;
            this.source.onended = () => this.stop();
            this.gain = ctx.createGain();
            this.panner = ctx.createStereoPanner();
            this.source.connect(this.gain).connect(this.panner).connect(ctx.destination);
        }
        this.paused = !paused;
        this.setPaused(paused);
        this.apply(true);
        this.source?.start();
    }

    // Where the sound is heard from: how far it is from the `ears`, and on which side of them as the camera
    // sees it. Without a camera it is heard as it is.
    hear(camera: THREE.Camera | null, ears: THREE.Object3D | null) {
        if (!this.at || !this.playing) return;
        if (!camera || !ears) {
            this.near = 1;
            this.side = 0;
        } else {
            const to = (this.at instanceof THREE.Vector3 ? this.at.clone() : this.at.getWorldPosition(new THREE.Vector3()))
                .sub(ears.getWorldPosition(new THREE.Vector3()));
            const distance = to.length();
            this.near = clamp(1 - distance / this.range, 0, 1) ** 2;
            // Right next to the ears a sound has no side
            const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
            this.side = distance > 1e-6 ? (to.dot(right) / distance) * Math.min(1, distance) : 0;
        }
        this.apply();
    }

    // Sets the loudness of the playing sound; `now` without the short glide that hides the steps between frames
    apply(now = false) {
        const loudness = Math.max(0, this.volume * this.near * this.player.volume);
        if (this.element) this.element.volume = clamp(loudness, 0, 1);
        if (!this.gain || !this.panner || !context) return;
        if (now) {
            this.gain.gain.value = loudness;
            this.panner.pan.value = this.side;
        } else {
            this.gain.gain.setTargetAtTime(loudness, context.currentTime, 0.02);
            this.panner.pan.setTargetAtTime(this.side, context.currentTime, 0.02);
        }
    }

    setPaused(paused: boolean) {
        if (paused === this.paused) return;
        this.paused = paused;
        // A buffer cannot be paused, but at speed 0 it stands still
        if (this.source) this.source.playbackRate.value = paused ? 0 : this.pitch;
        if (this.element) {
            this.element.playbackRate = this.pitch;
            if (paused) this.element.pause();
            // Not allowed before the user has touched the page: then this sound is not heard
            else this.element.play().catch(() => this.stop());
        }
    }

    stop() {
        if (!this.playing) return;
        this.playing = false;
        if (this.source) {
            this.source.onended = null;
            try {
                this.source.stop();
            } catch {
                // Was never started
            }
            this.source.disconnect();
            this.gain?.disconnect();
            this.panner?.disconnect();
        }
        this.element?.pause();
        this.ended();
    }
}

// Plays the sounds of one running scene; Game has one, the behaviors reach it through self.playSound()
export class SoundPlayer {
    // The loudness of everything, 0..1; the editor mutes Play with it
    volume = 1;

    // false: nothing is loaded and nothing plays (a still picture of a scene needs no sound)
    enabled = true;

    private registry: Registry;

    private voices = new Set<Voice>();

    private paused = false;

    // The names that were already complained about
    private unknown = new Set<string>();

    constructor(registry: Registry) {
        this.registry = registry;
    }

    // Number of sounds that play now
    get count() {
        return this.voices.size;
    }

    // Loads every sound of the project, so that the first play of each does not come late
    preload() {
        if (!this.enabled || !audioContext()) return;
        for (const name of this.registry.soundNames()) load(this.registry.soundUrl(name));
    }

    play(name: string, options: SoundOptions = {}): SoundHandle {
        const voice = new Voice(this, options, () => this.voices.delete(voice));
        if (!this.enabled || !audioContext()) {
            voice.playing = false;
            return voice;
        }
        if (!this.registry.soundNames().includes(name)) {
            if (!this.unknown.has(name)) console.warn(`There is no sound "${name}" in assets/ (sounds: ${this.registry.soundNames().join(", ") || "none"})`);
            this.unknown.add(name);
            voice.playing = false;
            return voice;
        }
        this.voices.add(voice);
        const url = this.registry.soundUrl(name);
        const loaded = load(url);
        if (loaded instanceof Promise) loaded.then((file) => voice.start(file, url, this.paused));
        else voice.start(loaded, url, this.paused);
        return voice;
    }

    // Once a frame: the sounds that have a place get louder, quieter and move from ear to ear as their
    // objects and the listener move; a changed volume is applied. `ears` is where the distance is counted
    // from, the camera itself if not given; left and right are always those of the camera.
    update(camera: THREE.Camera | null, ears: THREE.Object3D | null = camera) {
        camera?.updateWorldMatrix(true, false);
        for (const voice of this.voices) {
            if (voice.at) voice.hear(camera, ears);
            else voice.apply();
        }
    }

    // The game stands still: so do its sounds
    setPaused(paused: boolean) {
        this.paused = paused;
        for (const voice of this.voices) voice.setPaused(paused);
    }

    stopAll() {
        for (const voice of [...this.voices]) voice.stop();
    }

    dispose() {
        this.stopAll();
    }
}
