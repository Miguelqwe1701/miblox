import * as THREE from "three";
import {
  BasePart,
  CFrame,
  Color3,
  DataModel,
  Instance as EngineInstance,
  MATERIAL_BY_ID,
  MATERIAL_ID,
  Vector3,
  createInstance,
  deserializePlace,
  serializePlace,
  type SerializedPlace,
} from "@miblox/core";
import { Explorer, INSERTABLE, Properties } from "./explorer.js";
import { ScriptEditor } from "./script-editor.js";
import { Viewport, type Tool } from "./viewport.js";
import { TestSession, type OutputLine, type TestContext, type TestMode } from "./test-session.js";
import "./studio.css";

const WASM_URL = "/miblox.wasm";

/**
 * MiBlox Studio.
 *
 * Loads a place from the portal, edits it in a local DataModel, and saves it
 * back. It runs the same engine the game does, so what you build here is drawn
 * by the same renderer and simulated by the same physics.
 */
class Studio {
  private game = new DataModel();
  private explorer!: Explorer;
  private properties = new Properties();
  private scriptEditor = new ScriptEditor();
  private viewport!: Viewport;
  private placeId: string;
  private place: SerializedPlace | null = null;
  private dirty = false;
  private saving = false;
  private test: TestSession | null = null;
  private context: TestContext = "server";
  private held = new Set<string>();

  constructor(private readonly root: HTMLElement) {
    // /studio/<id>
    this.placeId = decodeURIComponent(window.location.pathname.split("/").filter(Boolean)[1] ?? "");
  }

  async boot(): Promise<void> {
    this.renderShell();
    if (!this.placeId) {
      this.setStatus("No world specified in the URL", true);
      return;
    }

    try {
      const res = await fetch(`/api/places/${encodeURIComponent(this.placeId)}`);
      if (!res.ok) throw new Error(`The portal returned ${res.status}`);
      this.place = (await res.json()) as SerializedPlace;
    } catch (err) {
      this.setStatus(`Could not load that world: ${String((err as Error).message)}`, true);
      return;
    }

    // Studio holds the whole place in memory, including terrain, so nothing is
    // generated lazily behind the editor's back while it is being edited.
    this.game = deserializePlace(this.place);
    this.game.Terrain.voxels.generateOnAccess = true;
    this.primeTerrain();

    this.explorer = new Explorer(this.game);
    this.explorer.onSelect((instance) => this.onSelect(instance));
    this.root.querySelector(".panel-explorer")!.appendChild(this.explorer.element);
    this.explorer.refresh();

    this.properties.bind(() => this.markDirty());
    this.root.querySelector(".panel-properties")!.appendChild(this.properties.element);
    this.scriptEditor.bind(() => this.markDirty());
    this.root.querySelector(".panel-script")!.appendChild(this.scriptEditor.element);

    this.viewport = new Viewport(this.root.querySelector(".viewport")!, this.game, {
      onSelect: (instance) => {
        this.explorer.select(instance);
      },
      onEdited: () => this.markDirty(),
    });
    await this.viewport.init(WASM_URL);

    this.setStatus(`Editing ${this.place.name}`);
    this.setTitle();
    this.loop();
  }

  /**
   * Generates the terrain around the origin up front.
   *
   * Without this, terrain only exists where the place file recorded an edit,
   * and the editor would open over an empty void with nothing to sculpt.
   */
  private primeTerrain(): void {
    const voxels = this.game.Terrain.voxels;
    for (let cy = -1; cy <= 2; cy++) {
      for (let cz = -3; cz <= 3; cz++) {
        for (let cx = -3; cx <= 3; cx++) voxels.getChunk(cx, cy, cz);
      }
    }
    voxels.dirtyChunks.clear();
  }

  // -- shell ---------------------------------------------------------------

