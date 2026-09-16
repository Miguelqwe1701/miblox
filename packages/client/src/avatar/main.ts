import {
  DEFAULT_DESCRIPTION,
  validateDescription,
  type AssetInfo,
  type AssetType,
  type HumanoidDescriptionData,
} from "@miblox/core";
import { AvatarPreview } from "./preview.js";
import "./avatar.css";

interface Account {
  id: string;
  username: string;
  displayName: string;
}

/** Body colour slots, in the order they are shown. */
const COLOUR_SLOTS: Array<{ field: keyof HumanoidDescriptionData; label: string }> = [
  { field: "headColor", label: "Head" },
  { field: "torsoColor", label: "Torso" },
  { field: "leftArmColor", label: "Left arm" },
  { field: "rightArmColor", label: "Right arm" },
  { field: "leftLegColor", label: "Left leg" },
  { field: "rightLegColor", label: "Right leg" },
];

/** A few ready-made skin tones, so nobody has to fight a colour picker. */
const SKIN_TONES = [0xf3d9a4, 0xe8b88a, 0xc68a5b, 0x9c6239, 0x6f4326, 0x4a2c1a, 0xd9f0ff, 0xbfe3b0];

const TABS: Array<{ id: string; label: string; type?: AssetType; slot?: keyof HumanoidDescriptionData }> = [
  { id: "body", label: "Body" },
  { id: "shirt", label: "Shirts", type: "Shirt", slot: "shirt" },
  { id: "pants", label: "Pants", type: "Pants", slot: "pants" },
  { id: "tshirt", label: "T-shirts", type: "TShirt", slot: "graphicTShirt" },
  { id: "hat", label: "Hats", type: "Hat", slot: "hatAccessory" },
  { id: "hair", label: "Hair", type: "Hair", slot: "hairAccessory" },
  { id: "face", label: "Faces", type: "Face", slot: "face" },
];

/**
 * The avatar editor.
 *
 * Edits a HumanoidDescription with a live preview, then saves it to the
 * player's account. Everything it changes is the same data a place applies
 * when they join, so the preview is not an approximation of the result.
 */
class AvatarEditor {
  private description: HumanoidDescriptionData = { ...DEFAULT_DESCRIPTION };
  private saved: HumanoidDescriptionData = { ...DEFAULT_DESCRIPTION };
  private assets: AssetInfo[] = [];
  private account: Account | null = null;
  private preview: AvatarPreview | null = null;
  private tab = "body";

  constructor(private readonly root: HTMLElement) {}

  async boot(): Promise<void> {
    this.renderShell();
    await Promise.all([this.loadAccount(), this.loadAssets()]);
    this.preview = new AvatarPreview(this.root.querySelector(".preview")!, this.description);
    this.renderTabs();
    this.renderPanel();
    this.renderHeader();
  }

  private async loadAccount(): Promise<void> {
    try {
      const me = await (await fetch("/api/me")).json();
      this.account = me.account ?? null;
      if (!this.account) return;
      const mine = await (await fetch(`/api/avatars/${encodeURIComponent(this.account.username)}`)).json();
      if (mine.avatar) {
        this.description = { ...DEFAULT_DESCRIPTION, ...mine.avatar };
        this.saved = { ...this.description };
      }
    } catch {
      // Signed out, or the portal is unreachable: edit the default look.
    }
  }

  private async loadAssets(): Promise<void> {
    try {
      const body = await (await fetch("/api/assets")).json();
      this.assets = body.assets ?? [];
    } catch {
      this.assets = [];
    }
  }

  // -- shell ---------------------------------------------------------------

  private renderShell(): void {
    this.root.innerHTML = `
      <header class="bar">
        <a class="home" href="/">◀ MiBlox</a>
        <h1>Avatar</h1>
        <div class="who"></div>
      </header>
      <main class="editor">
        <section class="stage">
          <div class="preview"></div>
          <div class="stage-actions">
            <button class="ghost randomise">Randomise</button>
            <button class="ghost reset">Reset</button>
          </div>
        </section>
        <section class="picker">
          <nav class="tabs"></nav>
          <div class="panel"></div>
          <footer class="save-row">
            <span class="save-note"></span>
            <button class="primary save">Save</button>
          </footer>
        </section>
      </main>`;

    this.root.querySelector<HTMLButtonElement>(".save")!.addEventListener("click", () => void this.save());
    this.root.querySelector<HTMLButtonElement>(".reset")!.addEventListener("click", () => {
      this.description = { ...this.saved };
      this.apply();
      this.renderPanel();
    });
    this.root.querySelector<HTMLButtonElement>(".randomise")!.addEventListener("click", () => {
      this.randomise();
    });
  }

