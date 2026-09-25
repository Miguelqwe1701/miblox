import {
  BasePart,
  CFrame,
  DataModel,
  Instance as EngineInstance,
  Model,
  PhysicsWorld,
  Player,
  RemoteEvent,
  Vector3,
  buildDelta,
  createInstance,
  deserializePlace,
  encodeChunkRLE,
  isEmptyDelta,
  applyDescriptionTo,
  copyStarterGui,
  loadCharacterFor,
  playerGuiOf,
  type HumanoidDescriptionData,
  MATERIAL_ID,
  PROTOCOL_VERSION,
  Terrain,
  chunkKey,
  parseChunkKey,
  toWireInstance,
  type ClientMessage,
  type SerializedPlace,
  type ServerMessage,
  type WireDelta,
} from "@miblox/core";
import { ScriptEnvironment } from "@miblox/scripting";

export interface PlaceServerOptions {
  place: SerializedPlace;
  /** Simulation and replication rate. */
  tickRate?: number;
  maxPlayers?: number;
  /**
   * When true, clients never simulate: the server owns every part and treats
   * client state messages as advisory only. Costs a round trip of input lag,
   * buys immunity to a client lying about where it is.
   */
  serverAuthoritative?: boolean;
  /** Radius, in chunks, of terrain streamed around each player. */
  viewDistance?: number;
  log?: (message: string) => void;
}

export interface Connection {
  readonly id: string;
  send(message: ServerMessage): void;
  close(reason: string): void;
}

interface PlayerSession {
  connection: Connection;
  player: Player;
  /** Chunks already sent, so each is streamed once. */
  sentChunks: Set<string>;
  /** Last input sequence accepted, for ordering. */
  lastSeq: number;
  platform: string;
  /** Set once the client has been sent the initial world snapshot. */
  primed: boolean;
}

/**
 * One running game server: a DataModel, its physics, its Luau VM and the
 * players connected to it. The portal launches one process per place, so a
 * script that hangs or crashes takes down only its own game.
 */
export class PlaceServer {
  readonly game: DataModel;
  readonly physics: PhysicsWorld;
  readonly scripts: ScriptEnvironment;
  readonly tickRate: number;
  readonly serverAuthoritative: boolean;
  private readonly maxPlayers: number;
  private readonly viewDistance: number;
  private readonly log: (message: string) => void;

  private sessions = new Map<string, PlayerSession>();
  /** Each player's HumanoidDescription, from their join ticket. */
  private appearances = new Map<string, HumanoidDescriptionData | undefined>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private tick = 0;
  private nextUserId = 1;
  private running = false;
  private lastStepAt = 0;

  constructor(private readonly opts: PlaceServerOptions) {
    this.tickRate = opts.tickRate ?? 30;
    this.maxPlayers = opts.maxPlayers ?? 32;
    this.serverAuthoritative = opts.serverAuthoritative ?? false;
    this.viewDistance = opts.viewDistance ?? 4;
    this.log = opts.log ?? ((m) => console.log(`[place] ${m}`));

    this.game = deserializePlace(opts.place);
    this.physics = new PhysicsWorld(this.game.Workspace, this.game.Terrain.voxels);
    // The server integrates only what it owns; clients integrate their own.
    this.physics.simulationFilter = (part) =>
      this.serverAuthoritative || part.NetworkOwnerId === "";

    this.scripts = new ScriptEnvironment({
      game: this.game,
      physics: this.physics,
      side: "server",
      onPrint: (text, source) => this.log(`${source}: ${text}`),
      onError: (message, source) => this.log(`script error in ${source}: ${message}`),
    });

    this.bindRemotes();
  }

