/** Enum values are plain strings so they survive JSON round-trips unchanged. */

export const Material = {
  Plastic: "Plastic",
  Wood: "Wood",
  Slate: "Slate",
  Concrete: "Concrete",
  Brick: "Brick",
  Grass: "Grass",
  Sand: "Sand",
  Metal: "Metal",
  Glass: "Glass",
  Ice: "Ice",
  Neon: "Neon",
  Water: "Water",
  Rock: "Rock",
  Snow: "Snow",
} as const;
export type MaterialName = keyof typeof Material;

export const PartShape = {
  Block: "Block",
  Ball: "Ball",
  Cylinder: "Cylinder",
  Wedge: "Wedge",
} as const;
export type PartShapeName = keyof typeof PartShape;

export const HumanoidStateType = {
  Running: "Running",
  Jumping: "Jumping",
  Freefall: "Freefall",
  Landed: "Landed",
  Swimming: "Swimming",
  Seated: "Seated",
  Dead: "Dead",
} as const;
export type HumanoidStateTypeName = keyof typeof HumanoidStateType;

export const RunContext = {
  Server: "Server",
  Client: "Client",
  Legacy: "Legacy",
} as const;

export const KeyCode = {
  W: "W", A: "A", S: "S", D: "D", Q: "Q", E: "E", R: "R", F: "F",
  Space: "Space", LeftShift: "LeftShift", LeftControl: "LeftControl",
  One: "One", Two: "Two", Three: "Three", Four: "Four", Five: "Five",
  Escape: "Escape", Tab: "Tab", Return: "Return",
  MouseLeft: "MouseLeft", MouseRight: "MouseRight",
  ButtonA: "ButtonA", ButtonB: "ButtonB", ButtonX: "ButtonX", ButtonY: "ButtonY",
  Trigger: "Trigger", Grip: "Grip", Thumbstick: "Thumbstick",
} as const;
export type KeyCodeName = keyof typeof KeyCode;

export const UserInputType = {
  Keyboard: "Keyboard",
  MouseButton1: "MouseButton1",
  MouseButton2: "MouseButton2",
  MouseMovement: "MouseMovement",
  MouseWheel: "MouseWheel",
  Touch: "Touch",
  Gamepad1: "Gamepad1",
  VRHand: "VRHand",
} as const;
export type UserInputTypeName = keyof typeof UserInputType;

export const UserInputState = {
  Begin: "Begin",
  Change: "Change",
  End: "End",
} as const;

/** Which platform the client is running on; drives control scheme selection. */
export const Platform = {
  Desktop: "Desktop",
  Mobile: "Mobile",
  VR: "VR",
  Console: "Console",
} as const;
export type PlatformName = keyof typeof Platform;

/** Physical response of a material, used by the terrain and part solver. */
export const MaterialProperties: Record<
  string,
  { density: number; friction: number; elasticity: number; color: number }
> = {
  Plastic: { density: 0.7, friction: 0.3, elasticity: 0.5, color: 0xa3a2a5 },
  Wood: { density: 0.35, friction: 0.48, elasticity: 0.2, color: 0x8b5a2b },
  Slate: { density: 2.69, friction: 0.4, elasticity: 0.2, color: 0x525252 },
  Concrete: { density: 2.4, friction: 0.7, elasticity: 0.2, color: 0x8f8f8f },
  Brick: { density: 1.92, friction: 0.8, elasticity: 0.15, color: 0x9c5c4a },
  Grass: { density: 0.9, friction: 0.4, elasticity: 0.1, color: 0x4f8f38 },
  Sand: { density: 1.6, friction: 0.5, elasticity: 0.05, color: 0xd8c893 },
  Metal: { density: 7.85, friction: 0.4, elasticity: 0.25, color: 0x8c8c94 },
  Glass: { density: 2.4, friction: 0.25, elasticity: 0.2, color: 0xc9e6f0 },
  Ice: { density: 0.92, friction: 0.02, elasticity: 0.15, color: 0xb8e2ee },
  Neon: { density: 0.7, friction: 0.3, elasticity: 0.2, color: 0xffffff },
  Water: { density: 1.0, friction: 0.0, elasticity: 0.0, color: 0x2a6fa8 },
  Rock: { density: 2.6, friction: 0.55, elasticity: 0.15, color: 0x6b6b6b },
  Snow: { density: 0.4, friction: 0.35, elasticity: 0.05, color: 0xf0f5fa },
};

export function materialProps(name: string) {
  return MaterialProperties[name] ?? MaterialProperties.Plastic;
}
