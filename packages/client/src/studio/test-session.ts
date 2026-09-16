import {
  BaseScript,
  DataModel,
  LocalScript,
  Model,
  PhysicsWorld,
  Player,
  Script,
  Vector3,
  createInstance,
  deserializePlace,
  loadCharacterFor,
  serializePlace,
  type Humanoid,
  type BasePart,
} from "@miblox/core";
import { ScriptEnvironment } from "@miblox/scripting";

export type TestMode = "run" | "play";
/** Which script context you are looking at, as Studio's own switcher does. */
export type TestContext = "server" | "client";

export interface OutputLine {
  context: TestContext;
  level: "print" | "warn" | "error";
  text: string;
  at: number;
}

export interface TestSessionEvents {
  onOutput(line: OutputLine): void;
  onStopped(): void;
}

/**
 * A test server, run inside Studio.
 *
 * This is the local equivalent of starting a game server: the place's Scripts
 * run in a server VM, its LocalScripts in a client VM, and physics ticks over
 * a copy of the world. The two VMs share one DataModel, which is what Roblox
 * does when you test solo, so the difference between them is the script
 * context - a Script gets FireClient, a LocalScript gets FireServer and a
 * LocalPlayer - rather than two separate copies of the world.
 *
 * The copy matters: tests mutate the world, and the edits you were making must
 * not be changed underneath you by a script that ran while you were testing.
 */
export class TestSession {
  readonly game: DataModel;
  readonly physics: PhysicsWorld;
  readonly server: ScriptEnvironment;
  readonly client: ScriptEnvironment;
  player: Player | null = null;
  character: Model | null = null;
  mode: TestMode;
  running = true;
  /** Everything both VMs have printed, newest last. */
  readonly output: OutputLine[] = [];

  private elapsed = 0;

  constructor(
    source: DataModel,
    mode: TestMode,
    private readonly events: TestSessionEvents,
  ) {
    this.mode = mode;
    // An isolated copy, so the edit session is untouched by whatever the test
    // does. Terrain rides along in the place file's chunks.
    this.game = deserializePlace(
      JSON.parse(JSON.stringify(serializePlace(source, "Test"))),
    );
    this.game.Terrain.voxels.gen = { ...source.Terrain.voxels.gen };
    this.game.Terrain.voxels.generateOnAccess = true;

    this.physics = new PhysicsWorld(this.game.Workspace, this.game.Terrain.voxels);

    this.server = new ScriptEnvironment({
      game: this.game,
      physics: this.physics,
      side: "server",
      onPrint: (text) => this.log("server", "print", text),
      onError: (message) => this.log("server", "error", message),
    });
    this.client = new ScriptEnvironment({
      game: this.game,
      physics: this.physics,
      side: "client",
      onPrint: (text) => this.log("client", "print", text),
      onError: (message) => this.log("client", "error", message),
    });
  }

  start(): void {
    this.log("server", "print", `Test ${this.mode === "play" ? "play" : "run"} started`);
    this.primeTerrain();
    this.runServerScripts();

    if (this.mode === "play") {
      this.spawnLocalPlayer();
      this.runClientScripts();
    }
    // Let startup scripts reach their first yield before the first frame, so
    // the world is built before anything looks at it.
    this.server.step(0);
    this.client.step(0);
  }

  /**
   * Generates the terrain around the origin before anything looks at it.
   *
   * Chunks are otherwise created lazily, so a test would open over a patchwork
   * of whatever the startup scripts happened to touch.
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

  private runServerScripts(): void {
    for (const name of ["ServerScriptService", "Workspace", "ReplicatedStorage"]) {
      const service = this.game.FindService(name);
      for (const descendant of service?.GetDescendants() ?? []) {
        if (!(descendant instanceof Script)) continue;
        const script = descendant as BaseScript;
        if (!script.Enabled || !script.Source) continue;
        this.server.runScript(script);
      }
    }
  }

  private runClientScripts(): void {
    const starter = this.game.FindService("StarterPlayer")?.FindFirstChild("StarterPlayerScripts");
    for (const descendant of starter?.GetDescendants() ?? []) {
      if (!(descendant instanceof LocalScript)) continue;
      if (!descendant.Enabled || !descendant.Source) continue;
      this.client.runScript(descendant);
    }
    // Scripts copied into the character by StarterCharacterScripts run too.
    for (const descendant of this.character?.GetDescendants() ?? []) {
      if (!(descendant instanceof LocalScript)) continue;
      if (!descendant.Enabled || !descendant.Source) continue;
      this.client.runScript(descendant);
    }
  }

  private spawnLocalPlayer(): void {
    const player = createInstance("Player") as Player;
    player.Name = "Player";
    player.DisplayName = "Player";
    player.UserId = 1;
    player.loadCharacterHandler = () => this.spawnCharacter(player);
    player.setParent(this.game.Players);
    this.game.Players.LocalPlayer = player;
    this.player = player;

    this.spawnCharacter(player);
    this.game.Players.PlayerAdded.Fire(player);
  }

  private spawnCharacter(player: Player): Model {
    player.Character?.Destroy();
    const spawnPart = this.game.Workspace.GetDescendants().find(
      (inst) => inst.className === "SpawnLocation",
    ) as BasePart | undefined;
    const position = spawnPart
      ? spawnPart.CFrame.position.add(new Vector3(0, spawnPart.Size.y / 2 + 4, 0))
      : new Vector3(0, this.game.Terrain.voxels.surfaceHeight(0, 0) + 8, 0);

    const { model, custom } = loadCharacterFor(this.game.FindService("StarterPlayer"), {
      name: player.Name,
      position,
    });
    if (custom) this.log("server", "print", "Spawned the place's StarterCharacter");
    model.setParent(this.game.Workspace);
    player.setProperty("Character", model);
    this.character = model;
    player.CharacterAdded.Fire(model);
    return model;
  }

  get humanoid(): Humanoid | null {
    return (this.character?.FindFirstChildOfClass("Humanoid") as Humanoid) ?? null;
  }

  get root(): BasePart | null {
    return (this.character?.FindFirstChild("HumanoidRootPart") as BasePart) ?? null;
  }

  /** Drives the test character, for WASD in the Studio viewport. */
  setMove(direction: Vector3, jump: boolean): void {
    const humanoid = this.humanoid;
    if (!humanoid) return;
    humanoid.MoveDirection = direction.magnitude > 1 ? direction.unit : direction;
    if (jump) humanoid.Jump = true;
  }

  step(dt: number): void {
    if (!this.running) return;
    this.elapsed += dt;
    try {
      this.server.step(dt);
      this.client.step(dt);
      this.physics.step(dt);
    } catch (err) {
      this.log("server", "error", String(err));
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.server.vm.scheduler.clear();
    this.client.vm.scheduler.clear();
    this.log("server", "print", `Test stopped after ${this.elapsed.toFixed(1)}s`);
    this.events.onStopped();
  }

  private log(context: TestContext, level: OutputLine["level"], text: string): void {
    const line: OutputLine = { context, level, text, at: Date.now() };
    this.output.push(line);
    // The panel only shows the tail; keeping everything would grow unbounded.
    if (this.output.length > 500) this.output.shift();
    this.events.onOutput(line);
  }
}
