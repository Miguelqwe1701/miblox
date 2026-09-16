import * as THREE from "three";
import {
  CHUNK_STUDS,
  LocalScript,
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
import { LobbyKiosks } from "./lobby.js";
import { HOTBAR } from "./hotbar.js";
import { loadSettings, saveSettings, type Settings } from "./settings.js";
import "./style.css";

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
  private settings: Settings = loadSettings();
  private currentGameId: string | null = null;
  private playerListShown = false;
  private games: GameSummary[] = [];
  private kiosks: LobbyKiosks | null = null;
  private aimedAt: { gameId: string; name: string } | null = null;
  private lobbyHint: HTMLDivElement | null = null;
  private joining = false;

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);
    this.scene.add(this.playerRig);

    this.renderer.shadowMap.enabled = this.settings.shadows;

    this.controls = new Controls(this.renderer.domElement);
    this.controls.sensitivity = this.settings.sensitivity;
    this.controls.invertY = this.settings.invertY;

    this.hud = new Hud(
      container,
      {
        onPlay: (gameId) => void this.play(gameId),
        onSignIn: () => {
          window.location.href = "/auth/login";
        },
        onRename: (username) => this.rename(username),
        onLeave: () => this.leave(),
        onSettingChange: (key, value) => this.applySetting(key, value),
        onSlotSelected: () => {},
        onJump: () => this.controls.pressJump(),
        onAction: () => {
          this.controls.state.primaryPressed = true;
        },
        onOpenStudio: (gameId) => {
          window.location.href = `/studio/${gameId}`;
        },
        onEnterLobby: () => void this.play("lobby"),
        onEnterVr: () => void this.enterVr(),
      },
      this.settings,
    );

    window.addEventListener("resize", () => this.onResize());
    window.addEventListener("keydown", (event) => this.onKeyDown(event));
    window.addEventListener("keyup", (event) => {
      if (event.code === "Tab" && this.playerListShown) {
        this.playerListShown = false;
        this.hud.setPlayerListVisible(false);
      }
    });
    this.renderer.domElement.addEventListener("click", () => {
      if (!this.hud.isPaused && this.connection) this.controls.requestPointerLock();
    });
    this.renderer.domElement.addEventListener("wheel", (event) => {
      // Shift-scroll cycles the hotbar; plain scroll zooms the camera.
      if (!event.shiftKey) return;
      event.preventDefault();
      this.hud.cycleSlot(Math.sign(event.deltaY));
    });
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (this.hud.chatFocused) return;

    if (event.code === "Escape" && this.connection) {
      const paused = this.hud.togglePaused();
      if (paused && document.pointerLockElement) document.exitPointerLock();
      event.preventDefault();
      return;
    }
    if (this.hud.isPaused) return;

    if (event.key === "Enter" && this.connection) {
      this.hud.focusChat();
      event.preventDefault();
      return;
    }
    if (event.code === "F3") {
      const shown = this.hud.toggleStats();
      this.applySetting("showStats", shown);
      event.preventDefault();
      return;
    }
    if (event.code === "Tab" && this.connection) {
      this.playerListShown = true;
      this.hud.setPlayerListVisible(true);
      event.preventDefault();
      return;
    }
    // Number keys pick a hotbar slot.
    const digit = Number(event.key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= HOTBAR.length) {
      this.hud.selectSlot(digit - 1);
    }
  }

  private applySetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.settings = { ...this.settings, [key]: value };
    saveSettings(this.settings);

    switch (key) {
      case "sensitivity":
        this.controls.sensitivity = this.settings.sensitivity;
        break;
      case "invertY":
        this.controls.invertY = this.settings.invertY;
        break;
      case "fieldOfView":
        if (this.camera) {
          this.camera.camera.fov = this.settings.fieldOfView;
          this.camera.camera.updateProjectionMatrix();
        }
        break;
      case "shadows":
        this.renderer.shadowMap.enabled = this.settings.shadows;
        // Materials compiled for the old setting must be rebuilt.
        this.scene.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (mesh.material) (mesh.material as THREE.Material).needsUpdate = true;
        });
        break;
      case "terrainStyle":
        if (this.terrainView) {
          this.terrainView.style = this.settings.terrainStyle;
          this.terrainView.rebuildAll();
        }
        break;
      default:
        break;
    }
  }

  /**
   * Sets up WebXR and reports whether a headset is present.
   *
   * Done once at boot rather than on joining a world, so the menu can offer
   * VR up front: on desktop that means being asked on launch instead of
   * discovering the option after picking a game.
   */
  private async setUpVr(): Promise<void> {
    this.vr = new VRSupport(this.renderer, this.controls, this.scene);
    const available = await this.vr.init();
    this.hud.setVrAvailable(available, () => void this.enterVr());

    if (!available) return;
    // The desktop shell has no address bar to fall back on, so it asks.
    const isDesktopApp = Boolean((window as { miblox?: { isDesktopApp?: boolean } }).miblox?.isDesktopApp);
    if (this.settings.askForVr && isDesktopApp) this.hud.showVrPrompt();
  }

  /** Enters VR, heading for the lobby first if we are not in a world yet. */
  private async enterVr(): Promise<void> {
    if (!this.vr?.available) {
      this.hud.toast("No VR headset was detected in this browser");
      return;
    }
    try {
      if (!this.connection) await this.play("lobby");
      await this.vr.enter();
    } catch (err) {
      this.hud.toast(String((err as Error).message ?? err));
    }
  }

  async boot(): Promise<void> {
    await this.loadAccount();
    await this.loadGames();
    await this.setUpVr();
    if (this.settings.autoLobby) void this.play("lobby");
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
      this.games = body.games;
      // The lobby is the way in, not an entry in the list of destinations.
      this.hud.showMenu(body.games.filter((game) => game.id !== "lobby"));
    } catch {
      this.hud.showMenu([]);
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
    this.currentGameId = gameId;
    this.hud.showLoading("Joining", "Starting a server for you");
    let info: { host: string; port: number; ticket: string; username: string | null };
    try {
      const res = await fetch("/api/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        this.hud.toast(body.error ?? "Could not join that world");
        void this.loadGames();
        return;
      }
      info = (await res.json()) as typeof info;
    } catch {
      this.hud.toast("Could not reach the portal");
      void this.loadGames();
      return;
    }
    this.hud.setLoadingDetail("Connecting");

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
    this.hud.bindConnection(connection);
  }

  private async onJoined(): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    this.hud.setLoadingDetail("Building the world");

    this.terrainView = new TerrainView(connection.game.Terrain.voxels);
    this.terrainView.style = this.settings.terrainStyle;
    await this.terrainView.init(wasmUrl);
    this.scene.add(this.terrainView.group);

    this.worldView = new WorldView(connection.game);
    this.scene.add(this.worldView.group);

    this.skyView = new SkyView(this.scene, connection.game.Lighting as Lighting);
    this.simulation = new ClientSimulation(connection.game, connection);
    this.worldView.isLocallySimulated = (part) => this.simulation?.owns(part) ?? false;

    this.camera = new CameraRig(window.innerWidth / window.innerHeight, this.simulation.physics);
    this.camera.camera.fov = this.settings.fieldOfView;
    this.camera.camera.updateProjectionMatrix();

    if (this.currentGameId === "lobby") this.setUpLobby();

    this.hud.setPlaceName(connection.placeName);
    this.hud.enterGame(detectPlatform(), { building: this.currentGameId !== "lobby" });
    this.hud.addSystemChat(`Welcome to ${connection.placeName}. Press Esc for the menu.`);
    this.startClientScripts();
  }

  /**
   * Draws the catalogue into the lobby as panels you can point at.
   *
   * Local decoration rather than replicated instances: the list of worlds
   * changes as things are published, and nobody should have to rebuild the
   * lobby place for that.
   */
  private setUpLobby(): void {
    this.kiosks = new LobbyKiosks((selection) => {
      if (this.joining) return;
      this.hud.toast(`Joining ${selection.name}…`);
      void this.switchWorld(selection.gameId);
    });
    this.kiosks.build(this.games);
    this.scene.add(this.kiosks.group);

    this.lobbyHint = document.createElement("div");
    this.lobbyHint.className = "lobby-hint";
    this.lobbyHint.hidden = true;
    this.hud.root.appendChild(this.lobbyHint);
  }

  /** Leaves the current world and joins another, keeping any VR session. */
  private async switchWorld(gameId: string): Promise<void> {
    if (this.joining) return;
    this.joining = true;
    this.leave(false);
    await this.play(gameId);
    this.joining = false;
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

  /**
   * Leaves the current world.
   *
   * `toMenu` is false when switching worlds: reloading the catalogue would
   * race the new connection and flash the menu over the loading screen.
   */
  private leave(toMenu = true): void {
    this.connection?.disconnect();
    this.connection = null;
    this.snapped = false;
    this.pendingChunks.clear();
    this.currentGameId = null;
    if (this.kiosks) {
      this.scene.remove(this.kiosks.group);
      this.kiosks.clear();
      this.kiosks = null;
    }
    this.lobbyHint?.remove();
    this.lobbyHint = null;
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
    if (toMenu) void this.loadGames();
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
    // While paused the world keeps ticking, but input does not reach the player.
    if (this.hud.isPaused) {
      this.worldView.update(dt);
      this.renderer.render(this.scene, this.camera.camera);
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

    if (this.kiosks) {
      this.updateLobbyAim();
      // In the lobby, the primary action picks a world rather than building.
      if (input.primaryPressed && this.kiosks.select()) {
        this.controls.endFrame();
        return;
      }
      this.kiosks.update(dt);
    } else {
      // Left click uses the held slot; right click always digs.
      if (input.primaryPressed) this.build(this.hud.slot.material);
      if (input.secondaryPressed) this.build(0);
    }

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
    this.updateVitals();
    this.updateStats();
    this.controls.endFrame();

    this.renderer.render(this.scene, this.camera.camera);
  }

  /**
   * Points at lobby panels.
   *
   * In VR the ray comes from the controller; otherwise from the camera. Both
   * go through the same call, so the two feel the same and there is one path
   * to keep working.
   */
  private updateLobbyAim(): void {
    const kiosks = this.kiosks;
    const camera = this.camera;
    if (!kiosks || !camera) return;

    let origin = camera.camera.position.clone();
    const direction = new THREE.Vector3();
    const controller = this.vr?.active ? this.vr.controllers[1] ?? this.vr.controllers[0] : null;
    if (controller) {
      controller.getWorldPosition(origin);
      controller.getWorldDirection(direction);
      // A controller's ray points along its negative Z.
      direction.negate();
    } else {
      camera.camera.getWorldDirection(direction);
    }

    this.aimedAt = kiosks.aim(origin, direction);
    if (this.lobbyHint) {
      this.lobbyHint.hidden = !this.aimedAt;
      if (this.aimedAt) this.lobbyHint.textContent = `Play ${this.aimedAt.name}`;
    }
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

    const radius = this.settings.viewDistance;
    const centre = root.CFrame.position;
    const cx = Math.floor(centre.x / CHUNK_STUDS);
    const cy = Math.floor(centre.y / CHUNK_STUDS);
    const cz = Math.floor(centre.z / CHUNK_STUDS);
    const wanted: string[] = [];

    for (let y = cy - 1; y <= cy + 1; y++) {
      for (let z = cz - radius; z <= cz + radius; z++) {
        for (let x = cx - radius; x <= cx + radius; x++) {
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

  private updateVitals(): void {
    const connection = this.connection;
    if (!connection) return;
    const humanoid = this.simulation?.humanoid;
    if (humanoid) this.hud.setHealth(humanoid.Health, humanoid.MaxHealth);

    const players = connection.game.Players.GetPlayers().map((p) => p.Name);
    this.hud.setPlayers(players, connection.localPlayer?.Name ?? "");
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
      `${fps} fps · ${connection.ping} ms ping`,
      `xyz ${position}`,
      `terrain ${this.terrainView?.stats.chunks ?? 0} chunks, ${
        this.terrainView?.stats.triangles ?? 0
      } tris (${this.terrainView?.stats.backend ?? "-"}, ${this.settings.terrainStyle})`,
      `parts ${this.worldView?.partCount ?? 0}`,
      connection.serverAuthoritative ? "server authoritative" : "client owns character",
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
