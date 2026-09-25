import {
  Color3,
  GuiObject,
  ImageLabel,
  Instance,
  ScreenGui,
  TextButton,
  TextLabel,
  UDim2,
  type Player,
} from "@miblox/core";

/**
 * Draws the local player's PlayerGui as DOM over the 3D scene.
 *
 * Each frame it walks the GUI tree and brings one element per instance up to
 * date, so it needs no event wiring to follow replication or a LocalScript
 * editing a label. Positions stay as CSS `calc(scale% + offset px)`, which is
 * exactly what a UDim2 means, so the browser does the layout and a resize
 * needs no work here.
 */
export class GuiView {
  readonly root: HTMLDivElement;
  private readonly elements = new Map<Instance, HTMLElement>();
  private readonly styles = new WeakMap<HTMLElement, string>();
  private _wantsMouse = false;

  constructor(parent: HTMLElement, before?: Element | null) {
    this.root = document.createElement("div");
    this.root.className = "game-gui";
    parent.insertBefore(this.root, before ?? null);
  }

  /** True while a visible Modal button needs the mouse free to be clicked. */
  get wantsMouse(): boolean {
    return this._wantsMouse;
  }

  update(player: Player | null): void {
    const seen = new Set<Instance>();
    this._wantsMouse = false;
    const playerGui = player?.FindFirstChild("PlayerGui") ?? null;
    if (playerGui) {
      for (const child of playerGui.childrenRef) {
        if (child instanceof ScreenGui) this.syncScreenGui(child, seen);
      }
    }
    for (const [inst, el] of this.elements) {
      if (seen.has(inst)) continue;
      el.remove();
      this.elements.delete(inst);
    }
  }

  dispose(): void {
    this.root.remove();
    this.elements.clear();
  }

  private syncScreenGui(gui: ScreenGui, seen: Set<Instance>): void {
    seen.add(gui);
    const el = this.elementFor(gui, this.root);
    this.applyStyle(el, `display:${gui.Enabled ? "block" : "none"};z-index:${gui.DisplayOrder}`);
    if (!gui.Enabled) return;
    this.syncChildren(gui, el, seen);
  }

  private syncChildren(parent: Instance, el: HTMLElement, seen: Set<Instance>): void {
    for (const child of parent.childrenRef) {
      if (child instanceof GuiObject) this.syncObject(child, el, seen);
    }
  }

  private syncObject(obj: GuiObject, parentEl: HTMLElement, seen: Set<Instance>): void {
    seen.add(obj);
    const el = this.elementFor(obj, parentEl);
    if (!obj.Visible) {
      this.applyStyle(el, "display:none");
      return;
    }
    if (obj instanceof TextButton && obj.Modal) this._wantsMouse = true;

    const styles = [
      `left:${calc(obj.Position, "x")}`,
      `top:${calc(obj.Position, "y")}`,
      `width:${calc(obj.Size, "x")}`,
      `height:${calc(obj.Size, "y")}`,
      `z-index:${Math.round(obj.ZIndex)}`,
      `transform:translate(${-obj.AnchorPoint.x * 100}%,${-obj.AnchorPoint.y * 100}%) rotate(${obj.Rotation}deg)`,
      `background-color:${rgba(obj.BackgroundColor3, obj.BackgroundTransparency)}`,
      obj.BorderSizePixel > 0 && obj.BackgroundTransparency < 1
        ? `box-shadow:inset 0 0 0 ${obj.BorderSizePixel}px ${rgba(obj.BorderColor3, obj.BackgroundTransparency)}`
        : "box-shadow:none",
    ];

    if (obj instanceof TextLabel) {
      styles.push(
        `color:${rgba(obj.TextColor3, obj.TextTransparency)}`,
        `justify-content:${FLEX[obj.TextXAlignment] ?? "center"}`,
        `align-items:${FLEX[obj.TextYAlignment] ?? "center"}`,
        `text-align:${obj.TextXAlignment.toLowerCase()}`,
        `white-space:${obj.TextWrapped || obj.TextScaled ? "normal" : "pre"}`,
      );
      if (!obj.TextScaled) styles.push(`font-size:${obj.TextSize}px`);
      if (el.textContent !== obj.Text) el.textContent = obj.Text;
      if (obj instanceof TextButton) el.classList.toggle("auto-color", obj.AutoButtonColor);
    }
    if (obj instanceof ImageLabel) {
      const img = el.firstElementChild as HTMLImageElement;
      if (img.getAttribute("src") !== obj.Image) {
        if (obj.Image) img.src = obj.Image;
        else img.removeAttribute("src");
      }
      img.hidden = !obj.Image;
      img.style.opacity = String(Math.max(0, Math.min(1, 1 - obj.ImageTransparency)));
    }
    this.applyStyle(el, styles.join(";"));

    // Scaled text depends on the laid-out box, so it is sized after the rest.
    if (obj instanceof TextLabel && obj.TextScaled) {
      const size = scaledFontSize(obj.Text, el.clientWidth, el.clientHeight);
      el.style.fontSize = `${size}px`;
    }

    this.syncChildren(obj, el, seen);
  }

  private elementFor(inst: Instance, parentEl: HTMLElement): HTMLElement {
    let el = this.elements.get(inst);
    if (!el) {
      el = this.createElement(inst);
      this.elements.set(inst, el);
    }
    if (el.parentElement !== parentEl) parentEl.appendChild(el);
    return el;
  }

  private createElement(inst: Instance): HTMLElement {
    if (inst instanceof TextButton) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "gui-object gui-text gui-button";
      // Clicks happen on this client only, as in Roblox; a script that wants
      // the server to know fires a RemoteEvent.
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        inst.MouseButton1Click.Fire();
        inst.Activated.Fire();
      });
      button.addEventListener("mouseenter", () => inst.MouseEnter.Fire());
      button.addEventListener("mouseleave", () => inst.MouseLeave.Fire());
      return button;
    }
    const div = document.createElement("div");
    if (inst instanceof ScreenGui) {
      div.className = "gui-screen";
    } else if (inst instanceof TextLabel) {
      div.className = "gui-object gui-text";
    } else if (inst instanceof ImageLabel) {
      div.className = "gui-object gui-image";
      const img = document.createElement("img");
      img.alt = "";
      img.draggable = false;
      div.appendChild(img);
    } else {
      div.className = "gui-object";
    }
    return div;
  }

  private applyStyle(el: HTMLElement, css: string): void {
    if (this.styles.get(el) === css) return;
    this.styles.set(el, css);
    el.style.cssText = css;
  }
}

const FLEX: Record<string, string> = {
  Left: "flex-start",
  Top: "flex-start",
  Center: "center",
  Right: "flex-end",
  Bottom: "flex-end",
};

function calc(u: UDim2, axis: "x" | "y"): string {
  const d = axis === "x" ? u.x : u.y;
  return `calc(${d.scale * 100}% + ${d.offset}px)`;
}

function rgba(c: Color3, transparency: number): string {
  const [r, g, b] = [c.r, c.g, c.b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255));
  const a = Math.max(0, Math.min(1, 1 - transparency));
  return `rgba(${r},${g},${b},${a})`;
}

/** Largest font that fits the box, estimated rather than measured. */
function scaledFontSize(text: string, width: number, height: number): number {
  const chars = Math.max(1, text.length);
  // An average glyph is roughly half as wide as the font is tall.
  const byWidth = width / (chars * 0.55);
  const byHeight = height * 0.8;
  return Math.max(1, Math.floor(Math.min(byWidth, byHeight, 100)));
}
