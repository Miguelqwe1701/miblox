import * as THREE from "three";
import {
  BasePart,
  CHUNK_STUDS,
  LocalScript,
  MATERIAL_ID,
  Vector3,
  type Lighting,
} from "@miblox/core";
import { ScriptEnvironment } from "@miblox/scripting";
// Copied into public/ by the prebuild step, so it is fetched at a stable path.
const wasmUrl = "/miblox.wasm";
import { Connection } from "./net.js";
import { TerrainView } from "./terrain-view.js";
import { SkyView, WorldView } from "./world-view.js";
import { Controls, detectPlatform } from "./controls.js";
import { CameraRig } from "./camera-rig.js";
import { ClientSimulation } from "./client-sim.js";
import { VRSupport } from "./vr.js";
import { Hud, type AccountSummary, type GameSummary } from "./hud.js";
import "./style.css";

/** How far, in chunks, terrain is requested around the player. */
const STREAM_RADIUS = 5;

class MibloxClient {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly hud: Hud;
  private readonly controls: Controls;
  private readonly clock = new THREE.Clock();
  private readonly playerRig = new THREE.Group();

  private connection: Connection | null = null;
  private terrainView: TerrainView | null = null;
  private worldView: WorldView | null = null;
  private skyView: SkyView | null = null;
  private simulation: ClientSimulation | null = null;
  private camera: CameraRig | null = null;
  private vr: VRSupport | null = null;
  private clientScripts: ScriptEnvironment | null = null;

