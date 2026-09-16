import { HOTBAR, type HotbarSlot } from "./hotbar.js";
import type { Settings } from "./settings.js";
import type { Platform } from "./controls.js";
import type { Connection } from "./net.js";

export interface GameSummary {
  id: string;
  name: string;
  description: string;
  maxPlayers: number;
  serverAuthoritative: boolean;
}

export interface AccountSummary {
  id: string;
  username: string;
  displayName: string;
  avatar?: string;
}

export interface HudHandlers {
  onPlay(gameId: string): void;
  onSignIn(): void;
  onRename(username: string): Promise<string | null>;
  onLeave(): void;
  onSettingChange<K extends keyof Settings>(key: K, value: Settings[K]): void;
  onSlotSelected(index: number): void;
  onJump(): void;
  onAction(): void;
  onOpenStudio(gameId: string): void;
}

type Screen = "menu" | "loading" | "game";

/**
 * Everything the player sees that is not the 3D scene.
 *
 * Plain DOM: the interesting part of this project is the engine, and a UI
 * framework would add a build step without making these panels any better.
 */
export class Hud {
  readonly root: HTMLDivElement;
  private handlers: HudHandlers;
  private screen: Screen = "menu";
  private selectedSlot = 0;
  private paused = false;
  private statsVisible = false;

  constructor(parent: HTMLElement, handlers: HudHandlers, settings: Settings) {
    this.handlers = handlers;
    this.root = document.createElement("div");
    this.root.className = "ui";
    this.root.innerHTML = TEMPLATE;
    parent.appendChild(this.root);

    this.buildHotbar();
    this.bindMenu();
    this.bindPause();
    this.bindSettings(settings);
    this.bindChat();
    this.bindTouch();
    this.statsVisible = settings.showStats;
    this.el(".stats").hidden = !this.statsVisible;
  }

  private el<T extends HTMLElement>(selector: string): T {
    const found = this.root.querySelector<T>(selector);
    if (!found) throw new Error(`HUD is missing ${selector}`);
    return found;
  }

  private all<T extends HTMLElement>(selector: string): T[] {
    return [...this.root.querySelectorAll<T>(selector)];
  }

  // -- screens -------------------------------------------------------------

  private show(screen: Screen): void {
    this.screen = screen;
    this.el(".menu").hidden = screen !== "menu";
    this.el(".loading").hidden = screen !== "loading";
    this.el(".game").hidden = screen !== "game";
  }

  showMenu(games: GameSummary[]): void {
    this.show("menu");
    this.paused = false;
    this.el(".pause").hidden = true;
    const list = this.el(".game-list");
    list.innerHTML = "";

    if (!games.length) {
      list.innerHTML =
        `<p class="empty">No worlds published yet. Run <code>npm run place:build</code> to create one.</p>`;
      return;
    }

    for (const game of games) {
      const card = document.createElement("article");
      card.className = "card";
      card.innerHTML = `
        <div class="card-art" aria-hidden="true"><span>${escapeHtml(initials(game.name))}</span></div>
        <div class="card-body">
          <h3>${escapeHtml(game.name)}</h3>
          <p>${escapeHtml(game.description || "No description")}</p>
          <div class="card-meta">
            <span class="pill">${game.maxPlayers} players</span>
            ${game.serverAuthoritative ? '<span class="pill">Server authoritative</span>' : ""}
          </div>
          <div class="card-actions">
            <button class="primary play">Play</button>
            <button class="ghost studio">Studio</button>
          </div>
        </div>`;
      card.querySelector<HTMLButtonElement>(".play")!.addEventListener("click", () =>
        this.handlers.onPlay(game.id),
      );
      card.querySelector<HTMLButtonElement>(".studio")!.addEventListener("click", () =>
        this.handlers.onOpenStudio(game.id),
      );
      list.appendChild(card);
    }
  }

