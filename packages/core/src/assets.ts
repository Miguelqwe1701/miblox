/**
 * The asset catalogue.
 *
 * Assets are referred to by number, the way Roblox does, so a
 * HumanoidDescription is a handful of integers rather than a pile of URLs.
 * That is what makes it cheap to store one per player and to pass around.
 *
 * Everything here is built in and generated, not fetched: clothing textures
 * are SVG data URIs produced from the id, and hats and hair are built-in
 * meshes. A real deployment would add a database and serve uploads through the
 * same interface; nothing above this file knows the difference.
 */

export type AssetType = "Shirt" | "Pants" | "TShirt" | "Hat" | "Hair" | "Face" | "Mesh";

export interface AssetInfo {
  id: number;
  name: string;
  type: AssetType;
  /** Image URL for clothing, or undefined for meshes. */
  texture?: string;
  /** `builtin:<shape>` or a URL, for worn accessories. */
  meshId?: string;
  color?: number;
  scale?: [number, number, number];
  offset?: [number, number, number];
}

/** Id ranges, so a number tells you what kind of asset it is. */
export const ASSET_RANGES = {
  Shirt: [1000, 1999],
  Pants: [2000, 2999],
  TShirt: [3000, 3999],
  Hat: [4000, 4999],
  Hair: [5000, 5999],
  Face: [6000, 6999],
  Mesh: [7000, 7999],
} as const;

export function assetTypeOf(id: number): AssetType | null {
  for (const [type, [low, high]] of Object.entries(ASSET_RANGES)) {
    if (id >= low && id <= high) return type as AssetType;
  }
  return null;
}

function svg(body: string): string {
  // Encoded rather than base64'd: it stays readable in dev tools and is shorter.
  const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">${body}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(doc)}`;
}

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

/** A plain garment in one colour, with a slightly darker hem. */
function plain(color: number, accent: number): string {
  return svg(
    `<rect width="256" height="256" fill="${hex(color)}"/>` +
      `<rect y="208" width="256" height="48" fill="${hex(accent)}"/>`,
  );
}

function striped(color: number, accent: number): string {
  return svg(
    `<rect width="256" height="256" fill="${hex(color)}"/>` +
      Array.from({ length: 8 }, (_, i) => `<rect y="${i * 32}" width="256" height="16" fill="${hex(accent)}"/>`).join(""),
  );
}

function checked(color: number, accent: number): string {
  let squares = "";
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if ((x + y) % 2 === 0) continue;
      squares += `<rect x="${x * 32}" y="${y * 32}" width="32" height="32" fill="${hex(accent)}"/>`;
    }
  }
  return svg(`<rect width="256" height="256" fill="${hex(color)}"/>${squares}`);
}

function withLogo(color: number, accent: number, letter: string): string {
  return svg(
    `<rect width="256" height="256" fill="${hex(color)}"/>` +
      `<circle cx="128" cy="120" r="64" fill="${hex(accent)}"/>` +
      `<text x="128" y="146" font-family="system-ui,sans-serif" font-size="80" font-weight="700" ` +
      `text-anchor="middle" fill="${hex(color)}">${letter}</text>`,
  );
}