  private renderHeader(): void {
    const who = this.root.querySelector<HTMLElement>(".who")!;
    who.innerHTML = this.account
      ? `Signed in as <strong>${escapeHtml(this.account.username)}</strong>`
      : `<a class="primary-link" href="/auth/login">Sign in with Migood to save</a>`;
    this.root.querySelector<HTMLButtonElement>(".save")!.disabled = !this.account;
    this.root.querySelector<HTMLElement>(".save-note")!.textContent = this.account
      ? "Saved to your account and used in every world."
      : "Try any look you like. Signing in lets you keep it.";
  }

  private renderTabs(): void {
    const nav = this.root.querySelector<HTMLElement>(".tabs")!;
    nav.innerHTML = "";
    for (const tab of TABS) {
      const button = document.createElement("button");
      button.className = `tab${tab.id === this.tab ? " selected" : ""}`;
      button.textContent = tab.label;
      button.addEventListener("click", () => {
        this.tab = tab.id;
        this.renderTabs();
        this.renderPanel();
      });
      nav.appendChild(button);
    }
  }

  private renderPanel(): void {
    const panel = this.root.querySelector<HTMLElement>(".panel")!;
    panel.innerHTML = "";
    const tab = TABS.find((entry) => entry.id === this.tab)!;
    if (tab.id === "body") {
      panel.appendChild(this.bodyPanel());
      return;
    }
    panel.appendChild(this.assetPanel(tab.type!, tab.slot!));
  }

  private bodyPanel(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "body-panel";

    for (const slot of COLOUR_SLOTS) {
      const row = document.createElement("div");
      row.className = "colour-row";
      const label = document.createElement("span");
      label.textContent = slot.label;
      row.appendChild(label);

      const swatches = document.createElement("div");
      swatches.className = "swatches";
      for (const tone of SKIN_TONES) {
        const swatch = document.createElement("button");
        swatch.className = "swatch";
        swatch.style.background = `#${tone.toString(16).padStart(6, "0")}`;
        swatch.title = `#${tone.toString(16).padStart(6, "0")}`;
        if (this.description[slot.field] === tone) swatch.classList.add("selected");
        swatch.addEventListener("click", () => {
          (this.description as Record<string, unknown>)[slot.field] = tone;
          this.apply();
          this.renderPanel();
        });
        swatches.appendChild(swatch);
      }

      const picker = document.createElement("input");
      picker.type = "color";
      picker.value = `#${Number(this.description[slot.field] ?? 0).toString(16).padStart(6, "0")}`;
      picker.addEventListener("input", () => {
        (this.description as Record<string, unknown>)[slot.field] = parseInt(picker.value.slice(1), 16);
        this.apply();
      });
      swatches.appendChild(picker);
      row.appendChild(swatches);
      wrap.appendChild(row);
    }

    for (const [field, label, min, max] of [
      ["heightScale", "Height", 0.7, 1.6],
      ["widthScale", "Width", 0.7, 1.5],
      ["headScale", "Head size", 0.7, 1.5],
    ] as const) {
      const row = document.createElement("div");
      row.className = "slider-row";
      const name = document.createElement("span");
      name.textContent = label;
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(min);
      input.max = String(max);
      input.step = "0.05";
      input.value = String(this.description[field] ?? 1);
      const output = document.createElement("output");
      output.textContent = `${Number(input.value).toFixed(2)}x`;
      input.addEventListener("input", () => {
        (this.description as Record<string, unknown>)[field] = Number(input.value);
        output.textContent = `${Number(input.value).toFixed(2)}x`;
        this.apply();
      });
      row.append(name, input, output);
      wrap.appendChild(row);
    }
    return wrap;
  }

