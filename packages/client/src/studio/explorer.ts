import {
  BasePart,
  Instance as EngineInstance,
  Vector3,
  CFrame,
  Color3,
  UDim2,
  Vector2,
  getClassSchema,
} from "@miblox/core";

/** Instance classes offered in the insert menu, grouped the way Studio does. */
export const INSERTABLE: Array<{ group: string; classes: string[] }> = [
  { group: "Parts", classes: ["Part", "WedgePart", "SpawnLocation"] },
  { group: "Containers", classes: ["Model", "Folder", "Configuration"] },
  { group: "Scripts", classes: ["Script", "LocalScript", "ModuleScript"] },
  { group: "GUI", classes: ["ScreenGui", "Frame", "TextLabel", "TextButton", "ImageLabel"] },
  { group: "Events", classes: ["RemoteEvent", "RemoteFunction", "BindableEvent"] },
  {
    group: "Values",
    classes: ["IntValue", "NumberValue", "StringValue", "BoolValue", "Vector3Value", "ObjectValue"],
  },
];

/** Services whose contents the explorer shows. */
const EXPLORER_ROOTS = [
  "Workspace",
  "Players",
  "Lighting",
  "ReplicatedStorage",
  "ReplicatedFirst",
  "ServerStorage",
  "ServerScriptService",
  "StarterPlayer",
  "StarterGui",
  "StarterPack",
];

export type SelectionListener = (instance: EngineInstance | null) => void;

/**
 * The instance tree, as a collapsible list.
 *
 * Rebuilt wholesale on change rather than diffed: a place has hundreds of
 * instances, not hundreds of thousands, and a full rebuild is both simpler and
 * fast enough to be imperceptible.
 */
export class Explorer {
  readonly element: HTMLDivElement;
  private selected: EngineInstance | null = null;
  private expanded = new Set<EngineInstance>();
  private listeners: SelectionListener[] = [];

  constructor(private readonly game: EngineInstance) {
    this.element = document.createElement("div");
    this.element.className = "explorer";
  }

  onSelect(listener: SelectionListener): void {
    this.listeners.push(listener);
  }

  get selection(): EngineInstance | null {
    return this.selected;
  }

  select(instance: EngineInstance | null): void {
    this.selected = instance;
    // Reveal the selection by expanding everything above it.
    let parent = instance?.Parent ?? null;
    while (parent) {
      this.expanded.add(parent);
      parent = parent.Parent;
    }
    this.refresh();
    for (const listener of this.listeners) listener(instance);
  }

  refresh(): void {
    this.element.innerHTML = "";
    for (const name of EXPLORER_ROOTS) {
      const service = this.game.FindFirstChild(name);
      if (service) this.element.appendChild(this.renderNode(service, 0));
    }
  }

  private renderNode(instance: EngineInstance, depth: number): HTMLElement {
    const wrapper = document.createElement("div");
    const row = document.createElement("div");
    row.className = "node";
    if (instance === this.selected) row.classList.add("selected");
    row.style.paddingLeft = `${depth * 14 + 8}px`;

    const children = instance.GetChildren();
    const isOpen = this.expanded.has(instance);

    const twisty = document.createElement("span");
    twisty.className = "twisty";
    twisty.textContent = children.length ? (isOpen ? "▾" : "▸") : "";
    twisty.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!children.length) return;
      if (isOpen) this.expanded.delete(instance);
      else this.expanded.add(instance);
      this.refresh();
    });

    const icon = document.createElement("span");
    icon.className = "node-icon";
    icon.textContent = iconFor(instance.className);

    const label = document.createElement("span");
    label.className = "node-name";
    label.textContent = instance.Name;

    const type = document.createElement("span");
    type.className = "node-class";
    type.textContent = instance.className;

    row.append(twisty, icon, label, type);
    row.addEventListener("click", () => this.select(instance));
    wrapper.appendChild(row);

    if (isOpen) {
      for (const child of children) wrapper.appendChild(this.renderNode(child, depth + 1));
    }
    return wrapper;
  }
}

function iconFor(className: string): string {
  if (className.endsWith("Part") || className === "SpawnLocation") return "▣";
  if (className === "Model") return "◫";
  if (className === "Folder") return "▤";
  if (className.includes("Script")) return "≡";
  if (className.includes("Remote") || className.includes("Bindable")) return "⇄";
  if (className === "Terrain") return "⛰";
  if (className.endsWith("Value")) return "◆";
  return "○";
}

export type PropertyChange = (instance: EngineInstance, key: string, value: unknown) => void;

/**
 * The properties panel.
 *
 * Fields are generated from the class schema rather than hand-listed, so a
 * property added to a class in the engine shows up here without further work.
 */