  private renderShell(): void {
    this.root.innerHTML = `
      <header class="bar">
        <div class="bar-left">
          <a class="home" href="/" title="Back to MiBlox">◀</a>
          <strong class="place-title">Studio</strong>
          <span class="dirty-dot" hidden title="Unsaved changes">●</span>
        </div>
        <div class="tools">
          <button class="tool selected" data-tool="select">Select</button>
          <button class="tool" data-tool="move">Move</button>
          <span class="sep"></span>
          <button class="tool" data-tool="terrain-add">Add</button>
          <button class="tool" data-tool="terrain-remove">Erase</button>
          <button class="tool" data-tool="terrain-paint">Paint</button>
          <label class="brush">
            <span>Brush</span>
            <input class="brush-size" type="range" min="4" max="48" step="2" value="12" />
            <output class="brush-size-value">12</output>
          </label>
          <select class="brush-material"></select>
        </div>
        <div class="bar-right">
          <select class="insert"><option value="">Insert…</option></select>
          <button class="ghost delete">Delete</button>
          <span class="sep"></span>
          <button class="ghost run" title="Start a test server with no player">Run</button>
          <button class="ghost test-play" title="Test with a character">Play</button>
          <button class="ghost stop" hidden>Stop</button>
          <select class="context" hidden title="Which script context you are viewing">
            <option value="server">Server</option>
            <option value="client">Client</option>
          </select>
          <span class="sep"></span>
          <button class="ghost launch" title="Open this world in the game client">Open in game</button>
          <button class="primary save">Save</button>
        </div>
      </header>

      <main class="layout">
        <aside class="side left">
          <h2>Explorer</h2>
          <div class="panel panel-explorer"></div>
        </aside>
        <section class="centre">
          <div class="viewport"></div>
          <div class="tabs">
            <button class="tab selected" data-tab="script">Script</button>
            <button class="tab" data-tab="output">Output</button>
            <span class="viewport-stats"></span>
          </div>
          <div class="drawer">
            <div class="panel panel-script"></div>
            <div class="panel panel-output" hidden>
              <div class="output-head">
                <label>Show
                  <select class="output-filter">
                    <option value="all">Both contexts</option>
                    <option value="server">Server only</option>
                    <option value="client">Client only</option>
                  </select>
                </label>
                <button class="ghost clear-output">Clear</button>
              </div>
              <div class="output-log"><p class="hint">Press Run or Play to start a test server.</p></div>
            </div>
          </div>
        </section>
        <aside class="side right">
          <h2>Properties</h2>
          <div class="panel panel-properties"></div>
        </aside>
      </main>

      <div class="status"></div>`;

    this.bindToolbar();
    this.bindTabs();
    window.addEventListener("keydown", (event) => this.onKeyDown(event));
    window.addEventListener("keyup", (event) => this.held.delete(event.code));
    // Keys held when focus is lost would otherwise stick down.
    window.addEventListener("blur", () => this.held.clear());
    // Leaving with unsaved work should ask first.
    window.addEventListener("beforeunload", (event) => {
      if (!this.dirty) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }

  private bindToolbar(): void {
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(".tool")) {
      button.addEventListener("click", () => this.setTool(button.dataset.tool as Tool));
    }

    const size = this.root.querySelector<HTMLInputElement>(".brush-size")!;
    const sizeValue = this.root.querySelector<HTMLOutputElement>(".brush-size-value")!;
    size.addEventListener("input", () => {
      sizeValue.textContent = size.value;
      this.viewport.brushRadius = Number(size.value);
    });

    const material = this.root.querySelector<HTMLSelectElement>(".brush-material")!;
    for (const name of MATERIAL_BY_ID) {
      if (name === "Air") continue;
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      material.appendChild(option);
    }
    material.value = "Grass";
    material.addEventListener("change", () => {
      this.viewport.brushMaterial = MATERIAL_ID[material.value] ?? MATERIAL_ID.Grass;
    });

    const insert = this.root.querySelector<HTMLSelectElement>(".insert")!;
    for (const group of INSERTABLE) {
      const optgroup = document.createElement("optgroup");
      optgroup.label = group.group;
      for (const className of group.classes) {
        const option = document.createElement("option");
        option.value = className;
        option.textContent = className;
        optgroup.appendChild(option);
      }
      insert.appendChild(optgroup);
    }
    insert.addEventListener("change", () => {
      if (insert.value) this.insert(insert.value);
      insert.value = "";
    });

    this.root.querySelector<HTMLButtonElement>(".delete")!.addEventListener("click", () =>
      this.deleteSelection(),
    );
    this.root.querySelector<HTMLButtonElement>(".save")!.addEventListener("click", () =>
      void this.save(),
    );
    this.root.querySelector<HTMLButtonElement>(".launch")!.addEventListener("click", () =>
      void this.play(),
    );
    this.root.querySelector<HTMLButtonElement>(".run")!.addEventListener("click", () =>
      void this.startTest("run"),
    );
    this.root.querySelector<HTMLButtonElement>(".test-play")!.addEventListener("click", () =>
      void this.startTest("play"),
    );
    this.root.querySelector<HTMLButtonElement>(".stop")!.addEventListener("click", () =>
      void this.stopTest(),
    );

    const context = this.root.querySelector<HTMLSelectElement>(".context")!;
    context.addEventListener("change", () => {
      this.context = context.value as TestContext;
      this.setStatus(
        this.context === "server"
          ? "Viewing the server: Scripts, and everything in the world."
          : "Viewing the client: LocalScripts, and this machine's LocalPlayer.",
      );
      this.renderOutput();
      this.explorer.refresh();
    });

    this.root.querySelector<HTMLSelectElement>(".output-filter")!.addEventListener("change", () =>
      this.renderOutput(),
    );
    this.root.querySelector<HTMLButtonElement>(".clear-output")!.addEventListener("click", () => {
      if (this.test) this.test.output.length = 0;
      this.renderOutput();
    });
  }

  // -- testing -------------------------------------------------------------

  /**
   * Starts a test server inside Studio.
   *
   * "Run" starts the world with no player, which is what you want when testing
   * server scripts. "Play" adds a character you can walk around with, and runs
   * the place's LocalScripts in a client context alongside.
   */
  private async startTest(mode: TestMode): Promise<void> {
    if (this.test) await this.stopTest();

    this.test = new TestSession(this.game, mode, {
      onOutput: (line) => this.appendOutput(line),
      onStopped: () => {},
    });
    this.test.start();

    await this.viewport.setGame(this.test.game, WASM_URL);
    if (mode === "play") {
      this.viewport.follow = () => this.test?.root?.CFrame.position ?? null;
      this.viewport.tool = "select";
    }

    // The explorer now shows the running world, not the one being edited.
    this.explorer = new Explorer(this.test.game);
    this.explorer.onSelect((instance) => this.onSelect(instance));
    const panel = this.root.querySelector(".panel-explorer")!;
    panel.innerHTML = "";
    panel.appendChild(this.explorer.element);
    this.explorer.refresh();

    this.setTestChrome(true);
    const tab = this.root.querySelector<HTMLButtonElement>('.tab[data-tab="output"]')!;
    tab.click();
    this.setStatus(
      mode === "play"
        ? "Testing. WASD to walk, Space to jump. Stop to return to editing."
        : "Test server running. Stop to return to editing.",
    );
  }

  private async stopTest(): Promise<void> {
    if (!this.test) return;
    this.test.stop();
    this.test = null;
    this.viewport.follow = null;

    await this.viewport.setGame(this.game, WASM_URL);
    this.explorer = new Explorer(this.game);
    this.explorer.onSelect((instance) => this.onSelect(instance));
    const panel = this.root.querySelector(".panel-explorer")!;
    panel.innerHTML = "";
    panel.appendChild(this.explorer.element);
    this.explorer.refresh();

    this.setTestChrome(false);
    this.setStatus("Back to editing. Nothing the test did was saved.");
  }

  private setTestChrome(testing: boolean): void {
    this.root.querySelector<HTMLElement>(".run")!.hidden = testing;
    this.root.querySelector<HTMLElement>(".test-play")!.hidden = testing;
    this.root.querySelector<HTMLElement>(".stop")!.hidden = !testing;
    this.root.querySelector<HTMLElement>(".context")!.hidden = !testing;
    this.root.classList.toggle("testing", testing);
  }

  private appendOutput(line: OutputLine): void {
    const log = this.root.querySelector<HTMLElement>(".output-log")!;
    const filter = this.root.querySelector<HTMLSelectElement>(".output-filter")!.value;
    if (filter !== "all" && filter !== line.context) return;
    if (log.querySelector(".hint")) log.innerHTML = "";
    log.appendChild(this.outputRow(line));
    while (log.childElementCount > 300) log.firstElementChild?.remove();
    log.scrollTop = log.scrollHeight;
  }

  private renderOutput(): void {
    const log = this.root.querySelector<HTMLElement>(".output-log")!;
    const filter = this.root.querySelector<HTMLSelectElement>(".output-filter")!.value;
    const lines = (this.test?.output ?? []).filter(
      (line) => filter === "all" || filter === line.context,
    );
    log.innerHTML = "";
    if (!lines.length) {
      log.innerHTML = `<p class="hint">Press Run or Play to start a test server.</p>`;
      return;
    }
    for (const line of lines) log.appendChild(this.outputRow(line));
    log.scrollTop = log.scrollHeight;
  }

  private outputRow(line: OutputLine): HTMLElement {
    const row = document.createElement("div");
    row.className = `out ${line.level} ${line.context}`;
    const tag = document.createElement("span");
    tag.className = "out-tag";
    tag.textContent = line.context === "server" ? "Server" : "Client";
    const text = document.createElement("span");
    text.textContent = line.text;
    row.append(tag, text);
    return row;
  }

  private bindTabs(): void {
    for (const tab of this.root.querySelectorAll<HTMLButtonElement>(".tab")) {
      tab.addEventListener("click", () => {
        for (const other of this.root.querySelectorAll(".tab")) {
          other.classList.toggle("selected", other === tab);
        }
        const wanted = tab.dataset.tab;
        this.root.querySelector<HTMLElement>(".panel-script")!.hidden = wanted !== "script";
        this.root.querySelector<HTMLElement>(".panel-output")!.hidden = wanted !== "output";
      });
    }
  }

  private setTool(tool: Tool): void {
    this.viewport.tool = tool;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(".tool")) {
      button.classList.toggle("selected", button.dataset.tool === tool);
    }
    this.root.querySelector<HTMLElement>(".brush")!.hidden = !tool.startsWith("terrain");
    this.root.querySelector<HTMLElement>(".brush-material")!.hidden = !tool.startsWith("terrain");
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }
    if (this.test) {
      this.held.add(event.code);
      if (event.code === "Escape") void this.stopTest();
      // Movement keys belong to the test character while it is running.
      if (["KeyW", "KeyA", "KeyS", "KeyD", "Space"].includes(event.code)) {
        event.preventDefault();
        return;
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void this.save();
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      this.deleteSelection();
      return;
    }
    if (event.key === "f" && this.explorer.selection) {
      this.viewport.focusOn(this.explorer.selection);
      return;
    }
    const shortcuts: Record<string, Tool> = {
      "1": "select",
      "2": "move",
      "3": "terrain-add",
      "4": "terrain-remove",
      "5": "terrain-paint",
    };
    if (shortcuts[event.key]) this.setTool(shortcuts[event.key]);
  }

