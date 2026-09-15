import {
  Instance,
  createInstance,
  decodeValue,
  encodeValue,
  getClassSchema,
} from "./instance.js";
import type { DataModel } from "./datamodel.js";

export const PROTOCOL_VERSION = 1;

/** Flat instance record; children are implied by parentId. */
export interface WireInstance {
  id: string;
  cn: string;
  n: string;
  p: string | null;
  props: Record<string, unknown>;
}

export interface WireDelta {
  add?: WireInstance[];
  rm?: string[];
  set?: Array<{ id: string; props: Record<string, unknown> }>;
  mv?: Array<{ id: string; p: string | null }>;
}

export interface WireChunk {
  key: string;
  rle: string;
}

export type ServerMessage =
  | {
      t: "hello";
      protocol: number;
      playerId: string;
      rootId: string;
      tickRate: number;
      placeName: string;
      terrain: { seed: number; seaLevel: number; amplitude: number; scale: number; caves: boolean };
    }
  | { t: "delta"; tick: number; delta: WireDelta }
  | { t: "chunks"; chunks: WireChunk[] }
  | { t: "remote"; id: string; args: unknown[] }
  | { t: "invoke"; id: string; call: number; args: unknown[] }
  | { t: "result"; call: number; value: unknown }
  | { t: "chat"; from: string; text: string }
  | { t: "kick"; reason: string }
  | { t: "pong"; time: number };

export type ClientMessage =
  | { t: "join"; name: string; platform: string; protocol: number }
  | {
      t: "input";
      seq: number;
      move: [number, number, number];
      jump: boolean;
      /** Client-predicted root position, used for reconciliation checks. */
      pos?: [number, number, number];
      look?: [number, number, number];
    }
  | { t: "remote"; id: string; args: unknown[] }
  | { t: "invoke"; id: string; call: number; args: unknown[] }
  | { t: "result"; call: number; value: unknown }
  | { t: "chat"; text: string }
  | { t: "edit"; op: "set" | "ball" | "block"; a: number[]; b?: number[]; m: number }
  | { t: "wantChunks"; keys: string[] }
  | { t: "ping"; time: number };