  showLoading(name: string, detail = "Starting a server for you"): void {
    this.show("loading");
    this.el(".loading-title").textContent = name;
    this.el(".loading-detail").textContent = detail;
  }

  setLoadingDetail(detail: string): void {
    this.el(".loading-detail").textContent = detail;
  }

  enterGame(platform: Platform): void {
    this.show("game");
    this.el(".touch").hidden = platform !== "Mobile";
  }

  setAccount(account: AccountSummary | null): void {
    const label = this.el(".account-name");
    label.textContent = account ? account.username : "Guest";
    this.el<HTMLButtonElement>(".sign-in").hidden = !!account;
    this.el<HTMLButtonElement>(".rename").hidden = !account;
  }

  // -- main menu -----------------------------------------------------------

  private bindMenu(): void {
    this.el<HTMLButtonElement>(".sign-in").addEventListener("click", () => this.handlers.onSignIn());
    this.el<HTMLButtonElement>(".rename").addEventListener("click", async () => {
      const next = window.prompt("Choose a username (3-20 letters, numbers or underscores)");
      if (!next) return;
      const error = await this.handlers.onRename(next.trim());
      if (error) this.toast(error);
    });
  }

  // -- pause menu ----------------------------------------------------------

  private bindPause(): void {
    this.el<HTMLButtonElement>(".resume").addEventListener("click", () => this.setPaused(false));
    this.el<HTMLButtonElement>(".leave").addEventListener("click", () => {
      this.setPaused(false);
      this.handlers.onLeave();
    });
    this.el<HTMLButtonElement>(".open-settings").addEventListener("click", () => {
      this.el(".settings").hidden = false;
    });
    this.el<HTMLButtonElement>(".close-settings").addEventListener("click", () => {
      this.el(".settings").hidden = true;
    });
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.el(".pause").hidden = !paused;
    if (!paused) this.el(".settings").hidden = true;
  }