  // -- editing -------------------------------------------------------------

  private onSelect(instance: EngineInstance | null): void {
    this.properties.show(instance);
    this.scriptEditor.show(instance);
    this.viewport.select(instance);
    if (ScriptEditor.isScript(instance)) {
      const tab = this.root.querySelector<HTMLButtonElement>('.tab[data-tab="script"]')!;
      tab.click();
    }
  }

  /** Inserts a new instance under the selection, or under Workspace. */
  private insert(className: string): void {
    const selection = this.explorer.selection;
    const parent =
      selection && selection.className !== "Terrain" ? selection : this.game.Workspace;
    const instance = createInstance(className, parent);

    if (instance instanceof BasePart) {
      // Place it in front of the camera rather than at the origin, where it
      // would usually be buried in terrain and invisible.
      const focus = this.viewport.camera.position;
      const direction = this.viewport.camera.getWorldDirection(new THREE.Vector3());
      const spot = new Vector3(
        Math.round(focus.x + direction.x * 30),
        Math.round(focus.y + direction.y * 30),
        Math.round(focus.z + direction.z * 30),
      );
      instance.CFrame = CFrame.fromPosition(spot);
      instance.Anchored = true;
      if (className === "Part") instance.Color = Color3.fromRGB(150, 160, 175);
    }
    if (ScriptEditor.isScript(instance)) {
      (instance as unknown as { Source: string }).Source =
        className === "ModuleScript"
          ? "local module = {}\n\nreturn module\n"
          : `print("Hello from ${instance.Name}")\n`;
    }

    this.explorer.refresh();
    this.explorer.select(instance);
    this.markDirty();
    this.setStatus(`Inserted a ${className}`);
  }

