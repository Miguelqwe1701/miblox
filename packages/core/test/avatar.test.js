import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_ASSETS,
  DEFAULT_DESCRIPTION,
  TEMPLATE_DESCRIPTION,
  Vector3,
  applyDescriptionTo,
  assetsOfType,
  buildAvatar,
  describeAvatar,
  fromDescriptionInstance,
  getAsset,
  isCompatible,
  parseAssetList,
  toDescriptionInstance,
  validateDescription,
} from "../dist/index.js";

test("a default avatar is a working rig", () => {
  const model = buildAvatar();
  assert.ok(model.FindFirstChildOfClass("Humanoid"), "needs a Humanoid to be driven");
  assert.ok(model.FindFirstChild("HumanoidRootPart"), "needs a root to be moved by");
});

test("body colours reach the parts", () => {
  const model = buildAvatar({ headColor: 0xff0000, torsoColor: 0x00ff00 });
  assert.equal(model.FindFirstChild("Head").Color.toHex(), 0xff0000);
  assert.equal(model.FindFirstChild("Torso").Color.toHex(), 0x00ff00);
  // Unspecified slots keep the default rather than turning black.
  assert.equal(model.FindFirstChild("Left Leg").Color.toHex(), DEFAULT_DESCRIPTION.leftLegColor);
});

test("a shirt id textures the torso and arms, pants the legs", () => {
  const model = buildAvatar({ shirt: 1001, pants: 2001, graphicTShirt: 0 });
  const shirtTexture = getAsset(1001).texture;
  const pantsTexture = getAsset(2001).texture;

  assert.equal(model.FindFirstChild("Torso").TextureId, shirtTexture);
  assert.equal(model.FindFirstChild("Left Arm").TextureId, shirtTexture);
  assert.equal(model.FindFirstChild("Left Leg").TextureId, pantsTexture);
  assert.notEqual(model.FindFirstChild("Left Leg").TextureId, shirtTexture);
  assert.equal(model.FindFirstChildOfClass("Shirt").AssetId, 1001);
  assert.equal(model.FindFirstChildOfClass("Pants").AssetId, 2001);
});

test("a t-shirt graphic sits over the shirt on the torso", () => {
  const model = buildAvatar({ shirt: 1001, graphicTShirt: 3002 });
  assert.equal(model.FindFirstChild("Torso").TextureId, getAsset(3002).texture);
  // The arms keep the shirt underneath.
  assert.equal(model.FindFirstChild("Left Arm").TextureId, getAsset(1001).texture);
});

test("hats and hair are attached as Accessories with a Handle", () => {
  const model = buildAvatar({ hatAccessory: "4002", hairAccessory: "5001" });
  const hat = model.FindFirstChild("Top Hat");
  const hair = model.FindFirstChild("Short Hair");
  assert.ok(hat && hair);
  assert.equal(hat.AccessoryType, "Hat");
  assert.equal(hair.AccessoryType, "Hair");

  const handle = hat.FindFirstChild("Handle");
  assert.equal(handle.className, "MeshPart");
  assert.equal(handle.MeshId, "builtin:cylinder");
  assert.equal(handle.CanCollide, false, "a hat must not shove its wearer around");
  assert.equal(handle.CanQuery, false, "nor block a raycast");
  assert.equal(handle.Massless, true);
});

test("several accessories can share a slot", () => {
  const model = buildAvatar({ hatAccessory: "4001,4003" });
  assert.ok(model.FindFirstChild("Baseball Cap"));
  assert.ok(model.FindFirstChild("Crown"));
});

test("a hat sits above the head, hair below it", () => {
  const model = buildAvatar(
    { hatAccessory: "4001", hairAccessory: "5001" },
    { position: new Vector3(0, 50, 0) },
  );
  const head = model.FindFirstChild("Head").CFrame.position.y;
  const hat = model.FindFirstChild("Baseball Cap").FindFirstChild("Handle").CFrame.position.y;
  const hair = model.FindFirstChild("Short Hair").FindFirstChild("Handle").CFrame.position.y;
  assert.ok(hat > head, "the hat should be above the head");
  assert.ok(hair > head && hair < hat, "hair sits between the head and the hat");
});

test("applying a description twice does not stack accessories", () => {
  const model = buildAvatar({ hatAccessory: "4001" });
  applyDescriptionTo(model, { hatAccessory: "4001" });
  const hats = model.GetChildren().filter((c) => c.className === "Accessory" && c.AccessoryType === "Hat");
  assert.equal(hats.length, 1, "re-applying should replace, not accumulate");
});

test("applying a new description re-dresses in place", () => {
  const model = buildAvatar({ shirt: 1001, hatAccessory: "4001" });
  applyDescriptionTo(model, { shirt: 1002, hatAccessory: "4003", torsoColor: 0x123456 });

  assert.equal(model.FindFirstChildOfClass("Shirt").AssetId, 1002);
  assert.ok(model.FindFirstChild("Crown"), "the new hat should be on");
  assert.equal(model.FindFirstChild("Baseball Cap"), null, "the old hat should be gone");
  // The rig itself is the same model, so the player is not respawned.
  assert.ok(model.FindFirstChild("HumanoidRootPart"));
});

test("clearing a clothing slot removes the texture", () => {
  const model = buildAvatar({ shirt: 1001 });
  applyDescriptionTo(model, { shirt: 0 });
  assert.equal(model.FindFirstChild("Torso").TextureId, "");
  assert.equal(model.FindFirstChildOfClass("Shirt"), null);
});

