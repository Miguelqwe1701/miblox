import {
  Instance,
  createInstance,
  type DataModelLike,
  resetInstanceIds,
} from "./instance.js";
import { Signal } from "./signal.js";
import {
  Camera,
  Lighting,
  Players,
  Terrain,
  Workspace,
} from "./classes.js";

/** Services created eagerly on every DataModel, in creation order. */
const CORE_SERVICES = [
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
  "SoundService",
  "Teams",
] as const;

export type ChangeRecord =
  | { op: "add"; id: string; className: string; parentId: string | null; props: Record<string, unknown> }
  | { op: "remove"; id: string }
  | { op: "prop"; id: string; props: Record<string, unknown> }
  | { op: "parent"; id: string; parentId: string | null };

/**
 * Root of the instance tree. Also the change journal: every structural or
 * property edit lands here so the server can turn a tick into a delta packet.
 */
export class DataModel extends Instance implements DataModelLike {
  readonly className = "DataModel";

  /** Registry of every instance in the tree, keyed by id, for ref resolution. */
  readonly byId = new Map<string, Instance>();

  /** Journal of changes since the last `flushChanges()`. */
  private addedIds = new Set<string>();
  private removedIds = new Set<string>();
  private propChanges = new Map<string, Set<string>>();
  private parentChanges = new Set<string>();
  /** Off on clients, which apply changes rather than originate them. */
  recordChanges = true;

  readonly InstanceAdded = new Signal<[Instance]>();
  readonly InstanceRemoved = new Signal<[Instance]>();

  private services = new Map<string, Instance>();

  constructor(opts: { createServices?: boolean } = {}) {
    super();
    this.Name = "game";
    this.dataModel = this;
    this.byId.set(this.id, this);
    if (opts.createServices !== false) this.createCoreServices();
  }

  private createCoreServices(): void {
    for (const name of CORE_SERVICES) {
      const svc = createInstance(name);
      svc.Name = name;
      this.services.set(name, svc);
      svc.setParent(this);
    }
    // StarterPlayer holds the two starter script containers.
    const starterPlayer = this.services.get("StarterPlayer")!;
    for (const name of ["StarterPlayerScripts", "StarterCharacterScripts"]) {
      const c = createInstance(name);
      c.Name = name;
      c.setParent(starterPlayer);
    }
    const workspace = this.services.get("Workspace") as Workspace;
    const terrain = createInstance("Terrain") as Terrain;
    terrain.Name = "Terrain";
    terrain.setParent(workspace);
    workspace.Terrain = terrain;
    const camera = createInstance("Camera") as Camera;
    camera.Name = "Camera";
    camera.setParent(workspace);
    workspace.CurrentCamera = camera;
  }

  GetService(name: string): Instance {
    const existing = this.services.get(name);
    if (existing) return existing;
    const found = this.FindFirstChild(name);
    if (found) {
      this.services.set(name, found);
      return found;
    }
    const svc = createInstance(name);
    svc.Name = name;
    this.services.set(name, svc);
    svc.setParent(this);
    return svc;
  }

  FindService(name: string): Instance | null {
    return this.services.get(name) ?? this.FindFirstChild(name);
  }

  get Workspace(): Workspace {
    return this.GetService("Workspace") as Workspace;
  }
  get Players(): Players {
    return this.GetService("Players") as Players;
  }
  get Lighting(): Lighting {
    return this.GetService("Lighting") as Lighting;
  }
  get Terrain(): Terrain {
    return this.Workspace.Terrain;
  }

  // -- change journal ------------------------------------------------------

  onInstanceParented(instance: Instance, oldParent: Instance | null): void {
    if (!instance.dataModel) return;
    const known = this.byId.has(instance.id);
    if (!known) {
      this.registerSubtree(instance);
      return;
    }
    if (this.recordChanges && !this.addedIds.has(instance.id)) {
      this.parentChanges.add(instance.id);
    }
    void oldParent;
  }

  private registerSubtree(root: Instance): void {
    const stack: Instance[] = [root];
    while (stack.length) {
      const inst = stack.pop()!;
      if (this.byId.has(inst.id)) continue;
      this.byId.set(inst.id, inst);
      if (this.recordChanges) {
        this.addedIds.add(inst.id);
        this.removedIds.delete(inst.id);
      }
      this.InstanceAdded.Fire(inst);
      for (const child of inst.childrenRef) stack.push(child);
    }
  }

  onInstanceRemoved(instance: Instance, _oldParent: Instance | null): void {
    if (instance.Parent !== null || !this.byId.has(instance.id)) return;
    const stack: Instance[] = [instance];
    while (stack.length) {
      const inst = stack.pop()!;
      if (!this.byId.delete(inst.id)) continue;
      if (this.recordChanges) {
        if (this.addedIds.has(inst.id)) {
          // Created and destroyed within one tick; nothing to replicate.
          this.addedIds.delete(inst.id);
        } else {
          this.removedIds.add(inst.id);
        }
        this.propChanges.delete(inst.id);
        this.parentChanges.delete(inst.id);
      }
      this.InstanceRemoved.Fire(inst);
      for (const child of inst.childrenRef) stack.push(child);
    }
  }

  onPropertyChanged(instance: Instance, prop: string): void {
    if (!this.recordChanges) return;
    if (!this.byId.has(instance.id)) return;
    if (this.addedIds.has(instance.id)) return; // The add carries full props.
    let set = this.propChanges.get(instance.id);
    if (!set) {
      set = new Set();
      this.propChanges.set(instance.id, set);
    }
    set.add(prop);
  }

  hasPendingChanges(): boolean {
    return (
      this.addedIds.size > 0 ||
      this.removedIds.size > 0 ||
      this.propChanges.size > 0 ||
      this.parentChanges.size > 0
    );
  }

  /** Drains the journal into a change list and clears it. */
  flushChanges(): {
    added: string[];
    removed: string[];
    props: Array<[string, string[]]>;
    reparented: string[];
  } {
    const result = {
      added: [...this.addedIds],
      removed: [...this.removedIds],
      props: [...this.propChanges].map(
        ([id, set]) => [id, [...set]] as [string, string[]],
      ),
      reparented: [...this.parentChanges],
    };
    this.addedIds.clear();
    this.removedIds.clear();
    this.propChanges.clear();
    this.parentChanges.clear();
    for (const inst of this.byId.values()) inst.dirtyProps.clear();
    return result;
  }

  clearChanges(): void {
    this.addedIds.clear();
    this.removedIds.clear();
    this.propChanges.clear();
    this.parentChanges.clear();
  }

  /** Marks the whole tree as newly added, for a fresh client's first packet. */
  markAllAdded(): void {
    this.addedIds.clear();
    for (const id of this.byId.keys()) if (id !== this.id) this.addedIds.add(id);
  }
}

export function newDataModel(): DataModel {
  return new DataModel();
}

export { resetInstanceIds };
