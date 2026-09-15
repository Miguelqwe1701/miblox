import { Signal, type Connection } from "./signal.js";
import { CFrame, Color3, Vector3 } from "./math.js";

export type PropKind =
  | "number"
  | "string"
  | "boolean"
  | "Vector3"
  | "CFrame"
  | "Color3"
  | "enum"
  | "ref";

export interface PropDef {
  kind: PropKind;
  /** Default value, or a factory when the default is a mutable object. */
  default: unknown;
  /** Replicated properties are included in snapshots and delta updates. */
  replicated?: boolean;
  /** Clients may not write these; the server is authoritative. */
  readOnly?: boolean;
}

export type PropSchema = Record<string, PropDef>;

const classRegistry = new Map<
  string,
  { ctor: new () => Instance; schema: PropSchema; abstract?: boolean }
>();

export function registerClass(
  className: string,
  ctor: new () => Instance,
  schema: PropSchema,
  opts: { abstract?: boolean } = {},
): void {
  classRegistry.set(className, { ctor, schema, abstract: opts.abstract });
}

export function getClassSchema(className: string): PropSchema | undefined {
  return classRegistry.get(className)?.schema;
}

export function isRegisteredClass(className: string): boolean {
  return classRegistry.has(className);
}

let nextId = 1;
/** Deterministic per-process ids keep tests and replication logs readable. */
export function newInstanceId(): string {
  return `i${(nextId++).toString(36)}`;
}

export function resetInstanceIds(): void {
  nextId = 1;
}

export abstract class Instance {
  abstract readonly className: string;

  readonly id: string = newInstanceId();
  Name = "Instance";
  Archivable = true;

  private _parent: Instance | null = null;
  private _children: Instance[] = [];
  private _destroyed = false;
  private _propertySignals: Map<string, Signal<[]>> | null = null;
  /** Property names changed since the last replication flush. */
  readonly dirtyProps = new Set<string>();

  readonly ChildAdded = new Signal<[Instance]>();
  readonly ChildRemoved = new Signal<[Instance]>();
  readonly AncestryChanged = new Signal<[Instance, Instance | null]>();
  readonly Destroying = new Signal<[]>();
  readonly Changed = new Signal<[string]>();

  /** Set when the instance is inside a DataModel; drives change collection. */
  dataModel: DataModelLike | null = null;

  get Parent(): Instance | null {
    return this._parent;
  }

  set Parent(value: Instance | null) {
    this.setParent(value);
  }

  setParent(value: Instance | null): void {
    if (this._destroyed && value !== null) {
      throw new Error(`Cannot set Parent of destroyed instance ${this.Name}`);
    }
    if (value === this) throw new Error("Attempt to set an Instance as its own Parent");
    if (value && value.isDescendantOf(this)) {
      throw new Error("Attempt to set Parent would create a circular reference");
    }
    const old = this._parent;
    if (old === value) return;

    if (old) {
      const i = old._children.indexOf(this);
      if (i >= 0) old._children.splice(i, 1);
      old.ChildRemoved.Fire(this);
    }
    this._parent = value;
    if (value) {
      value._children.push(this);
      value.ChildAdded.Fire(this);
    }

    const dm = value ? value.dataModel : null;
    this.propagateDataModel(dm);
    this.fireAncestryChanged(this, value);
    this.dataModel?.onInstanceParented(this, old);
    if (!value && old) old.dataModel?.onInstanceRemoved(this, old);
  }

  private propagateDataModel(dm: DataModelLike | null): void {
    this.dataModel = dm;
    for (const child of this._children) child.propagateDataModel(dm);
  }

  private fireAncestryChanged(child: Instance, parent: Instance | null): void {
    this.AncestryChanged.Fire(child, parent);
    for (const c of this._children) c.fireAncestryChanged(child, parent);
  }

  GetChildren(): Instance[] {
    return this._children.slice();
  }

  /** Live view of the child list; callers must not mutate it. */
  get childrenRef(): readonly Instance[] {
    return this._children;
  }

  GetDescendants(out: Instance[] = []): Instance[] {
    for (const child of this._children) {
      out.push(child);
      child.GetDescendants(out);
    }
    return out;
  }

  FindFirstChild(name: string, recursive = false): Instance | null {
    for (const child of this._children) if (child.Name === name) return child;
    if (recursive) {
      for (const child of this._children) {
        const found = child.FindFirstChild(name, true);
        if (found) return found;
      }
    }
    return null;
  }

  FindFirstChildOfClass(className: string): Instance | null {
    for (const child of this._children) if (child.className === className) return child;
    return null;
  }

  FindFirstAncestor(name: string): Instance | null {
    let p = this._parent;
    while (p) {
      if (p.Name === name) return p;
      p = p._parent;
    }
    return null;
  }

  FindFirstAncestorOfClass(className: string): Instance | null {
    let p = this._parent;
    while (p) {
      if (p.className === className) return p;
      p = p._parent;
    }
    return null;
  }