test("a description carries humanoid settings", () => {
  const model = buildAvatar({ walkSpeed: 32, jumpPower: 70, maxHealth: 250 });
  const humanoid = model.FindFirstChildOfClass("Humanoid");
  assert.equal(humanoid.WalkSpeed, 32);
  assert.equal(humanoid.JumpPower, 70);
  assert.equal(humanoid.MaxHealth, 250);
});

test("humanoid:ApplyDescription re-dresses the character", () => {
  const model = buildAvatar({ shirt: 1001 });
  const humanoid = model.FindFirstChildOfClass("Humanoid");

  const description = toDescriptionInstance({ shirt: 1004, hatAccessory: "4003" });
  humanoid.ApplyDescription(description);

  assert.equal(model.FindFirstChildOfClass("Shirt").AssetId, 1004);
  assert.ok(model.FindFirstChild("Crown"));
});

test("humanoid:GetAppliedDescription reads the look back", () => {
  const model = buildAvatar({ shirt: 1003, pants: 2002, hatAccessory: "4001" });
  const humanoid = model.FindFirstChildOfClass("Humanoid");
  const described = fromDescriptionInstance(humanoid.GetAppliedDescription());
  assert.equal(described.shirt, 1003);
  assert.equal(described.pants, 2002);
  assert.equal(described.hatAccessory, "4001");
});

test("describeAvatar round-trips what buildAvatar produced", () => {
  const original = {
    headColor: 0xabcdef,
    torsoColor: 0x123456,
    leftArmColor: 0x111111,
    rightArmColor: 0x222222,
    leftLegColor: 0x333333,
    rightLegColor: 0x444444,
    shirt: 1002,
    pants: 2003,
    hatAccessory: "4003",
    hairAccessory: "5002",
  };
  const described = describeAvatar(buildAvatar(original));
  assert.equal(described.headColor, original.headColor);
  assert.equal(described.torsoColor, original.torsoColor);
  assert.equal(described.shirt, 1002);
  assert.equal(described.pants, 2003);
  assert.equal(described.hatAccessory, "4003");
  assert.equal(described.hairAccessory, "5002");
});

test("the instance and data forms convert both ways", () => {
  const data = { shirt: 1001, pants: 2002, headColor: 0xff8800, hatAccessory: "4001", walkSpeed: 24 };
  const instance = toDescriptionInstance(data);
  assert.equal(instance.Shirt, 1001);
  assert.equal(instance.HeadColor.toHex(), 0xff8800);
  assert.equal(instance.HatAccessory, "4001");

  const back = fromDescriptionInstance(instance);
  assert.equal(back.shirt, 1001);
  assert.equal(back.pants, 2002);
  assert.equal(back.headColor, 0xff8800);
  assert.equal(back.walkSpeed, 24);
});

test("asset compatibility is enforced per slot", () => {
  assert.ok(isCompatible(1001, "Shirt"));
  assert.ok(!isCompatible(1001, "Pants"), "a shirt id is not valid pants");
  assert.ok(isCompatible(2001, "Pants"));
  assert.ok(isCompatible(0, "Pants"), "0 always means nothing in that slot");

  const problems = validateDescription({ pants: 1001, shirt: 2001 });
  assert.equal(problems.length, 2);
  assert.match(problems.join(" "), /not a pants asset/);
  assert.match(problems.join(" "), /not a shirt asset/);
});

test("validation catches unknown accessories and silly scales", () => {
  assert.match(validateDescription({ hatAccessory: "999999" }).join(" "), /not a known accessory/);
  assert.match(validateDescription({ heightScale: 9 }).join(" "), /between 0.5 and 2.5/);
  assert.deepEqual(validateDescription(DEFAULT_DESCRIPTION), []);
  assert.deepEqual(validateDescription(TEMPLATE_DESCRIPTION), []);
});

test("accessory id lists parse the way Roblox writes them", () => {
  assert.deepEqual(parseAssetList("4001,4003"), [4001, 4003]);
  assert.deepEqual(parseAssetList(" 4001 , 4003 "), [4001, 4003]);
  assert.deepEqual(parseAssetList(""), []);
  assert.deepEqual(parseAssetList(undefined), []);
  assert.deepEqual(parseAssetList(0), []);
});

test("every catalogue asset is usable", () => {
  for (const asset of BUILTIN_ASSETS) {
    assert.ok(asset.texture || asset.meshId, `${asset.name} has nothing to draw`);
    assert.ok(isCompatible(asset.id, asset.type), `${asset.name} is in the wrong id range`);
  }
  assert.ok(assetsOfType("Shirt").length >= 4);
  assert.ok(assetsOfType("Hair").length >= 3);
  assert.ok(assetsOfType("Hat").length >= 4);
});

test("an avatar is made only of ordinary replicated instances", () => {
  const model = buildAvatar(TEMPLATE_DESCRIPTION);
  const allowed = ["Part", "MeshPart", "Accessory", "Humanoid", "Motor6D", "Shirt", "Pants", "ShirtGraphic"];
  for (const descendant of model.GetDescendants()) {
    assert.ok(allowed.includes(descendant.className), `unexpected class: ${descendant.className}`);
  }
});

test("the template avatar is recognisably not the default", () => {
  const template = buildAvatar(TEMPLATE_DESCRIPTION);
  assert.ok(template.FindFirstChild("Baseball Cap"));
  assert.notEqual(
    template.FindFirstChild("Torso").Color.toHex(),
    DEFAULT_DESCRIPTION.torsoColor,
  );
});

test("Mesh3D is a MeshPart under the editor's import name", () => {
  const model = buildAvatar({ hatAccessory: "4001" });
  const handle = model.FindFirstChild("Baseball Cap").FindFirstChild("Handle");
  assert.ok(handle.IsA("MeshPart"));
  assert.ok(handle.IsA("BasePart"));
});
