import * as THREE from "three";
import type { GameSummary } from "./hud.js";

export interface KioskSelection {
  gameId: string;
  name: string;
}

/**
 * The in-world game picker.
 *
 * The lobby is a real place players join, and this draws the catalogue into it
 * as panels standing in the room. They are local decoration, not replicated
 * instances: the list changes as worlds are published, and nobody should have
 * to rebuild the lobby for that.
 *
 * The point of it is VR. Picking a world by taking the headset off, using the
 * computer, and putting the headset back on is the worst part of VR games;
 * pointing at a panel in the room you are already standing in is not.
 */
export class LobbyKiosks {
  readonly group = new THREE.Group();
  private panels: Array<{ mesh: THREE.Mesh; game: GameSummary; base: THREE.Vector3 }> = [];
  private highlighted: THREE.Mesh | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private time = 0;

  constructor(private readonly onPick: (selection: KioskSelection) => void) {
    this.group.name = "LobbyKiosks";
  }

  /** Lays the catalogue out in an arc in front of the spawn. */
  build(games: GameSummary[]): void {
    this.clear();
    const visible = games.filter((game) => game.id !== "lobby");
    if (!visible.length) return;

    const radius = 26;
    const spread = Math.min(Math.PI * 0.9, visible.length * 0.42);
    visible.forEach((game, index) => {
      const t = visible.length === 1 ? 0 : index / (visible.length - 1) - 0.5;
      const angle = t * spread;
      // Arranged around the spawn, which sits at +Z looking inward.
      const x = Math.sin(angle) * radius;
      const z = 30 - Math.cos(angle) * radius;

      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(11, 7, 0.6),
        new THREE.MeshLambertMaterial({ map: this.panelTexture(game), emissive: 0x0a1626 }),
      );
      panel.position.set(x, 9, z);
      panel.lookAt(0, 9, 30);
      panel.castShadow = true;
      panel.userData.gameId = game.id;

      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.35, 0.35, 5.5, 10),
        new THREE.MeshLambertMaterial({ color: 0x35435c }),
      );
      post.position.set(x, 5.2, z);

      this.group.add(panel, post);
      this.panels.push({ mesh: panel, game, base: panel.position.clone() });
    });
  }

  /** Draws a game's card onto a canvas, used as the panel's texture. */
  private panelTexture(game: GameSummary): THREE.Texture {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 320;
    const ctx = canvas.getContext("2d")!;

    const backdrop = ctx.createLinearGradient(0, 0, 512, 320);
    backdrop.addColorStop(0, "#1d2942");
    backdrop.addColorStop(1, "#111722");
    ctx.fillStyle = backdrop;
    ctx.fillRect(0, 0, 512, 320);

    ctx.strokeStyle = "#5aa9ff";
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, 506, 314);

    const art = ctx.createLinearGradient(0, 0, 512, 150);
    art.addColorStop(0, "#4a7fb8");
    art.addColorStop(1, "#2b3d5c");
    ctx.fillStyle = art;
    ctx.fillRect(16, 16, 480, 132);

    ctx.fillStyle = "#ffffff42";
    ctx.font = "700 92px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(game.name.slice(0, 2).toUpperCase(), 256, 116);

    ctx.fillStyle = "#e9eef7";
    ctx.font = "700 40px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(clip(ctx, game.name, 44, 470), 22, 196);

    ctx.fillStyle = "#93a1b8";
    ctx.font = "24px system-ui, sans-serif";
    ctx.fillText(clip(ctx, game.description || "No description", 24, 470), 22, 232);

    ctx.fillStyle = "#5aa9ff";
    ctx.font = "600 22px system-ui, sans-serif";
    ctx.fillText(`Up to ${game.maxPlayers} players`, 22, 274);
    ctx.textAlign = "right";
    ctx.fillText("Point and select →", 490, 274);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  /**
   * Highlights whatever a ray is pointing at.
   *
   * The same call serves the desktop crosshair and a VR controller's ray, so
   * both feel identical and there is one code path to get right.
   */
  aim(origin: THREE.Vector3, direction: THREE.Vector3): KioskSelection | null {
    this.raycaster.set(origin, direction.clone().normalize());
    this.raycaster.far = 90;
    const hits = this.raycaster.intersectObjects(
      this.panels.map((panel) => panel.mesh),
      false,
    );
    const hit = hits[0]?.object as THREE.Mesh | undefined;

    if (this.highlighted && this.highlighted !== hit) {
      (this.highlighted.material as THREE.MeshLambertMaterial).emissive.setHex(0x0a1626);
      this.highlighted = null;
    }
    if (!hit) return null;

    this.highlighted = hit;
    (hit.material as THREE.MeshLambertMaterial).emissive.setHex(0x1d4f8a);
    const entry = this.panels.find((panel) => panel.mesh === hit);
    return entry ? { gameId: entry.game.id, name: entry.game.name } : null;
  }

  /** Selects whatever is currently aimed at. Returns true if something was. */
  select(): boolean {
    if (!this.highlighted) return false;
    const entry = this.panels.find((panel) => panel.mesh === this.highlighted);
    if (!entry) return false;
    this.onPick({ gameId: entry.game.id, name: entry.game.name });
    return true;
  }

  /** A gentle bob, so the room reads as alive rather than a static render. */
  update(dt: number): void {
    this.time += dt;
    for (const [index, panel] of this.panels.entries()) {
      panel.mesh.position.y = panel.base.y + Math.sin(this.time * 0.9 + index) * 0.25;
    }
  }

  clear(): void {
    for (const panel of this.panels) {
      panel.mesh.geometry.dispose();
      const material = panel.mesh.material as THREE.MeshLambertMaterial;
      material.map?.dispose();
      material.dispose();
    }
    this.group.clear();
    this.panels = [];
    this.highlighted = null;
  }

  get isEmpty(): boolean {
    return this.panels.length === 0;
  }
}

/** Trims text to fit a width, adding an ellipsis when it does not. */
function clip(ctx: CanvasRenderingContext2D, text: string, size: number, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 3 && ctx.measureText(`${cut}…`).width > maxWidth) {
    cut = cut.slice(0, -1);
  }
  void size;
  return `${cut}…`;
}