  /** Blocks (via promise) until a child with `name` exists. */
  WaitForChild(name: string, timeoutSeconds?: number): Promise<Instance | null> {
    const existing = this.FindFirstChild(name);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const conn = this.ChildAdded.Connect((child) => {
        if (child.Name !== name) return;
        conn.Disconnect();
        if (timer) clearTimeout(timer);
        resolve(child);
      });
      if (timeoutSeconds !== undefined) {
        timer = setTimeout(() => {
          conn.Disconnect();
          resolve(null);
        }, timeoutSeconds * 1000);
      }
    });
  }

  IsA(className: string): boolean {
    if (this.className === className) return true;
    return this.ancestryClassNames().includes(className);
  }

  /** Class names this instance inherits from, nearest first. */
  protected ancestryClassNames(): string[] {
    return ["Instance"];
  }

  isDescendantOf(other: Instance): boolean {
    let p = this._parent;
    while (p) {
      if (p === other) return true;
      p = p._parent;
    }
    return false;
  }

  IsDescendantOf(other: Instance): boolean {
    return this.isDescendantOf(other);
  }

  GetFullName(): string {
    const parts: string[] = [this.Name];
    let p = this._parent;
    while (p && p.className !== "DataModel") {
      parts.unshift(p.Name);
      p = p._parent;
    }
    return parts.join(".");
  }

  GetPropertyChangedSignal(prop: string): Signal<[]> {
    this._propertySignals ??= new Map();
    let sig = this._propertySignals.get(prop);
    if (!sig) {
      sig = new Signal<[]>();
      this._propertySignals.set(prop, sig);
    }
    return sig;
  }

  get schema(): PropSchema {
    return classRegistry.get(this.className)?.schema ?? {};
  }

  getProperty(name: string): unknown {
    if (name === "Parent") return this._parent;
    if (name === "Name") return this.Name;
    if (name === "ClassName") return this.className;
    return (this as unknown as Record<string, unknown>)[name];
  }

  /**
   * Central write path: assigns, marks the property dirty for replication and
   * fires the change signals. Direct field writes bypass replication, so engine
   * code that mutates replicated state should go through here.
   */
  setProperty(name: string, value: unknown): void {
    if (name === "Parent") {
      this.setParent(value as Instance | null);
      return;
    }
    const self = this as unknown as Record<string, unknown>;
    if (self[name] === value) return;
    self[name] = value;
    this.markDirty(name);
  }

  markDirty(name: string): void {
    const def = this.schema[name];
    if (def?.replicated !== false) {
      this.dirtyProps.add(name);
      this.dataModel?.onPropertyChanged(this, name);
    }
    this._propertySignals?.get(name)?.Fire();
    this.Changed.Fire(name);
  }

  Destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this.Destroying.Fire();
    for (const child of this._children.slice()) child.Destroy();
    const dm = this.dataModel;
    this.setParent(null);
    dm?.onInstanceRemoved(this, null);
    this.ChildAdded.DisconnectAll();
    this.ChildRemoved.DisconnectAll();
    this.AncestryChanged.DisconnectAll();
    this.Changed.DisconnectAll();
    if (this._propertySignals) {
      for (const sig of this._propertySignals.values()) sig.DisconnectAll();
      this._propertySignals.clear();
    }
  }

  get destroyed(): boolean {
    return this._destroyed;
  }

  Clone(): Instance | null {
    if (!this.Archivable) return null;
    const copy = createInstance(this.className);
    copy.Name = this.Name;
    const schema = this.schema;
    for (const key of Object.keys(schema)) {
      const def = schema[key];
      if (def.kind === "ref") continue; // Refs are rebound by the caller.
      (copy as unknown as Record<string, unknown>)[key] = (
        this as unknown as Record<string, unknown>
      )[key];
    }
    for (const child of this._children) {
      const childCopy = child.Clone();
      if (childCopy) childCopy.setParent(copy);
    }
    return copy;
  }

  toString(): string {
    return this.Name;
  }
}

/** The subset of DataModel the Instance tree needs; avoids a circular import. */
export interface DataModelLike {
  onInstanceParented(instance: Instance, oldParent: Instance | null): void;
  onInstanceRemoved(instance: Instance, oldParent: Instance | null): void;
  onPropertyChanged(instance: Instance, prop: string): void;
}

export function createInstance(className: string, parent?: Instance | null): Instance {
  const entry = classRegistry.get(className);
  if (!entry) throw new Error(`Unknown class name "${className}"`);
  if (entry.abstract) throw new Error(`"${className}" is not creatable`);
  const inst = new entry.ctor();
  // Seed declared defaults so freshly built instances match the schema.
  for (const [key, def] of Object.entries(entry.schema)) {
    const record = inst as unknown as Record<string, unknown>;
    if (record[key] === undefined) record[key] = cloneDefault(def.default);
  }
  if (parent !== undefined) inst.setParent(parent);
  return inst;
}

function cloneDefault(value: unknown): unknown {
  if (typeof value === "function") return (value as () => unknown)();
  return value;
}

/** Serializes a property value to JSON-safe form for save files and the wire. */
export function encodeValue(kind: PropKind, value: unknown): unknown {
  switch (kind) {
    case "Vector3":
      return (value as Vector3).toArray();
    case "CFrame":
      return (value as CFrame).toComponents();
    case "Color3":
      return (value as Color3).toHex();
    case "ref":
      return value ? (value as Instance).id : null;
    default:
      return value;
  }
}

export function decodeValue(kind: PropKind, raw: unknown): unknown {
  switch (kind) {
    case "Vector3":
      return Vector3.fromArray(raw as number[]);
    case "CFrame":
      return CFrame.fromComponents(raw as number[]);
    case "Color3":
      return Color3.fromHex(raw as number);
    default:
      return raw;
  }
}

export type { Connection };
