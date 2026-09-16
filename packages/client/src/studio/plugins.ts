import {
  DataModel,
  Model,
  PhysicsWorld,
  Vector3,
  applyDescriptionTo,
  buildAvatar,
  describeAvatar,
  validateDescription,
  type HumanoidDescriptionData,
  type Instance as EngineInstance,
} from "@miblox/core";
import { ScriptEnvironment } from "@miblox/scripting";
import { LuaTable, isFunction, nativeFn, yieldingFn, type LuaValue } from "@miblox/luau";

export interface PluginButton {
  id: string;
  text: string;
  tooltip: string;
  pluginName: string;
  run(): void;
}

export interface PluginHostEvents {
  onButtonsChanged(buttons: PluginButton[]): void;
  onNotify(message: string): void;
  getSelection(): EngineInstance | null;
  setSelection(instance: EngineInstance | null): void;
  onEdited(): void;
}

export interface PluginRecord {
  name: string;
  source: string;
  /** Built-ins ship with Studio and cannot be deleted. */
  builtin?: boolean;
  enabled?: boolean;
}

const STORAGE_KEY = "miblox.studio.plugins";

/**
 * Studio plugins, written in Luau.
 *
 * A plugin is a script with a `plugin` global that can add toolbar buttons and
 * act on the place being edited. Using the same language the game is scripted
 * in means there is one thing to learn rather than two, and the plugin VM is
 * the same interpreter, so a plugin has the same API surface a script does.
 *
 * Plugins run over the edited world, not a copy: that is the point of them.
 */
export class PluginHost {
  private readonly env: ScriptEnvironment;
  private readonly buttons = new Map<string, PluginButton>();
  private plugins: PluginRecord[] = [];
  private loadingName = "";

  constructor(
    private readonly game: DataModel,
    physics: PhysicsWorld,
    private readonly events: PluginHostEvents,
  ) {
    this.env = new ScriptEnvironment({
      game,
      physics,
      side: "client",
      onPrint: (text) => events.onNotify(text),
      onError: (message, source) => events.onNotify(`${source}: ${message}`),
    });
    this.installApi();
  }

  step(dt: number): void {
    this.env.step(dt);
  }

  listPlugins(): PluginRecord[] {
    return this.plugins.map((plugin) => ({ ...plugin }));
  }

  listButtons(): PluginButton[] {
    return [...this.buttons.values()];
  }

  /** Loads the built-ins plus anything the user has saved in this browser. */
  loadAll(builtins: PluginRecord[]): void {
    const saved = this.readSaved();
    this.plugins = [
      ...builtins.map((plugin) => ({
        ...plugin,
        builtin: true,
        enabled: saved.find((s) => s.name === plugin.name)?.enabled ?? true,
      })),
      ...saved.filter((plugin) => !plugin.builtin),
    ];
    this.runEnabled();
  }

  addPlugin(name: string, source: string): void {
    const existing = this.plugins.findIndex((plugin) => plugin.name === name);
    const record: PluginRecord = { name, source, enabled: true };
    if (existing >= 0) this.plugins[existing] = record;
    else this.plugins.push(record);
    this.persist();
    this.runEnabled();
  }

  removePlugin(name: string): void {
    this.plugins = this.plugins.filter((plugin) => plugin.name !== name || plugin.builtin);
    this.persist();
    this.runEnabled();
  }

  setEnabled(name: string, enabled: boolean): void {
    const plugin = this.plugins.find((p) => p.name === name);
    if (!plugin) return;
    plugin.enabled = enabled;
    this.persist();
    this.runEnabled();
  }

  /** Re-runs every enabled plugin from scratch, rebuilding their buttons. */
  private runEnabled(): void {
    this.buttons.clear();
    this.env.vm.scheduler.clear();
    for (const plugin of this.plugins) {
      if (plugin.enabled === false) continue;
      this.loadingName = plugin.name;
      try {
        const fn = this.env.vm.load(plugin.source, `plugin:${plugin.name}`);
        // Run to its first yield now, so buttons registered at the top level
        // exist before the toolbar is drawn.
        this.env.vm.scheduler.spawn(fn, []);
      } catch (err) {
        this.events.onNotify(`${plugin.name} failed to load: ${String((err as Error).message)}`);
      }
    }
    this.loadingName = "";
    this.env.step(0);
    this.events.onButtonsChanged(this.listButtons());
  }