  private account: AccountSummary | null = null;
  private pendingChunks = new Set<string>();
  private frameTimes: number[] = [];

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);
    this.scene.add(this.playerRig);

    this.controls = new Controls(this.renderer.domElement);
    this.hud = new Hud(container, {
      onPlay: (gameId) => void this.play(gameId),
      onSignIn: () => {
        window.location.href = "/auth/login";
      },
      onRename: (username) => this.rename(username),
    });

    window.addEventListener("resize", () => this.onResize());
    window.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && this.connection && !this.hud.chatFocused) {
        this.hud.focusChat();
        event.preventDefault();
      }
    });
    this.renderer.domElement.addEventListener("click", () => this.controls.requestPointerLock());
  }

  async boot(): Promise<void> {
    await this.loadAccount();
    await this.loadGames();
    // One render loop for the whole session; it idles until a game is joined.
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private async loadAccount(): Promise<void> {
    try {
      const res = await fetch("/api/me");
      const body = (await res.json()) as { account: AccountSummary | null };
      this.account = body.account;
    } catch {
      this.account = null;
    }
    this.hud.setAccount(this.account);
  }

  private async loadGames(): Promise<void> {
    try {
      const res = await fetch("/api/games");
      const body = (await res.json()) as { games: GameSummary[] };
      this.hud.showLobby(body.games);
    } catch {
      this.hud.showLobby([]);
      this.hud.toast("Could not reach the portal");
    }
  }

  private async rename(username: string): Promise<string | null> {
    try {
      const res = await fetch("/api/me/username", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });
      const body = (await res.json()) as { account?: AccountSummary; error?: string };
      if (!res.ok) return body.error ?? "Could not change that username";
      this.account = body.account ?? null;
      this.hud.setAccount(this.account);
      this.hud.toast(`You are now ${username}`);
      return null;
    } catch {
      return "Could not reach the portal";
    }
  }

  // -- joining -------------------------------------------------------------

  private async play(gameId: string): Promise<void> {
    this.hud.toast("Starting a server…", 8000);
    let info: { host: string; port: number; ticket: string; username: string | null };
    try {
      const res = await fetch("/api/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        this.hud.toast(body.error ?? "Could not join that game");
        return;
      }
      info = (await res.json()) as typeof info;
    } catch {
      this.hud.toast("Could not reach the portal");
      return;
    }

    const platform = detectPlatform();
    const connection = new Connection(
      {
        host: info.host,
        port: info.port,
        ticket: info.ticket,
        username: info.username ?? this.account?.username ?? "Guest",
        platform,
        secure: window.location.protocol === "https:",
      },
      {
        onState: (state, detail) => {
          if (state === "closed" || state === "error") {
            this.hud.toast(detail ?? "Disconnected");
            this.leave();
          }
        },
        onHello: () => void this.onJoined(),
        onChunks: (keys) => this.terrainView?.refresh(keys),
        onChat: (from, text) => this.hud.addChat(from, text),
        onDelta: () => this.onDelta(),
      },
    );
    this.connection = connection;
    connection.connect();
    this.hud.bindChat(connection);
    this.hud.enterGame(platform);
  }

  private async onJoined(): Promise<void> {
    const connection = this.connection;
    if (!connection) return;

    this.terrainView = new TerrainView(connection.game.Terrain.voxels);
    await this.terrainView.init(wasmUrl);
    this.scene.add(this.terrainView.group);

    this.worldView = new WorldView(connection.game);
    this.scene.add(this.worldView.group);

    this.skyView = new SkyView(this.scene, connection.game.Lighting as Lighting);
    this.simulation = new ClientSimulation(connection.game, connection);
    this.worldView.isLocallySimulated = (part) => this.simulation?.owns(part) ?? false;

    this.camera = new CameraRig(window.innerWidth / window.innerHeight, this.simulation.physics);

    this.vr = new VRSupport(this.renderer, this.controls, this.scene);
    const vrAvailable = await this.vr.init();
    this.hud.setVrAvailable(vrAvailable, () => {
      void this.vr?.enter().catch((err) => this.hud.toast(String(err.message ?? err)));
    });

    this.hud.bindTouchButtons(
      () => this.controls.pressJump(),
      () => {
        this.controls.state.primaryPressed = true;
      },
    );
    this.hud.toast(`Joined ${connection.placeName}`, 2500);
    this.startClientScripts();
  }

  /**
   * Runs LocalScripts from StarterPlayerScripts in a client-side Luau VM.
   *
   * This is the same interpreter the server uses, with `side: "client"`, so a
   * LocalScript gets FireServer but not FireClient.
   */
  private startClientScripts(): void {
    const connection = this.connection;
    if (!connection || !this.simulation) return;

    this.clientScripts = new ScriptEnvironment({
      game: connection.game,
      physics: this.simulation.physics,
      side: "client",
      onPrint: (text) => console.log("[client script]", text),
      onError: (message, source) => console.error(`[client script] ${source}: ${message}`),
    });

    const starter = connection.game.FindService("StarterPlayer")?.FindFirstChild("StarterPlayerScripts");
    for (const desc of starter?.GetDescendants() ?? []) {
      if (!(desc instanceof LocalScript) || !desc.Enabled || !desc.Source) continue;
      this.clientScripts.runScript(desc);
    }
  }

  private leave(): void {
    this.connection?.disconnect();
    this.connection = null;
    if (this.terrainView) {
      this.scene.remove(this.terrainView.group);
      this.terrainView.dispose();
      this.terrainView = null;
    }
    if (this.worldView) {
      this.scene.remove(this.worldView.group);
      this.worldView.dispose();
      this.worldView = null;
    }
    this.clientScripts?.vm.scheduler.clear();
    this.clientScripts = null;
    this.simulation = null;
    void this.loadGames();
  }

  private onDelta(): void {
    // A newly spawned character should appear where it is, not fly in.
    if (this.simulation?.root && !this.snapped) {
      this.worldView?.snap();
      this.snapped = true;
    }
  }

  private snapped = false;

  // -- the frame -----------------------------------------------------------

  private frame(): void {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.trackFps(dt);

    if (!this.connection || !this.camera || !this.simulation || !this.worldView) {
      return;
    }

    this.vr?.update();
    const input = this.controls.update();

    // Camera-relative movement, so forward always means away from the camera.
    const { forward, right } = this.camera.movementBasis();
    const world = new THREE.Vector3()
      .addScaledVector(forward, -input.move.y)
      .addScaledVector(right, input.move.x);
    const moveWorld = new Vector3(world.x, 0, world.z);

    this.simulation.step(dt, moveWorld, input.jump);
    this.clientScripts?.step(dt);

    if (input.primaryPressed) this.build(MATERIAL_ID.Rock);
    if (input.secondaryPressed) this.build(0);

    this.camera.update(input, this.simulation.root, dt);
    this.worldView.update(dt);
    this.streamTerrain();

    const focus = this.simulation.root
      ? new THREE.Vector3(
          this.simulation.root.CFrame.position.x,
          this.simulation.root.CFrame.position.y,
          this.simulation.root.CFrame.position.z,
        )
      : this.camera.camera.position;
    this.skyView?.update(focus);
    this.vr?.positionRig(this.playerRig, focus);

    this.hud.setCrosshair(this.controls.pointerLocked || this.camera.mode === "FirstPerson");
    this.updateStats();
    this.controls.endFrame();

    this.renderer.render(this.scene, this.camera.camera);
  }

  /** Digs or places terrain where the player is looking. */
  private build(material: number): void {
    const connection = this.connection;
    const camera = this.camera;
    const simulation = this.simulation;
    if (!connection || !camera || !simulation) return;

    const origin = camera.camera.position;
    const direction = new THREE.Vector3();
    camera.camera.getWorldDirection(direction);

    const hit = connection.game.Terrain.voxels.raycast(
      new Vector3(origin.x, origin.y, origin.z),
      new Vector3(direction.x, direction.y, direction.z),
      120,
    );
    if (!hit) return;

    // Removing targets the voxel hit; placing targets the empty one in front.
    const [vx, vy, vz] = hit.voxel;
    const target =
      material === 0
        ? [vx, vy, vz]
        : [vx + hit.normal.x, vy + hit.normal.y, vz + hit.normal.z];
    connection.editTerrain("set", target, material);
  }

  /** Asks for chunks near the player that have not arrived yet. */
  private streamTerrain(): void {
    const connection = this.connection;
    const root = this.simulation?.root;
    if (!connection || !root) return;

    const centre = root.CFrame.position;
    const cx = Math.floor(centre.x / CHUNK_STUDS);
    const cy = Math.floor(centre.y / CHUNK_STUDS);
    const cz = Math.floor(centre.z / CHUNK_STUDS);
    const wanted: string[] = [];

    for (let y = cy - 1; y <= cy + 1; y++) {
      for (let z = cz - STREAM_RADIUS; z <= cz + STREAM_RADIUS; z++) {
        for (let x = cx - STREAM_RADIUS; x <= cx + STREAM_RADIUS; x++) {
          const key = `${x},${y},${z}`;
          if (connection.game.Terrain.voxels.hasChunk(x, y, z)) continue;
          if (this.pendingChunks.has(key)) continue;
          this.pendingChunks.add(key);
          wanted.push(key);
          if (wanted.length >= 16) break;
        }
      }
    }
    if (wanted.length) connection.requestChunks(wanted);
  }

  private trackFps(dt: number): void {
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
  }

  private updateStats(): void {
    const average = this.frameTimes.reduce((a, b) => a + b, 0) / (this.frameTimes.length || 1);
    const fps = Math.round(1 / (average || 1 / 60));
    const connection = this.connection!;
    const root = this.simulation?.root;
    const position = root
      ? `${Math.round(root.CFrame.position.x)}, ${Math.round(root.CFrame.position.y)}, ${Math.round(
          root.CFrame.position.z,
        )}`
      : "-";

    this.hud.setStats([
      `${connection.placeName}`,
      `${fps} fps · ${connection.ping} ms`,
      `Position ${position}`,
      `Terrain ${this.terrainView?.stats.chunks ?? 0} chunks · ${
        this.terrainView?.stats.triangles ?? 0
      } tris (${this.terrainView?.stats.backend ?? "-"})`,
      `Parts ${this.worldView?.partCount ?? 0} · Players ${connection.game.Players.GetPlayers().length}`,
      connection.serverAuthoritative ? "Server authoritative" : "You own your character",
    ]);
  }

  private onResize(): void {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.camera?.setAspect(window.innerWidth / window.innerHeight);
  }
}

const container = document.getElementById("app") ?? document.body;
const client = new MibloxClient(container);
void client.boot();

// Exposed so the Playwright-driven demo can drive a session deterministically.
(window as unknown as { miblox: MibloxClient }).miblox = client;