/** Serializes an instance's replicated properties for the wire. */
export function wireProps(inst: Instance, only?: Iterable<string>): Record<string, unknown> {
  const schema = getClassSchema(inst.className) ?? {};
  const out: Record<string, unknown> = {};
  const keys = only ? [...only] : Object.keys(schema);
  for (const key of keys) {
    const def = schema[key];
    if (!def || def.replicated === false) continue;
    const value = (inst as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    out[key] = encodeValue(def.kind, value);
  }
  return out;
}

export function toWireInstance(inst: Instance): WireInstance {
  return {
    id: inst.id,
    cn: inst.className,
    n: inst.Name,
    p: inst.Parent ? inst.Parent.id : null,
    props: wireProps(inst),
  };
}

/** Builds a delta packet from a DataModel's drained change journal. */
export function buildDelta(
  game: DataModel,
  changes: ReturnType<DataModel["flushChanges"]>,
): WireDelta {
  const delta: WireDelta = {};

  const added: WireInstance[] = [];
  for (const id of changes.added) {
    const inst = game.byId.get(id);
    if (!inst) continue;
    added.push(toWireInstance(inst));
  }
  // Parents must exist before children when the client applies the packet.
  added.sort((a, b) => depthOf(game, a.id) - depthOf(game, b.id));
  if (added.length) delta.add = added;

  if (changes.removed.length) delta.rm = changes.removed;

  const set: Array<{ id: string; props: Record<string, unknown> }> = [];
  for (const [id, props] of changes.props) {
    const inst = game.byId.get(id);
    if (!inst) continue;
    const encoded = wireProps(inst, props);
    if (Object.keys(encoded).length) set.push({ id, props: encoded });
  }
  if (set.length) delta.set = set;

  const mv: Array<{ id: string; p: string | null }> = [];
  for (const id of changes.reparented) {
    const inst = game.byId.get(id);
    if (!inst) continue;
    mv.push({ id, p: inst.Parent ? inst.Parent.id : null });
  }
  if (mv.length) delta.mv = mv;

  return delta;
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

export function isEmptyDelta(delta: WireDelta): boolean {
  return !delta.add && !delta.rm && !delta.set && !delta.mv;
}

/**
 * Client-side mirror of the server tree. Ids are server-assigned, so the client
 * keeps its own id->instance map rather than relying on local id generation.
 */
export class ReplicaTree {
  readonly byId = new Map<string, Instance>();
  /** Instances whose parent has not arrived yet, keyed by the missing id. */
  private orphans = new Map<string, WireInstance[]>();
  /** Ref properties whose target had not arrived when they were applied. */
  private pendingRefs: Array<{ inst: Instance; prop: string; targetId: string }> = [];

  constructor(readonly root: Instance) {
    this.byId.set(root.id, root);
  }

  /** Maps a server id onto the client root, so both sides agree on the root. */
  bindRoot(serverRootId: string): void {
    this.byId.set(serverRootId, this.root);
  }

  apply(delta: WireDelta): void {
    for (const rec of delta.add ?? []) this.addInstance(rec);
    // A ref can point at an instance later in the same packet, so refs are
    // resolved only once every add in this delta has been applied.
    this.resolvePendingRefs();
    for (const rec of delta.mv ?? []) {
      const inst = this.byId.get(rec.id);
      const parent = rec.p ? this.byId.get(rec.p) : null;
      if (inst) inst.setParent(parent ?? null);
    }
    for (const rec of delta.set ?? []) {
      const inst = this.byId.get(rec.id);
      if (inst) this.applyProps(inst, rec.props);
    }
    for (const id of delta.rm ?? []) {
      const inst = this.byId.get(id);
      if (!inst) continue;
      this.forgetSubtree(inst);
      inst.Destroy();
    }
    this.resolvePendingRefs();
  }

  private resolvePendingRefs(): void {
    if (!this.pendingRefs.length) return;
    const stillPending: typeof this.pendingRefs = [];
    for (const ref of this.pendingRefs) {
      if (ref.inst.destroyed) continue;
      const target = this.byId.get(ref.targetId);
      if (!target) {
        stillPending.push(ref);
        continue;
      }
      (ref.inst as unknown as Record<string, unknown>)[ref.prop] = target;
      ref.inst.markDirty(ref.prop);
    }
    this.pendingRefs = stillPending;
  }

  private forgetSubtree(inst: Instance): void {
    for (const [id, other] of this.byId) if (other === inst) this.byId.delete(id);
    for (const child of inst.childrenRef) this.forgetSubtree(child);
  }

  private addInstance(rec: WireInstance): void {
    if (this.byId.has(rec.id)) {
      // Re-sent add (e.g. a resync); treat it as a property update.
      const existing = this.byId.get(rec.id)!;
      this.applyProps(existing, rec.props);
      return;
    }
    const parent = rec.p ? this.byId.get(rec.p) : null;
    if (rec.p && !parent) {
      // Hold until the parent shows up; packets can interleave.
      const queue = this.orphans.get(rec.p) ?? [];
      queue.push(rec);
      this.orphans.set(rec.p, queue);
      return;
    }
    // Services already exist on the client's DataModel; adopt rather than add.
    let inst: Instance | null = null;
    if (parent && parent === this.root) inst = parent.FindFirstChild(rec.n);
    if (!inst || inst.className !== rec.cn) {
      inst = createInstance(rec.cn);
      inst.Name = rec.n;
      inst.setParent(parent ?? null);
    }
    inst.Name = rec.n;
    this.byId.set(rec.id, inst);
    this.applyProps(inst, rec.props);

    const pending = this.orphans.get(rec.id);
    if (pending) {
      this.orphans.delete(rec.id);
      for (const child of pending) this.addInstance(child);
    }
  }

  private applyProps(inst: Instance, props: Record<string, unknown>): void {
    const schema = getClassSchema(inst.className) ?? {};
    for (const [key, raw] of Object.entries(props)) {
      const def = schema[key];
      if (!def) continue;
      if (def.kind === "ref") {
        if (typeof raw !== "string") {
          (inst as unknown as Record<string, unknown>)[key] = null;
          inst.markDirty(key);
          continue;
        }
        const target = this.byId.get(raw);
        if (target) {
          (inst as unknown as Record<string, unknown>)[key] = target;
          inst.markDirty(key);
        } else {
          this.pendingRefs.push({ inst, prop: key, targetId: raw });
        }
        continue;
      }
      (inst as unknown as Record<string, unknown>)[key] = decodeValue(def.kind, raw);
      inst.markDirty(key);
    }
  }

  resolve(id: string): Instance | null {
    return this.byId.get(id) ?? null;
  }

  idOf(inst: Instance): string | null {
    for (const [id, other] of this.byId) if (other === inst) return id;
    return null;
  }
}