export class Properties {
  readonly element: HTMLDivElement;
  private instance: EngineInstance | null = null;
  private onChange: PropertyChange = () => {};

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "properties";
    this.show(null);
  }

  bind(onChange: PropertyChange): void {
    this.onChange = onChange;
  }

  show(instance: EngineInstance | null): void {
    this.instance = instance;
    this.element.innerHTML = "";
    if (!instance) {
      this.element.innerHTML = `<p class="hint">Select something in the Explorer.</p>`;
      return;
    }

    this.element.appendChild(this.textRow("Name", instance.Name, (value) => {
      instance.Name = value;
      this.onChange(instance, "Name", value);
    }));

    const classRow = document.createElement("div");
    classRow.className = "prop";
    classRow.innerHTML = `<label>ClassName</label><span class="readonly">${instance.className}</span>`;
    this.element.appendChild(classRow);

    const schema = getClassSchema(instance.className) ?? {};
    const record = instance as unknown as Record<string, unknown>;

    for (const [key, def] of Object.entries(schema)) {
      const value = record[key];
      if (value === undefined) continue;
      switch (def.kind) {
        case "number":
          this.element.appendChild(
            this.numberRow(key, value as number, (next) => this.set(key, next)),
          );
          break;
        case "boolean":
          this.element.appendChild(
            this.checkRow(key, value as boolean, (next) => this.set(key, next)),
          );
          break;
        case "string":
          this.element.appendChild(
            this.textRow(key, String(value ?? ""), (next) => this.set(key, next)),
          );
          break;
        case "Vector3":
          this.element.appendChild(
            this.vectorRow(key, value as Vector3, (next) => this.set(key, next)),
          );
          break;
        case "CFrame":
          this.element.appendChild(
            this.vectorRow(
              key === "CFrame" ? "Position" : key,
              (value as CFrame).position,
              (next) => {
                const cf = record[key] as CFrame;
                this.set(key, cf.add(next.sub(cf.position)));
              },
            ),
          );
          break;
        case "Color3":
          this.element.appendChild(
            this.colorRow(key, value as Color3, (next) => this.set(key, next)),
          );
          break;
        case "UDim2":
          this.element.appendChild(
            this.numbersRow(
              key,
              (value as UDim2).toArray(),
              ["X scale", "X offset", "Y scale", "Y offset"],
              (n) => this.set(key, UDim2.fromArray(n)),
            ),
          );
          break;
        case "Vector2":
          this.element.appendChild(
            this.numbersRow(key, [(value as Vector2).x, (value as Vector2).y], ["X", "Y"], (n) =>
              this.set(key, new Vector2(n[0], n[1])),
            ),
          );
          break;
        default:
          break;
      }
    }

    if ("Source" in record) {
      const row = document.createElement("div");
      row.className = "prop";
      row.innerHTML = `<label>Source</label><span class="readonly">edit in the script tab</span>`;
      this.element.appendChild(row);
    }
  }

  private set(key: string, value: unknown): void {
    if (!this.instance) return;
    this.instance.setProperty(key, value);
    this.onChange(this.instance, key, value);
  }

  private row(label: string): { row: HTMLDivElement; field: HTMLDivElement } {
    const row = document.createElement("div");
    row.className = "prop";
    const name = document.createElement("label");
    name.textContent = label;
    const field = document.createElement("div");
    field.className = "field";
    row.append(name, field);
    return { row, field };
  }

  private textRow(label: string, value: string, apply: (value: string) => void): HTMLElement {
    const { row, field } = this.row(label);
    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.addEventListener("change", () => apply(input.value));
    field.appendChild(input);
    return row;
  }

  private numberRow(label: string, value: number, apply: (value: number) => void): HTMLElement {
    const { row, field } = this.row(label);
    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.value = String(round(value));
    input.addEventListener("change", () => {
      const next = Number(input.value);
      if (Number.isFinite(next)) apply(next);
    });
    field.appendChild(input);
    return row;
  }

  private checkRow(label: string, value: boolean, apply: (value: boolean) => void): HTMLElement {
    const { row, field } = this.row(label);
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = value;
    input.addEventListener("change", () => apply(input.checked));
    field.appendChild(input);
    return row;
  }

  private vectorRow(label: string, value: Vector3, apply: (value: Vector3) => void): HTMLElement {
    const { row, field } = this.row(label);
    field.classList.add("vector");
    const inputs: HTMLInputElement[] = [];
    for (const axis of ["x", "y", "z"] as const) {
      const input = document.createElement("input");
      input.type = "number";
      input.step = "any";
      input.title = axis.toUpperCase();
      input.value = String(round(value[axis]));
      input.addEventListener("change", () => {
        const next = new Vector3(
          Number(inputs[0].value) || 0,
          Number(inputs[1].value) || 0,
          Number(inputs[2].value) || 0,
        );
        apply(next);
      });
      inputs.push(input);
      field.appendChild(input);
    }
    return row;
  }

  /** A row of number fields edited together, for UDim2 and Vector2. */
  private numbersRow(
    label: string,
    values: number[],
    titles: string[],
    apply: (values: number[]) => void,
  ): HTMLElement {
    const { row, field } = this.row(label);
    field.classList.add("vector");
    const inputs = values.map((value, i) => {
      const input = document.createElement("input");
      input.type = "number";
      input.step = "any";
      input.title = titles[i];
      input.value = String(round(value));
      input.addEventListener("change", () => apply(inputs.map((el) => Number(el.value) || 0)));
      field.appendChild(input);
      return input;
    });
    return row;
  }

  private colorRow(label: string, value: Color3, apply: (value: Color3) => void): HTMLElement {
    const { row, field } = this.row(label);
    const input = document.createElement("input");
    input.type = "color";
    input.value = `#${value.toHex().toString(16).padStart(6, "0")}`;
    input.addEventListener("input", () =>
      apply(Color3.fromHex(parseInt(input.value.slice(1), 16))),
    );
    field.appendChild(input);
    return row;
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export { BasePart };