  // -- lifecycle -----------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.runStartupScripts();
    // Run each startup script up to its first yield before anyone can connect.
    // Otherwise the first player to join races the scripts and receives a
    // half-built world, with the rest trickling in as deltas.
    this.scripts.step(0);
    this.physics.step(0);
    this.lastStepAt = Date.now();
    const interval = 1000 / this.tickRate;
    this.timer = setInterval(() => this.step(), interval);
    this.log(
      `started: ${this.opts.place.name} at ${this.tickRate}Hz, ` +
        `${this.serverAuthoritative ? "server authoritative" : "client ownership enabled"}`,
    );
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.scripts.vm.scheduler.clear();
    for (const session of this.sessions.values()) session.connection.close("Server shutting down");
    this.sessions.clear();
  }

  /** Runs every Script under ServerScriptService, as Roblox does at startup. */
  private runStartupScripts(): void {
    const containers = ["ServerScriptService", "Workspace", "ReplicatedStorage"];
    for (const name of containers) {
      const service = this.game.FindService(name);
      if (!service) continue;
      for (const desc of service.GetDescendants()) {
        if (desc.className !== "Script") continue;
        const script = desc as unknown as { Enabled: boolean; Source: string };
        if (!script.Enabled || !script.Source) continue;
        this.scripts.runScript(desc as never);
      }
    }
  }

  // -- the tick ------------------------------------------------------------

  private step(): void {
    const now = Date.now();
    // Clamped so a stalled process does not integrate one enormous step.
    const dt = Math.min((now - this.lastStepAt) / 1000, 0.25);
    this.lastStepAt = now;
    this.tick++;

    try {
      this.scripts.step(dt);
    } catch (err) {
      this.log(`scheduler error: ${String(err)}`);
    }
    try {
      this.physics.step(dt);
    } catch (err) {
      this.log(`physics error: ${String(err)}`);
    }

    this.replicate();
    this.streamTerrain();
  }

  private replicate(): void {
    const changes = this.game.flushChanges();
    const delta = buildDelta(this.game, changes);
    if (isEmptyDelta(delta)) return;
    this.broadcast({ t: "delta", tick: this.tick, delta });
  }

  /** Sends each player the terrain chunks near them, once each. */
  private streamTerrain(): void {
    const terrain = this.game.Terrain as Terrain;
    for (const session of this.sessions.values()) {
      if (!session.primed) continue;
      const root = this.rootPartOf(session.player);
      const center = root ? root.CFrame.position : Vector3.zero;
      const chunks: Array<{ key: string; rle: string }> = [];

      const cx = Math.floor(center.x / 64);
      const cy = Math.floor(center.y / 64);
      const cz = Math.floor(center.z / 64);
      const r = this.viewDistance;
      for (let y = cy - 1; y <= cy + 1 && chunks.length < 8; y++) {
        for (let z = cz - r; z <= cz + r && chunks.length < 8; z++) {
          for (let x = cx - r; x <= cx + r && chunks.length < 8; x++) {
            const key = chunkKey(x, y, z);
            if (session.sentChunks.has(key)) continue;
            const chunk = terrain.voxels.getChunk(x, y, z);
            session.sentChunks.add(key);
            if (!chunk || chunk.isEmpty) continue;
            chunks.push({ key, rle: encodeChunkRLE(chunk) });
          }
        }
      }
      if (chunks.length) session.connection.send({ t: "chunks", chunks });
    }

    // Chunks edited since the last tick go to everyone who already has them.
    if (terrain.voxels.dirtyChunks.size) {
      const dirty = [...terrain.voxels.dirtyChunks];
      terrain.voxels.dirtyChunks.clear();
      for (const session of this.sessions.values()) {
        const updates: Array<{ key: string; rle: string }> = [];
        for (const key of dirty) {
          if (!session.sentChunks.has(key)) continue;
          const [x, y, z] = parseChunkKey(key);
          const chunk = terrain.voxels.getChunk(x, y, z);
          if (chunk) updates.push({ key, rle: encodeChunkRLE(chunk) });
        }
        if (updates.length) session.connection.send({ t: "chunks", chunks: updates });
      }
    }
  }

  private broadcast(message: ServerMessage, except?: string): void {
    for (const [id, session] of this.sessions) {
      if (id === except) continue;
      session.connection.send(message);
    }
  }

  // -- players -------------------------------------------------------------

  get playerCount(): number {
    return this.sessions.size;
  }

  /**
   * Admits a connection. `identity` comes from the portal, which has already
   * verified the session token; the place server trusts the portal, not the
   * client, for who someone is.
   */
  join(
    connection: Connection,
    message: Extract<ClientMessage, { t: "join" }>,
      identity?: { accountId: string; username: string; avatar?: Record<string, unknown> },
  ): Player | null {
    if (this.sessions.size >= this.maxPlayers) {
      connection.close("This server is full");
      return null;
    }
    if (message.protocol !== PROTOCOL_VERSION) {
      connection.close(
        `Version mismatch: this server speaks protocol ${PROTOCOL_VERSION}, you sent ${message.protocol}`,
      );
      return null;
    }

    const username = identity?.username ?? sanitizeGuestName(message.name);
    const player = createInstance("Player") as Player;
    player.Name = username;
    player.DisplayName = username;
    player.UserId = this.nextUserId++;
    player.Platform = message.platform || "Desktop";
    // Their saved look travels in the ticket, so no lookup is needed here.
    this.appearances.set(player.id, (identity?.avatar as HumanoidDescriptionData) ?? undefined);
    player.kickHandler = (reason) => connection.close(reason || "You were kicked");
    player.loadCharacterHandler = () => this.spawnCharacter(player);
    player.setParent(this.game.Players);
    // Exists from the start so a LocalScript can WaitForChild it even in a
    // place that never spawns a character.
    playerGuiOf(player);

    const session: PlayerSession = {
      connection,
      player,
      sentChunks: new Set(),
      lastSeq: 0,
      platform: player.Platform,
      primed: false,
    };
    this.sessions.set(connection.id, session);

    connection.send({
      t: "hello",
      protocol: PROTOCOL_VERSION,
      playerId: player.id,
      rootId: this.game.id,
      tickRate: this.tickRate,
      placeName: this.opts.place.name,
      username,
      serverAuthoritative: this.serverAuthoritative,
      terrain: {
        seed: this.game.Terrain.voxels.gen.seed,
        seaLevel: this.game.Terrain.voxels.gen.seaLevel,
        amplitude: this.game.Terrain.voxels.gen.amplitude,
        scale: this.game.Terrain.voxels.gen.scale,
        caves: this.game.Terrain.voxels.gen.caves,
      },
    });

    // The newcomer needs the whole world; everyone else only needs the new bits.
    connection.send({ t: "delta", tick: this.tick, delta: this.fullSnapshot() });
    session.primed = true;

    this.game.Players.PlayerAdded.Fire(player);
    this.log(`${username} joined (${this.sessions.size}/${this.maxPlayers})`);

    if (this.game.Players.CharacterAutoLoads) this.spawnCharacter(player);
    return player;
  }

  leave(connectionId: string): void {
    const session = this.sessions.get(connectionId);
    if (!session) return;
    this.sessions.delete(connectionId);
    this.appearances.delete(session.player.id);
    this.game.Players.PlayerRemoving.Fire(session.player);
    session.player.Character?.Destroy();
    session.player.Destroy();
    this.log(`${session.player.Name} left (${this.sessions.size}/${this.maxPlayers})`);
  }

  /** Every instance currently in the tree, for a client that has just joined. */
  private fullSnapshot(): WireDelta {
    const add = [...this.game.byId.values()]
      .filter((inst) => inst !== this.game)
      .map((inst) => toWireInstance(inst));
    // Parents must arrive before their children.
    add.sort((a, b) => depthOf(this.game, a.id) - depthOf(this.game, b.id));
    return { add };
  }

  private spawnCharacter(player: Player): Model {
    player.Character?.Destroy();
    const spawn = this.findSpawnPoint();
    // A place can ship its own rig as StarterPlayer.StarterCharacter; the
    // placeholder is only used when it has not.
    const { model: character, custom } = loadCharacterFor(this.game.FindService("StarterPlayer"), {
      name: player.Name,
      position: spawn,
    });
    if (custom) this.log(`${player.Name} spawned with the place's StarterCharacter`);

    // A place that ships its own rig decides how it looks; otherwise the
    // player's own HumanoidDescription is applied to the default rig.
    if (!custom) {
      const description = this.appearances.get(player.id);
      if (description) applyDescriptionTo(character, description);
    }
    character.setParent(this.game.Workspace);
    // Roblox hands out StarterGui on every spawn, which is what resets a
    // ResetOnSpawn GUI when the player dies.
    copyStarterGui(player, this.game.FindService("StarterGui"));

    const root = character.FindFirstChild("HumanoidRootPart") as BasePart;
    // Handing the player their own character removes a round trip from every
    // input. A server-authoritative place keeps it instead.
    if (!this.serverAuthoritative) {
      for (const desc of character.GetDescendants()) {
        if (desc instanceof BasePart) desc.setProperty("NetworkOwnerId", player.id);
      }
    }

    player.setProperty("Character", character);
    player.CharacterAdded.Fire(character);
    void root;
    return character;
  }

  private findSpawnPoint(): Vector3 {
    const spawns = this.game.Workspace.GetDescendants().filter(
      (inst) => inst.className === "SpawnLocation",
    ) as BasePart[];
    if (spawns.length) {
      const chosen = spawns[Math.floor(Math.random() * spawns.length)];
      return chosen.CFrame.position.add(new Vector3(0, chosen.Size.y / 2 + 4, 0));
    }
    // No spawn placed, so drop the player onto the generated surface.
    const height = this.game.Terrain.voxels.surfaceHeight(0, 0);
    return new Vector3(0, height + 8, 0);
  }

  private rootPartOf(player: Player): BasePart | null {
    const character = player.Character;
    if (!character) return null;
    return (character.FindFirstChild("HumanoidRootPart") as BasePart) ?? null;
  }

  // -- client messages -----------------------------------------------------

  handleMessage(connectionId: string, message: ClientMessage): void {
    const session = this.sessions.get(connectionId);
    if (!session) return;

    switch (message.t) {
      case "input":
        this.handleInput(session, message);
        break;
      case "state":
        this.handleState(session, message);
        break;
      case "edit":
        this.handleEdit(session, message);
        break;
      case "remote":
        this.handleRemote(session, message);
        break;
      case "chat":
        this.handleChat(session, message);
        break;
      case "ping":
        session.connection.send({ t: "pong", time: message.time });
        break;
      case "wantChunks":
        this.handleWantChunks(session, message);
        break;
      default:
        break;
    }
  }

  private handleInput(session: PlayerSession, message: Extract<ClientMessage, { t: "input" }>): void {
    if (message.seq <= session.lastSeq) return; // Stale or replayed packet.
    session.lastSeq = message.seq;
    const character = session.player.Character;
    const humanoid = character?.FindFirstChildOfClass("Humanoid");
    if (!humanoid) return;

    const move = new Vector3(message.move[0], message.move[1], message.move[2]);
    // Direction only: the client does not get to pick its own speed.
    (humanoid as unknown as { MoveDirection: Vector3 }).MoveDirection =
      move.magnitude > 1 ? move.unit : move;
    if (message.jump) (humanoid as unknown as { Jump: boolean }).Jump = true;
  }

  /**
   * Accepts state for parts this connection owns.
   *
   * Ownership is checked against NetworkOwnerId rather than anything in the
   * message, so a client cannot claim a part by asking. A server-authoritative
   * place ignores these messages entirely.
   */
  private handleState(session: PlayerSession, message: Extract<ClientMessage, { t: "state" }>): void {
    if (this.serverAuthoritative) return;
    if (message.seq <= session.lastSeq) return;
    session.lastSeq = message.seq;

    for (const update of message.parts) {
      const inst = this.game.byId.get(update.id);
      if (!(inst instanceof BasePart)) continue;
      if (inst.NetworkOwnerId !== session.player.id) continue;
      if (update.cf.length !== 12 || update.v.length !== 3) continue;
      if (!update.cf.every(Number.isFinite) || !update.v.every(Number.isFinite)) continue;

      const next = CFrame.fromComponents(update.cf);
      // A sanity bound, not an anti-cheat: it stops a broken or hostile client
      // from teleporting across the map, while leaving normal play untouched.
      const jump = next.position.sub(inst.CFrame.position).magnitude;
      if (jump > 512) {
        this.log(`rejected a ${Math.round(jump)} stud jump from ${session.player.Name}`);
        continue;
      }
      inst.setProperty("CFrame", next);
      inst.setProperty("AssemblyLinearVelocity", new Vector3(update.v[0], update.v[1], update.v[2]));
    }
  }

  private handleEdit(session: PlayerSession, message: Extract<ClientMessage, { t: "edit" }>): void {
    const terrain = this.game.Terrain as Terrain;
    const material = message.m | 0;
    if (material < 0 || material >= 16) return;
    const reach = 512;
    const root = this.rootPartOf(session.player);
    const origin = root ? root.CFrame.position : Vector3.zero;

    if (message.op === "set") {
      const [x, y, z] = message.a;
      const world = new Vector3(x * 4, y * 4, z * 4);
      if (world.sub(origin).magnitude > reach) return;
      terrain.SetVoxel(x | 0, y | 0, z | 0, material);
      return;
    }
    if (message.op === "ball") {
      const center = new Vector3(message.a[0], message.a[1], message.a[2]);
      if (center.sub(origin).magnitude > reach) return;
      const radius = Math.min(message.b?.[0] ?? 8, 32);
      terrain.FillBall(center, radius, material);
      return;
    }
    if (message.op === "block" && message.b) {
      const min = new Vector3(message.a[0], message.a[1], message.a[2]);
      const max = new Vector3(message.b[0], message.b[1], message.b[2]);
      if (min.sub(origin).magnitude > reach) return;
      if (max.sub(min).magnitude > 256) return;
      terrain.FillBlock(min, max, material);
    }
  }

  private handleRemote(session: PlayerSession, message: Extract<ClientMessage, { t: "remote" }>): void {
    const inst = this.game.byId.get(message.id);
    if (!(inst instanceof RemoteEvent)) return;
    // A client may only reach remotes it can actually see.
    if (!this.isClientVisible(inst)) return;
    inst.OnServerEvent.Fire(session.player, ...message.args);
  }

  private handleChat(session: PlayerSession, message: Extract<ClientMessage, { t: "chat" }>): void {
    const text = String(message.text ?? "").slice(0, 200).trim();
    if (!text) return;
    session.player.Chatted.Fire(text);
    this.broadcast({ t: "chat", from: session.player.Name, text });
  }

  private handleWantChunks(
    session: PlayerSession,
    message: Extract<ClientMessage, { t: "wantChunks" }>,
  ): void {
    const terrain = this.game.Terrain as Terrain;
    const chunks: Array<{ key: string; rle: string }> = [];
    for (const key of message.keys.slice(0, 32)) {
      if (!/^-?\d+,-?\d+,-?\d+$/.test(key)) continue;
      const [x, y, z] = parseChunkKey(key);
      const chunk = terrain.voxels.getChunk(x, y, z);
      session.sentChunks.add(key);
      if (!chunk || chunk.isEmpty) continue;
      chunks.push({ key, rle: encodeChunkRLE(chunk) });
    }
    if (chunks.length) session.connection.send({ t: "chunks", chunks });
  }

  /** Whether an instance lives somewhere clients replicate. */
  private isClientVisible(inst: EngineInstance): boolean {
    const roots = ["Workspace", "ReplicatedStorage", "ReplicatedFirst", "Players", "StarterPlayer"];
    for (const name of roots) {
      const service = this.game.FindService(name);
      if (service && (inst === service || inst.IsDescendantOf(service))) return true;
    }
    return false;
  }

  // -- remote routing ------------------------------------------------------

  /** Wires every RemoteEvent's transport to this server's connections. */
  private bindRemotes(): void {
    const bind = (inst: EngineInstance): void => {
      if (!(inst instanceof RemoteEvent)) return;
      inst.transport = {
        fireClient: (player, args) => {
          for (const session of this.sessions.values()) {
            if (session.player !== player) continue;
            session.connection.send({ t: "remote", id: inst.id, args });
          }
        },
        fireAllClients: (args) => {
          this.broadcast({ t: "remote", id: inst.id, args });
        },
      };
    };
    for (const inst of this.game.byId.values()) bind(inst);
    this.game.InstanceAdded.Connect(bind);
  }
}

function depthOf(game: DataModel, id: string): number {
  let inst = game.byId.get(id) ?? null;
  let depth = 0;
  while (inst?.Parent) {
    depth++;
    inst = inst.Parent;
  }
  return depth;
}

function sanitizeGuestName(raw: string): string {
  const cleaned = String(raw ?? "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 20);
  return cleaned.length >= 3 ? `${cleaned}` : `Guest${Math.floor(Math.random() * 9000) + 1000}`;
}

export { MATERIAL_ID };