  private readSaved(): PluginRecord[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as PluginRecord[]) : [];
    } catch {
      return [];
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(this.plugins.map(({ name, source, builtin, enabled }) => ({
          name,
          source: builtin ? "" : source,
          builtin,
          enabled,
        }))),
      );
    } catch {
      // Not remembering a plugin is better than refusing to run one.
    }
  }

  // -- the plugin API ------------------------------------------------------

  private installApi(): void {
    const globals = this.env.vm.globals;
    const bridge = this.env.bridge;
    const host = this;

    const pluginTable = new LuaTable();
    pluginTable.set(
      "CreateButton",
      nativeFn("plugin:CreateButton", (args) => {
        // Called as plugin:CreateButton(text, tooltip, callback).
        const text = String(args[1] ?? "Button");
        const tooltip = String(args[2] ?? "");
        const callback = args[3];
        if (!isFunction(callback)) {
          throw new Error("plugin:CreateButton needs a function to run when clicked");
        }
        const pluginName = host.loadingName || "plugin";
        const id = `${pluginName}:${text}`;
        host.buttons.set(id, {
          id,
          text,
          tooltip,
          pluginName,
          run: () => {
            // Each click runs on its own thread, so a button that yields does
            // not block Studio.
            host.env.vm.scheduler.spawn(callback, []);
          },
        });
        return [];
      }),
    );

    pluginTable.set(
      "Notify",
      nativeFn("plugin:Notify", (args) => {
        host.events.onNotify(String(args[1] ?? ""));
        return [];
      }),
    );

    pluginTable.set(
      "GetSelection",
      nativeFn("plugin:GetSelection", () => {
        const selection = host.events.getSelection();
        return [selection ? bridge.wrapInstance(selection) : undefined];
      }),
    );

    pluginTable.set(
      "SetSelection",
      nativeFn("plugin:SetSelection", (args) => {
        const value = args[1];
        host.events.setSelection(
          value === undefined ? null : bridge.asInstance(value, "plugin:SetSelection"),
        );
        return [];
      }),
    );

    pluginTable.set(
      "MarkEdited",
      nativeFn("plugin:MarkEdited", () => {
        host.events.onEdited();
        return [];
      }),
    );

    pluginTable.set(
      "Prompt",
      yieldingFn("plugin:Prompt", function* (args) {
        const message = String(args[1] ?? "");
        const fallback = args[2] === undefined ? "" : String(args[2]);
        const answer = window.prompt(message, fallback);
        // Yields so a prompt behaves like any other blocking call in Luau.
        const resumed = yield {
          kind: "waitPromise",
          promise: Promise.resolve([answer === null ? undefined : answer] as LuaValue[]),
        };
        return resumed ?? [];
      }),
    );

    pluginTable.set(
      "HttpGet",
      yieldingFn("plugin:HttpGet", function* (args) {
        const url = String(args[1] ?? "");
        const resumed = yield {
          kind: "waitPromise",
          promise: fetch(url).then(async (res) => {
            if (!res.ok) throw new Error(`${url} returned ${res.status}`);
            return [await res.text()] as LuaValue[];
          }),
        };
        return resumed ?? [];
      }),
    );

    pluginTable.set(
      "HttpGetJson",
      yieldingFn("plugin:HttpGetJson", function* (args) {
        const url = String(args[1] ?? "");
        const resumed = yield {
          kind: "waitPromise",
          promise: fetch(url).then(async (res) => {
            if (!res.ok) throw new Error(`${url} returned ${res.status}`);
            return [jsonToLua(await res.json())] as LuaValue[];
          }),
        };
        return resumed ?? [];
      }),
    );

    pluginTable.frozen = true;
    globals.set("plugin", pluginTable);

    // Avatar building, which is what the character adder is built on.
    const avatar = new LuaTable();
    avatar.set(
      "Build",
      nativeFn("Avatar.Build", (args) => {
        const description = luaToJson(args[0]) as HumanoidDescriptionData;
        const problems = description ? validateDescription(description) : [];
        if (problems.length) throw new Error(problems.join("; "));
        // Placed on the surface rather than at a fixed height, so it does not
        // appear buried in a hill.
        const ground = host.game.Terrain.voxels.heightAt(0, 0, 400);
        const y = Number.isFinite(ground) ? ground + 4 : 24;
        const model = buildAvatar(description ?? undefined, {
          position: new Vector3(0, y, 0),
        });
        return [bridge.wrapInstance(model)];
      }),
    );
    avatar.set(
      "Apply",
      nativeFn("Avatar.Apply", (args) => {
        const model = bridge.asInstance(args[0], "Avatar.Apply") as Model;
        const description = luaToJson(args[1]) as HumanoidDescriptionData;
        const problems = description ? validateDescription(description) : [];
        if (problems.length) throw new Error(problems.join("; "));
        applyDescriptionTo(model, description ?? {});
        return [];
      }),
    );
    avatar.set(
      "Describe",
      nativeFn("Avatar.Describe", (args) => {
        const model = bridge.asInstance(args[0], "Avatar.Describe");
        return [jsonToLua(describeAvatar(model as Model))];
      }),
    );
    avatar.frozen = true;
    globals.set("Avatar", avatar);
  }
}

/** JSON value -> Luau value. Arrays become 1-based tables, as Lua expects. */
export function jsonToLua(value: unknown): LuaValue {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return LuaTable.fromArray(value.map((entry) => jsonToLua(entry)));
  }
  const table = new LuaTable();
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    table.set(key, jsonToLua(entry));
  }
  return table;
}

/** Luau value -> JSON value. A table with 1..n keys becomes an array. */
export function luaToJson(value: LuaValue): unknown {
  if (value === undefined) return undefined;
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (!(value instanceof LuaTable)) return undefined;

  const entries = [...value.entries()];
  const isArray =
    value.length > 0 && entries.every(([key]) => typeof key === "number");
  if (isArray) {
    const out: unknown[] = [];
    for (let i = 1; i <= value.length; i++) out.push(luaToJson(value.get(i)));
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of entries) {
    if (typeof key !== "string") continue;
    out[key] = luaToJson(entry);
  }
  return out;
}
