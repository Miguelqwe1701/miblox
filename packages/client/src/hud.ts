import type { Connection } from "./net.js";
import type { Platform } from "./controls.js";

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

type LobbyHandlers = {
  onPlay(gameId: string): void;
  onSignIn(): void;
  onRename(username: string): Promise<string | null>;
};

/**
 * Everything the player sees that is not the 3D scene: the lobby, the in-game
 * HUD, chat and the mobile buttons.
 *
 * Plain DOM rather than a framework, because the interesting part of this
 * project is the engine and a UI framework would only add a build step.
 */
export class Hud {
  readonly root: HTMLDivElement;
  private lobby: HTMLDivElement;
  private overlay: HTMLDivElement;
  private statsEl: HTMLDivElement;
  private chatLog: HTMLDivElement;
  private chatInput: HTMLInputElement;
  private toastEl: HTMLDivElement;
  private accountEl: HTMLDivElement;
  private touchControls: HTMLDivElement;

  constructor(parent: HTMLElement, private readonly handlers: LobbyHandlers) {
    this.root = document.createElement("div");
    this.root.className = "miblox-ui";
    this.root.innerHTML = TEMPLATE;
    parent.appendChild(this.root);

    this.lobby = this.$(".lobby");
    this.overlay = this.$(".hud");
    this.statsEl = this.$(".stats");
    this.chatLog = this.$(".chat-log");
    this.chatInput = this.$(".chat-input");
    this.toastEl = this.$(".toast");
    this.accountEl = this.$(".account");
    this.touchControls = this.$(".touch-controls");

    this.$<HTMLButtonElement>(".sign-in").addEventListener("click", () => handlers.onSignIn());
    this.$<HTMLButtonElement>(".rename").addEventListener("click", () => this.promptRename());
  }

  private $<T extends HTMLElement>(selector: string): T {
    const found = this.root.querySelector<T>(selector);
    if (!found) throw new Error(`HUD is missing ${selector}`);
    return found;
  }

  // -- lobby ---------------------------------------------------------------

  showLobby(games: GameSummary[]): void {
    this.lobby.hidden = false;
    this.overlay.hidden = true;
    const list = this.$(".game-list");
    list.innerHTML = "";

    if (!games.length) {
      list.innerHTML = `<p class="empty">No places are published yet. Run <code>npm run place:build</code> to create one.</p>`;
      return;
    }

    for (const game of games) {
      const card = document.createElement("button");
      card.className = "game-card";
      card.innerHTML = `
        <div class="game-thumb" aria-hidden="true"></div>
        <div class="game-body">
          <h3>${escapeHtml(game.name)}</h3>
          <p>${escapeHtml(game.description || "No description")}</p>
          <span class="game-meta">Up to ${game.maxPlayers} players${
            game.serverAuthoritative ? " · Server authoritative" : ""
          }</span>
        </div>`;
      card.addEventListener("click", () => this.handlers.onPlay(game.id));
      list.appendChild(card);
    }
  }

  setAccount(account: AccountSummary | null): void {
    if (account) {
      this.accountEl.innerHTML = `Signed in as <strong>${escapeHtml(account.username)}</strong>`;
      this.$<HTMLButtonElement>(".sign-in").hidden = true;
      this.$<HTMLButtonElement>(".rename").hidden = false;
    } else {
      this.accountEl.textContent = "Playing as a guest";
      this.$<HTMLButtonElement>(".sign-in").hidden = false;
      this.$<HTMLButtonElement>(".rename").hidden = true;
    }
  }

  private async promptRename(): Promise<void> {
    const next = window.prompt("Choose a username (3-20 letters, numbers or underscores)");
    if (!next) return;
    const error = await this.handlers.onRename(next.trim());
    if (error) this.toast(error);
  }

  // -- in game -------------------------------------------------------------

  enterGame(platform: Platform): void {
    this.lobby.hidden = true;
    this.overlay.hidden = false;
    this.touchControls.hidden = platform !== "Mobile";
  }

  setStats(lines: string[]): void {
    this.statsEl.innerHTML = lines.map((line) => `<div>${escapeHtml(line)}</div>`).join("");
  }

  setVrAvailable(available: boolean, onEnter: () => void): void {
    const button = this.$<HTMLButtonElement>(".vr-button");
    button.hidden = !available;
    button.onclick = onEnter;
  }

  addChat(from: string, text: string): void {
    const line = document.createElement("div");
    line.className = "chat-line";
    line.innerHTML = `<span class="chat-from">${escapeHtml(from)}</span> ${escapeHtml(text)}`;
    this.chatLog.appendChild(line);
    // Keep the log short; an unbounded DOM list is a slow memory leak.
    while (this.chatLog.childElementCount > 60) this.chatLog.firstElementChild?.remove();
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  bindChat(connection: Connection): void {
    this.chatInput.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key !== "Enter") return;
      const text = this.chatInput.value.trim();
      this.chatInput.value = "";
      this.chatInput.blur();
      if (text) connection.chat(text);
    });
  }

  focusChat(): void {
    this.chatInput.focus();
  }

  get chatFocused(): boolean {
    return document.activeElement === this.chatInput;
  }

  bindTouchButtons(onJump: () => void, onAction: () => void): void {
    this.$<HTMLButtonElement>(".btn-jump").addEventListener("touchstart", (e) => {
      e.preventDefault();
      onJump();
    });
    this.$<HTMLButtonElement>(".btn-action").addEventListener("touchstart", (e) => {
      e.preventDefault();
      onAction();
    });
  }

  toast(message: string, ms = 4000): void {
    this.toastEl.textContent = message;
    this.toastEl.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.hidden = true;
    }, ms);
  }

  private toastTimer = 0;

  setCrosshair(visible: boolean): void {
    this.$(".crosshair").hidden = !visible;
  }
}

function escapeHtml(text: string): string {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

const TEMPLATE = `
<div class="lobby">
  <header class="lobby-head">
    <h1>MiBlox</h1>
    <div class="lobby-account">
      <span class="account">Playing as a guest</span>
      <button class="sign-in">Sign in with Migood</button>
      <button class="rename" hidden>Change username</button>
    </div>
  </header>
  <p class="lobby-sub">Build, script and play. Browser, desktop, phone and VR.</p>
  <div class="game-list"></div>
</div>

<div class="hud" hidden>
  <div class="crosshair" hidden></div>
  <div class="stats"></div>
  <button class="vr-button" hidden>Enter VR</button>
  <div class="chat">
    <div class="chat-log"></div>
    <input class="chat-input" placeholder="Press Enter to chat" maxlength="200" />
  </div>
  <div class="touch-controls" hidden>
    <button class="btn-jump">Jump</button>
    <button class="btn-action">Build</button>
  </div>
</div>

<div class="toast" hidden></div>
`;
