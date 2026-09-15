import { MATERIAL_ID } from "@miblox/core";

export interface HotbarSlot {
  name: string;
  /** Voxel material placed by this slot, or 0 to dig. */
  material: number;
  color: string;
  hint: string;
}

/**
 * What the player is holding.
 *
 * Deliberately short: six slots, one of them the dig tool, selected with the
 * number keys or the scroll wheel. Building and digging is the whole of the
 * starter game loop, so this is the only inventory it needs.
 */
export const HOTBAR: HotbarSlot[] = [
  { name: "Dig", material: 0, color: "#cfd8e6", hint: "Remove terrain" },
  { name: "Grass", material: MATERIAL_ID.Grass, color: "#4f8f38", hint: "Place grass" },
  { name: "Rock", material: MATERIAL_ID.Rock, color: "#6b6b6b", hint: "Place rock" },
  { name: "Sand", material: MATERIAL_ID.Sand, color: "#d8c893", hint: "Place sand" },
  { name: "Snow", material: MATERIAL_ID.Snow, color: "#f0f5fa", hint: "Place snow" },
  { name: "Brick", material: MATERIAL_ID.Brick, color: "#9c5c4a", hint: "Place brick" },
];
