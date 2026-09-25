import { Color3, UDim2, Vector2 } from "./math.js";
import { Instance, registerClass, type PropSchema } from "./instance.js";
import { Signal } from "./signal.js";

/**
 * Screen GUIs a place builds for itself: ScreenGui, Frame, TextLabel,
 * TextButton and ImageLabel.
 *
 * These are ordinary replicated instances. A place puts them in StarterGui,
 * the server copies them into each player's PlayerGui when their character
 * spawns, and the client draws whatever is under its own PlayerGui. A
 * LocalScript can also build them on the client, where they stay local.
 */

const p = (kind: PropSchema[string]["kind"], def: unknown) =>
  ({ kind, default: def, replicated: true }) as PropSchema[string];

export const TextXAlignment = { Left: "Left", Center: "Center", Right: "Right" } as const;
export const TextYAlignment = { Top: "Top", Center: "Center", Bottom: "Bottom" } as const;

/** Holds a player's GUIs. The client draws only its own player's. */
export class PlayerGui extends Instance {
  readonly className = "PlayerGui";
}
registerClass("PlayerGui", PlayerGui, {});

export class ScreenGui extends Instance {
  readonly className = "ScreenGui";
  Enabled = true;
  /** Copied again from StarterGui each time the character respawns. */
  ResetOnSpawn = true;
  /** Higher draws on top of lower. */
  DisplayOrder = 0;

  protected override ancestryClassNames(): string[] {
    return ["LayerCollector", "GuiBase2d", "GuiBase", "Instance"];
  }
}
registerClass("ScreenGui", ScreenGui, {
  Enabled: p("boolean", true),
  ResetOnSpawn: p("boolean", true),
  DisplayOrder: p("number", 0),
});

export class GuiObject extends Instance {
  readonly className: string = "GuiObject";
  Position: UDim2 = UDim2.zero;
  Size: UDim2 = UDim2.fromOffset(100, 100);
  /** Which point of the object sits at Position, as a fraction of its size. */
  AnchorPoint: Vector2 = Vector2.zero;
  BackgroundColor3: Color3 = Color3.fromRGB(255, 255, 255);
  BackgroundTransparency = 0;
  BorderColor3: Color3 = Color3.fromRGB(27, 42, 53);
  BorderSizePixel = 1;
  Rotation = 0;
  Visible = true;
  ZIndex = 1;

  readonly MouseEnter = new Signal<[]>();
  readonly MouseLeave = new Signal<[]>();

  protected override ancestryClassNames(): string[] {
    return ["GuiObject", "GuiBase2d", "GuiBase", "Instance"];
  }
}

const guiObjectSchema: PropSchema = {
  Position: p("UDim2", UDim2.zero),
  Size: p("UDim2", UDim2.fromOffset(100, 100)),
  AnchorPoint: p("Vector2", Vector2.zero),
  BackgroundColor3: p("Color3", Color3.fromRGB(255, 255, 255)),
  BackgroundTransparency: p("number", 0),
  BorderColor3: p("Color3", Color3.fromRGB(27, 42, 53)),
  BorderSizePixel: p("number", 1),
  Rotation: p("number", 0),
  Visible: p("boolean", true),
  ZIndex: p("number", 1),
};

export class Frame extends GuiObject {
  override readonly className: string = "Frame";
  protected override ancestryClassNames(): string[] {
    return ["Frame", ...super.ancestryClassNames()];
  }
}
registerClass("Frame", Frame, guiObjectSchema);

const textSchema: PropSchema = {
  Text: p("string", "Label"),
  TextColor3: p("Color3", Color3.fromRGB(27, 42, 53)),
  TextSize: p("number", 14),
  TextTransparency: p("number", 0),
  TextScaled: p("boolean", false),
  TextWrapped: p("boolean", false),
  TextXAlignment: p("string", "Center"),
  TextYAlignment: p("string", "Center"),
};

export class TextLabel extends GuiObject {
  override readonly className: string = "TextLabel";
  Text = "Label";
  TextColor3: Color3 = Color3.fromRGB(27, 42, 53);
  TextSize = 14;
  TextTransparency = 0;
  /** Grows or shrinks the text to fill the object, ignoring TextSize. */
  TextScaled = false;
  TextWrapped = false;
  TextXAlignment = "Center";
  TextYAlignment = "Center";

  protected override ancestryClassNames(): string[] {
    return ["TextLabel", ...super.ancestryClassNames()];
  }
}
registerClass("TextLabel", TextLabel, {
  ...guiObjectSchema,
  Size: p("UDim2", UDim2.fromOffset(200, 50)),
  ...textSchema,
});

export class TextButton extends TextLabel {
  override readonly className: string = "TextButton";
  override Text = "Button";
  /** Darkens the button while hovered or pressed. */
  AutoButtonColor = true;
  /** While visible, frees the mouse from camera control so it can be clicked. */
  Modal = false;

  /** Fired on the client that clicked it; send a RemoteEvent to tell the server. */
  readonly MouseButton1Click = new Signal<[]>();
  readonly Activated = new Signal<[]>();

  protected override ancestryClassNames(): string[] {
    return ["TextButton", "GuiButton", ...super.ancestryClassNames().slice(1)];
  }
}
registerClass("TextButton", TextButton, {
  ...guiObjectSchema,
  Size: p("UDim2", UDim2.fromOffset(200, 50)),
  ...textSchema,
  Text: p("string", "Button"),
  AutoButtonColor: p("boolean", true),
  Modal: p("boolean", false),
});

export class ImageLabel extends GuiObject {
  override readonly className: string = "ImageLabel";
  /** Image URL, as with a part's TextureId. */
  Image = "";
  ImageColor3: Color3 = Color3.fromRGB(255, 255, 255);
  ImageTransparency = 0;

  protected override ancestryClassNames(): string[] {
    return ["ImageLabel", ...super.ancestryClassNames()];
  }
}
registerClass("ImageLabel", ImageLabel, {
  ...guiObjectSchema,
  Image: p("string", ""),
  ImageColor3: p("Color3", Color3.fromRGB(255, 255, 255)),
  ImageTransparency: p("number", 0),
});

/** The player's PlayerGui, created on first use. */
export function playerGuiOf(player: Instance): PlayerGui {
  const existing = player.FindFirstChildOfClass("PlayerGui");
  if (existing) return existing as PlayerGui;
  const gui = new PlayerGui();
  gui.Name = "PlayerGui";
  gui.setParent(player);
  return gui;
}

/**
 * Copies StarterGui into a player's PlayerGui, as Roblox does whenever a
 * character spawns.
 *
 * A ScreenGui with ResetOnSpawn is replaced by a fresh copy on every spawn,
 * which is what puts a round timer back to its starting state. One without it
 * is given once and then left alone, so a shop's state survives dying.
 */
export function copyStarterGui(player: Instance, starterGui: Instance | null): PlayerGui {
  const playerGui = playerGuiOf(player);
  if (!starterGui) return playerGui;
  const given = givenOnce.get(playerGui) ?? new WeakSet<Instance>();
  givenOnce.set(playerGui, given);

  for (const child of playerGui.GetChildren()) {
    if (!(child instanceof ScreenGui) || child.ResetOnSpawn) child.Destroy();
  }
  for (const template of starterGui.GetChildren()) {
    const keep = template instanceof ScreenGui && !template.ResetOnSpawn;
    if (keep && given.has(template)) continue;
    const copy = template.Clone();
    if (!copy) continue;
    copy.setParent(playerGui);
    if (keep) given.add(template);
  }
  return playerGui;
}

const givenOnce = new WeakMap<PlayerGui, WeakSet<Instance>>();