export const BUILTIN_ASSETS: AssetInfo[] = [
  // -- shirts ---------------------------------------------------------------
  { id: 1001, name: "Plain Blue Shirt", type: "Shirt", texture: plain(0x3b6ea5, 0x2c5480) },
  { id: 1002, name: "Plain Red Shirt", type: "Shirt", texture: plain(0xc0453f, 0x93322e) },
  { id: 1003, name: "Striped Tee", type: "Shirt", texture: striped(0xf4f4f4, 0x2b3a55) },
  { id: 1004, name: "Checked Shirt", type: "Shirt", texture: checked(0xd8613c, 0x8c3a22) },
  { id: 1005, name: "Team Jersey", type: "Shirt", texture: withLogo(0x2b8a5a, 0xf2f6f5, "M") },
  { id: 1006, name: "Hoodie", type: "Shirt", texture: plain(0x4a4f63, 0x343849) },
  // -- pants ----------------------------------------------------------------
  { id: 2001, name: "Blue Jeans", type: "Pants", texture: plain(0x39547a, 0x2b4160) },
  { id: 2002, name: "Black Trousers", type: "Pants", texture: plain(0x25262c, 0x17181c) },
  { id: 2003, name: "Khakis", type: "Pants", texture: plain(0xc2ab7c, 0x9b8760) },
  { id: 2004, name: "Track Pants", type: "Pants", texture: striped(0x2b3a55, 0xf4f4f4) },
  { id: 2005, name: "Shorts", type: "Pants", texture: plain(0x2b8a5a, 0x1f6844) },
  // -- t-shirts (graphic on the torso front) --------------------------------
  { id: 3001, name: "Smiley Tee", type: "TShirt", texture: withLogo(0xf2c53d, 0x2b2b2b, ":)") },
  { id: 3002, name: "MiBlox Tee", type: "TShirt", texture: withLogo(0xffffff, 0x5aa9ff, "M") },
  // -- hats -----------------------------------------------------------------
  { id: 4001, name: "Baseball Cap", type: "Hat", meshId: "builtin:cap", color: 0xc0453f, scale: [2.1, 1, 2.1] },
  { id: 4002, name: "Top Hat", type: "Hat", meshId: "builtin:cylinder", color: 0x18191f, scale: [1.7, 1.6, 1.7], offset: [0, 0.4, 0] },
  { id: 4003, name: "Crown", type: "Hat", meshId: "builtin:crown", color: 0xf2c53d, scale: [2, 1.2, 2] },
  { id: 4004, name: "Party Cone", type: "Hat", meshId: "builtin:cone", color: 0xb469d6, scale: [1.6, 2, 1.6] },
  { id: 4005, name: "Hard Hat", type: "Hat", meshId: "builtin:cap", color: 0xf2a33d, scale: [2.2, 1.2, 2.2] },
  // -- hair -----------------------------------------------------------------
  { id: 5001, name: "Short Hair", type: "Hair", meshId: "builtin:cap", color: 0x3a2a1d, scale: [2.15, 0.7, 1.15] },
  { id: 5002, name: "Long Hair", type: "Hair", meshId: "builtin:capsule", color: 0x6b3f22, scale: [2.2, 1.6, 1.35], offset: [0, -0.35, 0.12] },
  { id: 5003, name: "Spiky Hair", type: "Hair", meshId: "builtin:crown", color: 0x1d1d22, scale: [2.05, 0.8, 1.1] },
  { id: 5004, name: "Blonde Bob", type: "Hair", meshId: "builtin:sphere", color: 0xd9b45b, scale: [2.25, 1.2, 1.35], offset: [0, -0.2, 0] },
  // -- faces ----------------------------------------------------------------
  { id: 6001, name: "Smile", type: "Face", texture: svg(
    `<rect width="256" height="256" fill="none"/>` +
      `<circle cx="88" cy="96" r="14" fill="#1b1b1b"/><circle cx="168" cy="96" r="14" fill="#1b1b1b"/>` +
      `<path d="M78 150 Q128 196 178 150" stroke="#1b1b1b" stroke-width="12" fill="none" stroke-linecap="round"/>`,
  ) },
  { id: 6002, name: "Surprised", type: "Face", texture: svg(
    `<circle cx="88" cy="96" r="16" fill="#1b1b1b"/><circle cx="168" cy="96" r="16" fill="#1b1b1b"/>` +
      `<ellipse cx="128" cy="168" rx="26" ry="32" fill="#1b1b1b"/>`,
  ) },
];

const BY_ID = new Map(BUILTIN_ASSETS.map((asset) => [asset.id, asset]));

export function getAsset(id: number): AssetInfo | undefined {
  return BY_ID.get(id);
}

export function assetsOfType(type: AssetType): AssetInfo[] {
  return BUILTIN_ASSETS.filter((asset) => asset.type === type);
}

/**
 * Whether an asset can be worn in a given slot.
 *
 * This is the check behind "insert a number and get compatible pants": a
 * Pants field only accepts ids from the pants range, so a typo shows up as a
 * clear rejection rather than a hat appearing on somebody's legs.
 */
export function isCompatible(id: number, type: AssetType): boolean {
  if (id === 0) return true; // 0 always means "nothing in this slot".
  const asset = getAsset(id);
  if (asset) return asset.type === type;
  return assetTypeOf(id) === type;
}

/** Parses Roblox's comma-separated accessory id lists. */
export function parseAssetList(value: string | number | undefined): number[] {
  if (value === undefined || value === "" || value === 0) return [];
  return String(value)
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isFinite(id) && id > 0);
}

/** `builtin:<shape>` names a shape the renderer builds itself. */
export function isBuiltinMesh(meshId: string): boolean {
  return meshId.startsWith("builtin:");
}

export function builtinMeshName(meshId: string): string {
  return meshId.slice("builtin:".length);
}

/** Shapes the renderer can build without downloading anything. */
export const BUILTIN_MESHES = [
  "sphere",
  "cylinder",
  "cone",
  "torus",
  "wedge",
  "diamond",
  "capsule",
  "cap",
  "crown",
] as const;
export type BuiltinMesh = (typeof BUILTIN_MESHES)[number];