  togglePaused(): boolean {
    this.setPaused(!this.paused);
    return this.paused;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get currentScreen(): Screen {
    return this.screen;
  }

  // -- settings ------------------------------------------------------------

  private bindSettings(settings: Settings): void {
    const bindRange = (selector: string, key: keyof Settings, format: (v: number) => string) => {
      const input = this.el<HTMLInputElement>(selector);
      const output = this.el(`${selector}-value`);
      input.value = String(settings[key]);
      output.textContent = format(Number(settings[key]));
      input.addEventListener("input", () => {
        const value = Number(input.value);
        output.textContent = format(value);
        this.handlers.onSettingChange(key, value as never);
      });
    };
    bindRange(".set-sensitivity", "sensitivity", (v) => `${v.toFixed(2)}x`);
    bindRange(".set-fov", "fieldOfView", (v) => `${Math.round(v)}°`);
    bindRange(".set-view", "viewDistance", (v) => `${Math.round(v)} chunks`);

    const bindToggle = (selector: string, key: keyof Settings) => {
      const input = this.el<HTMLInputElement>(selector);
      input.checked = Boolean(settings[key]);
      input.addEventListener("change", () =>
        this.handlers.onSettingChange(key, input.checked as never),
      );
    };
    bindToggle(".set-shadows", "shadows");
    bindToggle(".set-invert", "invertY");

    const style = this.el<HTMLSelectElement>(".set-terrain");
    style.value = settings.terrainStyle;
    style.addEventListener("change", () =>
      this.handlers.onSettingChange("terrainStyle", style.value as never),
    );
  }

  // -- hotbar --------------------------------------------------------------

  private buildHotbar(): void {
    const bar = this.el(".hotbar");
    bar.innerHTML = "";
    HOTBAR.forEach((slot, index) => {
      const button = document.createElement("button");
      button.className = "slot";
      button.innerHTML = `
        <span class="swatch" style="background:${slot.color}"></span>
        <span class="slot-name">${escapeHtml(slot.name)}</span>
        <span class="slot-key">${index + 1}</span>`;
      button.title = slot.hint;
      button.addEventListener("click", () => this.selectSlot(index));
      bar.appendChild(button);
    });
    this.selectSlot(0);
  }

  selectSlot(index: number): void {
    this.selectedSlot = (index + HOTBAR.length) % HOTBAR.length;
    this.all(".slot").forEach((slot, i) =>
      slot.classList.toggle("selected", i === this.selectedSlot),
    );
    this.handlers.onSlotSelected(this.selectedSlot);
  }

  cycleSlot(delta: number): void {
    this.selectSlot(this.selectedSlot + delta);
  }

  get slot(): HotbarSlot {
    return HOTBAR[this.selectedSlot];
  }

  // -- vitals, players, chat ----------------------------------------------

  setHealth(current: number, max: number): void {
    const ratio = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
    this.el<HTMLDivElement>(".health-fill").style.width = `${ratio * 100}%`;
    this.el(".health-value").textContent = `${Math.ceil(current)}`;
    this.el(".health").classList.toggle("hurt", ratio < 0.35);
  }

  setPlayers(names: string[], localName: string): void {
    this.el(".player-count").textContent = String(names.length);
    const list = this.el(".player-list");
    list.innerHTML = names
      .map(
        (name) =>
          `<li${name === localName ? ' class="you"' : ""}>${escapeHtml(name)}${
            name === localName ? " <span>(you)</span>" : ""
          }</li>`,
      )
      .join("");
  }

  setPlayerListVisible(visible: boolean): void {
    this.el(".players").hidden = !visible;
  }

  private bindChat(): void {
    const input = this.el<HTMLInputElement>(".chat-input");
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        input.value = "";
        input.blur();
        return;
      }
      if (event.key !== "Enter") return;
      const text = input.value.trim();
      input.value = "";
      input.blur();
      if (text && this.chatSender) this.chatSender(text);
    });
  }

  private chatSender: ((text: string) => void) | null = null;

  bindConnection(connection: Connection): void {
    this.chatSender = (text) => connection.chat(text);
  }

  addChat(from: string, text: string): void {
    const line = document.createElement("div");
    line.className = "chat-line";
    line.innerHTML = `<span class="chat-from">${escapeHtml(from)}</span> ${escapeHtml(text)}`;
    const log = this.el(".chat-log");
    log.appendChild(line);
    // Unbounded logs are a slow memory leak and push the layout around.
    while (log.childElementCount > 60) log.firstElementChild?.remove();
    log.scrollTop = log.scrollHeight;
  }

  addSystemChat(text: string): void {
    const line = document.createElement("div");
    line.className = "chat-line system";
    line.textContent = text;
    const log = this.el(".chat-log");
    log.appendChild(line);
    while (log.childElementCount > 60) log.firstElementChild?.remove();
    log.scrollTop = log.scrollHeight;
  }

  focusChat(): void {
    this.el<HTMLInputElement>(".chat-input").focus();
  }

  get chatFocused(): boolean {
    return document.activeElement === this.root.querySelector(".chat-input");
  }

  // -- misc ----------------------------------------------------------------

  private bindTouch(): void {
    this.el<HTMLButtonElement>(".btn-jump").addEventListener("touchstart", (event) => {
      event.preventDefault();
      this.handlers.onJump();
    });
    this.el<HTMLButtonElement>(".btn-action").addEventListener("touchstart", (event) => {
      event.preventDefault();
      this.handlers.onAction();
    });
  }

  setVrAvailable(available: boolean, onEnter: () => void): void {
    const button = this.el<HTMLButtonElement>(".vr-button");
    button.hidden = !available;
    button.onclick = onEnter;
  }

  toggleStats(): boolean {
    this.statsVisible = !this.statsVisible;
    this.el(".stats").hidden = !this.statsVisible;
    return this.statsVisible;
  }

  setStats(lines: string[]): void {
    if (!this.statsVisible) return;
    this.el(".stats").innerHTML = lines.map((line) => `<div>${escapeHtml(line)}</div>`).join("");
  }

  setCrosshair(visible: boolean): void {
    this.el(".crosshair").hidden = !visible;
  }

  setPlaceName(name: string): void {
    this.el(".place-name").textContent = name;
  }

  toast(message: string, ms = 3500): void {
    const el = this.el(".toast");
    el.textContent = message;
    el.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      el.hidden = true;
    }, ms);
  }

  private toastTimer = 0;
}

