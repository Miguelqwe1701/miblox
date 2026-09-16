import {
  BasePart,
  DataModel,
  Humanoid,
  Model,
  PhysicsWorld,
  Vector3,
} from "@miblox/core";
import type { Connection } from "./net.js";

/**
 * Client-side simulation of the parts this player owns.
 *
 * With Server Auth off, the server hands each player their own character and
 * takes their word for where it is. Simulating it here means input is applied
 * on the frame it happens instead of a round trip later, which is the whole
 * difference between responsive and floaty movement.
 *
 * Only owned parts are stepped; everything else arrives replicated, so no body
 * is ever integrated twice.
 */
export class ClientSimulation {
  readonly physics: PhysicsWorld;
  /** How often owned state is reported, in seconds. */
  private sendInterval = 1 / 20;
  private sendAccumulator = 0;

  constructor(
    private readonly game: DataModel,
    private readonly connection: Connection,
  ) {
    this.physics = new PhysicsWorld(this.game.Workspace, this.game.Terrain.voxels);
    this.physics.simulationFilter = (part) => this.owns(part);
  }

  /** True when this client is responsible for simulating `part`. */
  owns(part: BasePart): boolean {
    if (this.connection.serverAuthoritative) return false;
    const id = this.connection.localPlayerId;
    return !!id && part.NetworkOwnerId === id;
  }

  get character(): Model | null {
    return this.connection.localPlayer?.Character ?? null;
  }

  get root(): BasePart | null {
    const character = this.character;
    if (!character) return null;
    return (character.FindFirstChild("HumanoidRootPart") as BasePart) ?? null;
  }

  get humanoid(): Humanoid | null {
    const character = this.character;
    if (!character) return null;
    return (character.FindFirstChildOfClass("Humanoid") as Humanoid) ?? null;
  }

  /**
   * Applies input and advances the bodies this client owns.
   *
   * `moveWorld` is a world-space direction from the camera basis; the server is
   * told the same direction so a server-authoritative place behaves the same.
   */
  step(dt: number, moveWorld: Vector3, jump: boolean): void {
    const humanoid = this.humanoid;
    const root = this.root;

    if (humanoid) {
      humanoid.MoveDirection = moveWorld.magnitude > 1 ? moveWorld.unit : moveWorld;
      if (jump) humanoid.Jump = true;
    }

    // Always tell the server the intent, even when simulating locally: it keeps
    // the server's Humanoid state right for other players and for scripts.
    this.connection.sendInput([moveWorld.x, moveWorld.y, moveWorld.z], jump);

    if (this.connection.serverAuthoritative || !root) return;

    this.physics.step(dt);

    this.sendAccumulator += dt;
    if (this.sendAccumulator < this.sendInterval) return;
    this.sendAccumulator = 0;
    this.report();
  }

  /** Sends the pose of every part this client owns. */
  private report(): void {
    const updates: Array<{ id: string; cf: number[]; v: number[] }> = [];
    for (const [id, inst] of this.connection.replica.byId) {
      if (!(inst instanceof BasePart)) continue;
      if (!this.owns(inst)) continue;
      updates.push({
        id,
        cf: inst.CFrame.toComponents(),
        v: inst.AssemblyLinearVelocity.toArray(),
      });
    }
    this.connection.sendState(updates);
  }
}