  /** A grid of catalogue items for one slot, with "none" first. */
  private assetPanel(type: AssetType, slot: keyof HumanoidDescriptionData): HTMLElement {
    const grid = document.createElement("div");
    grid.className = "asset-grid";
    // Accessory slots hold id lists; clothing slots hold a single number.
    const isList = typeof this.description[slot] === "string" || slot.toString().endsWith("Accessory");
    const current = isList
      ? String(this.description[slot] ?? "")
          .split(",")
          .map((id) => Number(id.trim()))
          .filter(Boolean)
      : [Number(this.description[slot] ?? 0)];

    const none = document.createElement("button");
    none.className = `asset none${current.length === 0 || current[0] === 0 ? " selected" : ""}`;
    none.innerHTML = `<span class="asset-art">—</span><span class="asset-name">None</span>`;
    none.addEventListener("click", () => {
      (this.description as Record<string, unknown>)[slot] = isList ? "" : 0;
      this.apply();
      this.renderPanel();
    });
    grid.appendChild(none);

    for (const asset of this.assets.filter((entry) => entry.type === type)) {
      const button = document.createElement("button");
      const selected = current.includes(asset.id);
      button.className = `asset${selected ? " selected" : ""}`;
      const art = asset.texture
        ? `<span class="asset-art" style="background-image:url('${asset.texture}')"></span>`
        : `<span class="asset-art" style="background:${hexColor(asset.color ?? 0x8899aa)}"></span>`;
      button.innerHTML = `${art}<span class="asset-name">${escapeHtml(asset.name)}</span><span class="asset-id">${asset.id}</span>`;
      button.addEventListener("click", () => {
        if (isList) {
          // Clicking a worn accessory takes it off; clicking another swaps it.
          (this.description as Record<string, unknown>)[slot] = selected ? "" : String(asset.id);
        } else {
          (this.description as Record<string, unknown>)[slot] = selected ? 0 : asset.id;
        }
        this.apply();
        this.renderPanel();
      });
      grid.appendChild(button);
    }
    return grid;
  }

  private apply(): void {
    this.preview?.update(this.description);
  }

  private randomise(): void {
    const pick = (type: AssetType): number => {
      const options = this.assets.filter((asset) => asset.type === type);
      if (!options.length) return 0;
      return options[Math.floor(Math.random() * options.length)].id;
    };
    const tone = () => SKIN_TONES[Math.floor(Math.random() * SKIN_TONES.length)];
    const skin = tone();

    this.description = {
      ...this.description,
      headColor: skin,
      leftArmColor: skin,
      rightArmColor: skin,
      torsoColor: tone(),
      leftLegColor: tone(),
      rightLegColor: tone(),
      shirt: pick("Shirt"),
      pants: pick("Pants"),
      graphicTShirt: 0,
      face: pick("Face"),
      hatAccessory: Math.random() < 0.6 ? String(pick("Hat")) : "",
      hairAccessory: String(pick("Hair")),
    };
    this.apply();
    this.renderPanel();
  }

  private async save(): Promise<void> {
    const note = this.root.querySelector<HTMLElement>(".save-note")!;
    const problems = validateDescription(this.description);
    if (problems.length) {
      note.textContent = problems.join("; ");
      note.classList.add("error");
      return;
    }

    note.classList.remove("error");
    note.textContent = "Saving…";
    try {
      const res = await fetch("/api/me/avatar", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatar: this.description }),
      });
      const body = await res.json();
      if (!res.ok) {
        note.textContent = body.error ?? "Could not save";
        note.classList.add("error");
        return;
      }
      this.saved = { ...this.description };
      note.textContent = "Saved. You will look like this in every world.";
    } catch {
      note.textContent = "Could not reach the portal";
      note.classList.add("error");
    }
  }
}

function hexColor(value: number): string {
  return `#${value.toString(16).padStart(6, "0")}`;
}

function escapeHtml(text: string): string {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

const root = document.getElementById("avatar") ?? document.body;
const editor = new AvatarEditor(root);
void editor.boot();

(window as unknown as { avatarEditor: AvatarEditor }).avatarEditor = editor;