  private deleteSelection(): void {
    const selection = this.explorer.selection;
    if (!selection) return;
    // Services and terrain are part of the world, not contents of it.
    if (selection.Parent === this.game || selection.className === "Terrain") {
      this.setStatus("That cannot be deleted", true);
      return;
    }
    const name = selection.Name;
    selection.Destroy();
    this.explorer.select(null);
    this.explorer.refresh();
    this.markDirty();
    this.setStatus(`Deleted ${name}`);
  }

  private markDirty(): void {
    this.dirty = true;
    this.root.querySelector<HTMLElement>(".dirty-dot")!.hidden = false;
    this.explorer.refresh();
  }

  // -- saving --------------------------------------------------------------

  private async save(): Promise<void> {
    if (this.saving || !this.place) return;
    this.saving = true;
    this.setStatus("Saving…");
    try {
      const place = serializePlace(this.game, this.place.name);
      // Catalogue fields live alongside the tree and are not part of it.
      const payload = {
        ...place,
        description: (this.place as { description?: string }).description,
        maxPlayers: (this.place as { maxPlayers?: number }).maxPlayers,
        serverAuthoritative: (this.place as { serverAuthoritative?: boolean }).serverAuthoritative,
        tickRate: (this.place as { tickRate?: number }).tickRate,
      };
      const res = await fetch(`/api/places/${encodeURIComponent(this.placeId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json()) as { error?: string; restarted?: number };
      if (!res.ok) {
        this.setStatus(body.error ?? "Could not save", true);
        return;
      }
      this.dirty = false;
      this.root.querySelector<HTMLElement>(".dirty-dot")!.hidden = true;
      this.setStatus(
        body.restarted
          ? `Saved. ${body.restarted} running server(s) were restarted.`
          : "Saved.",
      );
    } catch (err) {
      this.setStatus(`Could not save: ${String((err as Error).message)}`, true);
    } finally {
      this.saving = false;
    }
  }

  private async play(): Promise<void> {
    if (this.dirty) {
      const go = window.confirm("Save before playing? Unsaved changes will not appear in game.");
      if (go) await this.save();
    }
    window.location.href = `/play/${encodeURIComponent(this.placeId)}`;
  }

  // -- frame ---------------------------------------------------------------

  private loop(): void {
    let last = performance.now();
    const tick = (): void => {
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;

      if (this.test) {
        this.driveTestCharacter();
        this.test.step(dt);
      }
      this.viewport.render();
      const stats = this.viewport.terrainStats;
      this.root.querySelector<HTMLElement>(".viewport-stats")!.textContent =
        `${stats.chunks} chunks · ${stats.triangles} tris · ${stats.backend}`;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** Applies held movement keys to the test character, camera-relative. */
  private driveTestCharacter(): void {
    if (!this.test || this.test.mode !== "play") return;
    const camera = this.viewport.camera;
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    const right = new THREE.Vector3(-forward.z, 0, forward.x);

    const move = new THREE.Vector3();
    if (this.held.has("KeyW")) move.add(forward);
    if (this.held.has("KeyS")) move.sub(forward);
    if (this.held.has("KeyD")) move.add(right);
    if (this.held.has("KeyA")) move.sub(right);

    this.test.setMove(new Vector3(move.x, 0, move.z), this.held.has("Space"));
    this.held.delete("Space");
  }

  private setTitle(): void {
    const title = this.place?.name ?? "Studio";
    this.root.querySelector<HTMLElement>(".place-title")!.textContent = title;
    document.title = `${title} — MiBlox Studio`;
  }

  private setStatus(message: string, isError = false): void {
    const status = this.root.querySelector<HTMLElement>(".status")!;
    status.textContent = message;
    status.classList.toggle("error", isError);
  }
}

const root = document.getElementById("studio") ?? document.body;
const studio = new Studio(root);
void studio.boot();

// Exposed so the Playwright-driven demo can drive Studio deterministically.
(window as unknown as { studio: Studio }).studio = studio;