function escapeHtml(text: string): string {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? "")
    .join("")
    .toUpperCase();
}

const TEMPLATE = `
<section class="menu">
  <div class="menu-inner">
    <header class="menu-head">
      <div class="brand"><span class="brand-mark"></span><h1>MiBlox</h1></div>
      <div class="account">
        <span class="account-chip"><span class="account-dot"></span><span class="account-name">Guest</span></span>
        <a class="ghost link-button" href="/avatar">Avatar</a>
        <button class="primary sign-in">Sign in with Migood</button>
        <button class="ghost rename" hidden>Change username</button>
      </div>
    </header>
    <p class="tagline">Build it, script it, play it. Browser, desktop, phone and VR.</p>
    <h2 class="section-title">Worlds</h2>
    <div class="game-list"></div>
  </div>
</section>

<section class="loading" hidden>
  <div class="spinner"></div>
  <h2 class="loading-title">Loading</h2>
  <p class="loading-detail">Starting a server for you</p>
</section>

<section class="game" hidden>
  <div class="crosshair" hidden></div>

  <div class="top-left">
    <span class="place-name"></span>
  </div>

  <div class="stats" hidden></div>
  <button class="vr-button" hidden>Enter VR</button>

  <div class="players" hidden>
    <h3>Players <span class="player-count">0</span></h3>
    <ul class="player-list"></ul>
  </div>

  <div class="bottom">
    <div class="chat">
      <div class="chat-log"></div>
      <input class="chat-input" placeholder="Press Enter to chat" maxlength="200" />
    </div>
    <div class="bottom-right">
      <div class="health">
        <div class="health-bar"><div class="health-fill"></div></div>
        <span class="health-value">100</span>
      </div>
      <div class="hotbar"></div>
    </div>
  </div>

  <div class="touch" hidden>
    <button class="btn-jump">Jump</button>
    <button class="btn-action">Build</button>
  </div>

  <div class="pause" hidden>
    <div class="pause-card">
      <h2>Paused</h2>
      <button class="primary resume">Resume</button>
      <button class="ghost open-settings">Settings</button>
      <button class="ghost leave">Leave world</button>
      <p class="pause-hint">Esc to resume · Tab for players · F3 for stats</p>
    </div>

    <div class="settings" hidden>
      <div class="settings-card">
        <h3>Settings</h3>
        <label class="row">
          <span>Mouse sensitivity</span>
          <input class="set-sensitivity" type="range" min="0.25" max="3" step="0.05" />
          <output class="set-sensitivity-value"></output>
        </label>
        <label class="row">
          <span>Field of view</span>
          <input class="set-fov" type="range" min="50" max="110" step="1" />
          <output class="set-fov-value"></output>
        </label>
        <label class="row">
          <span>View distance</span>
          <input class="set-view" type="range" min="2" max="8" step="1" />
          <output class="set-view-value"></output>
        </label>
        <label class="row">
          <span>Terrain</span>
          <select class="set-terrain">
            <option value="smooth">Smooth</option>
            <option value="blocky">Blocky</option>
          </select>
        </label>
        <label class="row toggle">
          <span>Shadows</span>
          <input class="set-shadows" type="checkbox" />
        </label>
        <label class="row toggle">
          <span>Invert look</span>
          <input class="set-invert" type="checkbox" />
        </label>
        <button class="primary close-settings">Done</button>
      </div>
    </div>
  </div>
</section>

<div class="toast" hidden></div>
`;
