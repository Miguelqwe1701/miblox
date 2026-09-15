import {
  Instance,
  createInstance,
  decodeValue,
  encodeValue,
  getClassSchema,
} from "./instance.js";
import { DataModel } from "./datamodel.js";
import { Chunk, CHUNK_VOLUME, parseChunkKey } from "./terrain-data.js";
import type { Terrain } from "./classes.js";

export const PLACE_FORMAT_VERSION = 1;

export interface SerializedInstance {
  id: string;
  className: string;
  name: string;
  props: Record<string, unknown>;
  children?: SerializedInstance[];
}

export interface SerializedPlace {
  format: "miblox-place";
  version: number;
  name: string;
  /** Terrain generator settings; chunks not listed are generated from these. */
  terrain?: {
    seed: number;
    seaLevel: number;
    amplitude: number;
    scale: number;
    caves: boolean;
    /** Base64 RLE chunks holding authored edits. */
    chunks?: Array<{ key: string; rle: string }>;
  };
  services: SerializedInstance[];
}

/** Properties that describe tree structure rather than state. */
const STRUCTURAL = new Set(["Parent", "Name", "ClassName"]);

export function serializeInstance(inst: Instance): SerializedInstance {
  const schema = getClassSchema(inst.className) ?? {};
  const props: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(schema)) {
    if (STRUCTURAL.has(key)) continue;
    const value = (inst as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    props[key] = encodeValue(def.kind, value);
  }
  // Script source is not in the replicated schema for Script, but a place file
  // must carry it or the game has no code.
  if ("Source" in inst) props.Source = (inst as unknown as { Source: string }).Source;

  const out: SerializedInstance = {
    id: inst.id,
    className: inst.className,
    name: inst.Name,
    props,
  };
  const children = inst
    .GetChildren()
    .filter((c) => c.Archivable && c.className !== "Camera");
  if (children.length) out.children = children.map(serializeInstance);
  return out;
}

export function serializePlace(game: DataModel, name = "Place"): SerializedPlace {
  const terrain = game.Terrain;
  const chunks: Array<{ key: string; rle: string }> = [];
  for (const chunk of terrain.voxels.allChunks()) {
    if (chunk.isEmpty) continue;
    chunks.push({ key: chunk.key, rle: encodeChunkRLE(chunk) });
  }
  return {
    format: "miblox-place",
    version: PLACE_FORMAT_VERSION,
    name,
    terrain: { ...terrain.voxels.gen, chunks },
    services: game
      .GetChildren()
      .filter((c) => c.className !== "Camera")
      .map(serializeInstance),
  };
}

/** Rebuilds instances under `parent`; deferred refs are resolved afterwards. */
function deserializeInto(
  node: SerializedInstance,
  parent: Instance,
  idMap: Map<string, Instance>,
  pendingRefs: Array<{ inst: Instance; prop: string; targetId: string }>,
): Instance {
  const schema = getClassSchema(node.className) ?? {};
  // Services already exist on a fresh DataModel; reuse rather than duplicate.
  let inst = parent.className === "DataModel" ? parent.FindFirstChild(node.name) : null;
  if (!inst || inst.className !== node.className) {
    inst = createInstance(node.className);
    inst.Name = node.name;
    inst.setParent(parent);
  }
  idMap.set(node.id, inst);

  for (const [key, raw] of Object.entries(node.props)) {
    const def = schema[key];
    if (!def) {
      // Source on server Scripts is unschema'd but still needs restoring.
      if (key === "Source") (inst as unknown as Record<string, unknown>).Source = raw;
      continue;
    }
    if (def.kind === "ref") {
      if (typeof raw === "string") pendingRefs.push({ inst, prop: key, targetId: raw });
      continue;
    }
    (inst as unknown as Record<string, unknown>)[key] = decodeValue(def.kind, raw);
  }

  for (const child of node.children ?? []) {
    deserializeInto(child, inst, idMap, pendingRefs);
  }
  return inst;
}

export function deserializePlace(place: SerializedPlace, game?: DataModel): DataModel {
  if (place.format !== "miblox-place") {
    throw new Error(`Not a MiBlox place file (format="${place.format}")`);
  }
  if (place.version > PLACE_FORMAT_VERSION) {
    throw new Error(
      `Place format version ${place.version} is newer than this engine supports (${PLACE_FORMAT_VERSION})`,
    );
  }
  const dm = game ?? new DataModel();
  const idMap = new Map<string, Instance>();
  const pendingRefs: Array<{ inst: Instance; prop: string; targetId: string }> = [];

  for (const svc of place.services) {
    deserializeInto(svc, dm, idMap, pendingRefs);
  }
  for (const { inst, prop, targetId } of pendingRefs) {
    const target = idMap.get(targetId);
    if (target) (inst as unknown as Record<string, unknown>)[prop] = target;
  }

  if (place.terrain) {
    const terrain = dm.Terrain as Terrain;
    const { chunks, ...gen } = place.terrain;
    terrain.voxels.gen = { ...terrain.voxels.gen, ...gen };
    for (const entry of chunks ?? []) {
      const [cx, cy, cz] = parseChunkKey(entry.key);
      terrain.voxels.putChunk(new Chunk(cx, cy, cz, decodeChunkRLE(entry.rle)));
    }
  }
  return dm;
}

// ---------------------------------------------------------------------------
// Chunk run-length encoding
// ---------------------------------------------------------------------------

/**
 * Voxel chunks are overwhelmingly runs of one material, so RLE beats a raw
 * 4096-byte dump by a wide margin. Encoded as pairs of (material, runLength)
 * varints, then base64 for JSON transport.
 */
export function encodeChunkRLE(chunk: Chunk): string {
  const bytes: number[] = [];
  let i = 0;
  while (i < CHUNK_VOLUME) {
    const value = chunk.data[i];
    let run = 1;
    while (i + run < CHUNK_VOLUME && chunk.data[i + run] === value && run < 0x3fff) run++;
    bytes.push(value);
    // Run length as a 1- or 2-byte varint; high bit flags continuation.
    if (run < 128) {
      bytes.push(run);
    } else {
      bytes.push(0x80 | (run & 0x7f), run >> 7);
    }
    i += run;
  }
  return bytesToBase64(Uint8Array.from(bytes));
}

export function decodeChunkRLE(b64: string): Uint8Array {
  const bytes = base64ToBytes(b64);
  const out = new Uint8Array(CHUNK_VOLUME);
  let o = 0;
  let i = 0;
  while (i < bytes.length && o < CHUNK_VOLUME) {
    const value = bytes[i++];
    let run = bytes[i++];
    if (run & 0x80) run = (run & 0x7f) | (bytes[i++] << 7);
    const end = Math.min(o + run, CHUNK_VOLUME);
    if (value !== 0) out.fill(value, o, end);
    o = end;
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
