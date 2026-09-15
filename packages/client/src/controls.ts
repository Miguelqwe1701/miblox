import * as THREE from "three";

export type Platform = "Desktop" | "Mobile" | "VR" | "Console";

export interface InputState {
  /** Desired movement in camera space, each axis in -1..1. */
  move: THREE.Vector2;
  jump: boolean;
  sprint: boolean;
  /** Accumulated look delta since the last read, in radians. */
  lookYaw: number;
  lookPitch: number;
  zoom: number;
  primary: boolean;
  secondary: boolean;
  /** Set for one frame when the action was newly pressed. */
  primaryPressed: boolean;
  secondaryPressed: boolean;
}

/** Detects the platform, which decides which control scheme is active. */
export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "Desktop";
  // Touch capability alone is not enough: plenty of laptops report touch
  // points, and some headless browsers report them with no pointer at all.
  // Mobile means a coarse primary pointer, no hover, and a small screen.
  const coarse = matchMedia("(pointer: coarse)").matches;
  const cannotHover = matchMedia("(hover: none)").matches;
  const small = Math.min(window.innerWidth, window.innerHeight) < 820;
  if (navigator.maxTouchPoints > 0 && coarse && cannotHover && small) return "Mobile";
  return "Desktop";
}

const MOVE_KEYS: Record<string, [number, number]> = {
  KeyW: [0, -1], ArrowUp: [0, -1],
  KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0],
};

/**
 * One input layer for every platform.
 *
 * Each scheme writes into the same InputState, so nothing downstream needs to
 * know whether the player is on a keyboard, a phone or a headset.
 */
export class Controls {
  readonly state: InputState = {
    move: new THREE.Vector2(),
    jump: false,
    sprint: false,
    lookYaw: 0,
    lookPitch: 0,
    zoom: 0,
    primary: false,
    secondary: false,
    primaryPressed: false,
    secondaryPressed: false,
  };

  platform: Platform;
  /** True while the pointer is captured, which is when mouse look applies. */
  pointerLocked = false;
  /** Multiplier on look input, from the settings panel. */
  sensitivity = 1;
  invertY = false;
  /** Set by the VR session, and blended with the other schemes. */
  vrMove = new THREE.Vector2();
  vrJump = false;

  private keys = new Set<string>();
  private touches = new Map<number, { startX: number; startY: number; x: number; y: number; kind: "move" | "look" }>();
  private disposers: Array<() => void> = [];
  private primaryWasDown = false;
  private secondaryWasDown = false;

  constructor(private readonly canvas: HTMLElement) {
    this.platform = detectPlatform();
    this.bindKeyboard();
    this.bindMouse();
    this.bindTouch();
  }

  // -- keyboard and mouse --------------------------------------------------

  private bindKeyboard(): void {
    const down = (event: KeyboardEvent) => {
      // Let the browser keep its own shortcuts and text entry.
      if (event.target instanceof HTMLInputElement) return;
      this.keys.add(event.code);
      if (event.code === "Space") event.preventDefault();
    };
    const up = (event: KeyboardEvent) => this.keys.delete(event.code);
    const blur = () => this.keys.clear();

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    // Keys held when focus is lost would otherwise stick down forever.
    window.addEventListener("blur", blur);
    this.disposers.push(() => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    });
  }

  private bindMouse(): void {
    const move = (event: MouseEvent) => {
      if (!this.pointerLocked) return;
      const scale = 0.0022 * this.sensitivity;
      this.state.lookYaw -= event.movementX * scale;
      this.state.lookPitch -= event.movementY * scale * (this.invertY ? -1 : 1);
    };
    const down = (event: MouseEvent) => {
      if (event.button === 0) this.state.primary = true;
      if (event.button === 2) this.state.secondary = true;
    };
    const up = (event: MouseEvent) => {
      if (event.button === 0) this.state.primary = false;
      if (event.button === 2) this.state.secondary = false;
    };
    const wheel = (event: WheelEvent) => {
      this.state.zoom += Math.sign(event.deltaY) * 2;
      event.preventDefault();
    };
    const contextMenu = (event: Event) => event.preventDefault();
    const lockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
    };

    this.canvas.addEventListener("mousedown", down);
    window.addEventListener("mouseup", up);
    window.addEventListener("mousemove", move);
    this.canvas.addEventListener("wheel", wheel, { passive: false });
    this.canvas.addEventListener("contextmenu", contextMenu);
    document.addEventListener("pointerlockchange", lockChange);
    this.disposers.push(() => {
      this.canvas.removeEventListener("mousedown", down);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("mousemove", move);
      this.canvas.removeEventListener("wheel", wheel);
      this.canvas.removeEventListener("contextmenu", contextMenu);
      document.removeEventListener("pointerlockchange", lockChange);
    });
  }

  requestPointerLock(): void {
    if (this.platform === "Desktop") void this.canvas.requestPointerLock?.();
  }

  // -- touch ---------------------------------------------------------------

  /**
   * Phone controls: the left half of the screen is a virtual stick, the right
   * half turns the camera. A tap on the right without a drag is the primary
   * action, which is what a place-block or tool tap needs.
   */
  private bindTouch(): void {
    const start = (event: TouchEvent) => {
      for (const touch of Array.from(event.changedTouches)) {
        const kind = touch.clientX < window.innerWidth / 2 ? "move" : "look";
        this.touches.set(touch.identifier, {
          startX: touch.clientX,
          startY: touch.clientY,
          x: touch.clientX,
          y: touch.clientY,
          kind,
        });
      }
      event.preventDefault();
    };

    const move = (event: TouchEvent) => {
      for (const touch of Array.from(event.changedTouches)) {
        const tracked = this.touches.get(touch.identifier);
        if (!tracked) continue;
        if (tracked.kind === "look") {
          const scale = 0.006 * this.sensitivity;
          this.state.lookYaw -= (touch.clientX - tracked.x) * scale;
          this.state.lookPitch -= (touch.clientY - tracked.y) * scale * (this.invertY ? -1 : 1);
        }
        tracked.x = touch.clientX;
        tracked.y = touch.clientY;
      }
      event.preventDefault();
    };

    const end = (event: TouchEvent) => {
      for (const touch of Array.from(event.changedTouches)) {
        const tracked = this.touches.get(touch.identifier);
        this.touches.delete(touch.identifier);
        if (!tracked || tracked.kind !== "look") continue;
        const travel = Math.hypot(tracked.x - tracked.startX, tracked.y - tracked.startY);
        // A tap, not a drag, so treat it as the primary action.
        if (travel < 12) this.state.primaryPressed = true;
      }
      event.preventDefault();
    };

    this.canvas.addEventListener("touchstart", start, { passive: false });
    this.canvas.addEventListener("touchmove", move, { passive: false });
    this.canvas.addEventListener("touchend", end, { passive: false });
    this.canvas.addEventListener("touchcancel", end, { passive: false });
    this.disposers.push(() => {
      this.canvas.removeEventListener("touchstart", start);
      this.canvas.removeEventListener("touchmove", move);
      this.canvas.removeEventListener("touchend", end);
      this.canvas.removeEventListener("touchcancel", end);
    });
  }

  /** Called by the mobile HUD's jump button. */
  pressJump(): void {
    this.state.jump = true;
  }

  // -- per-frame -----------------------------------------------------------

  /** Reads every scheme into `state`. Call once per frame, before using it. */
  update(): InputState {
    const move = this.state.move.set(0, 0);

    // Keyboard
    for (const [code, [x, y]] of Object.entries(MOVE_KEYS)) {
      if (this.keys.has(code)) move.x += x, move.y += y;
    }
    if (this.keys.has("Space")) this.state.jump = true;
    this.state.sprint = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");

    // Touch stick: offset of the held finger from where it landed.
    for (const touch of this.touches.values()) {
      if (touch.kind !== "move") continue;
      const dx = (touch.x - touch.startX) / 60;
      const dy = (touch.y - touch.startY) / 60;
      move.x += THREE.MathUtils.clamp(dx, -1, 1);
      move.y += THREE.MathUtils.clamp(dy, -1, 1);
    }

    // Gamepad, which also covers console-style controllers.
    const pad = typeof navigator !== "undefined" ? navigator.getGamepads?.()[0] : null;
    if (pad) {
      const dead = (v: number) => (Math.abs(v) < 0.18 ? 0 : v);
      move.x += dead(pad.axes[0] ?? 0);
      move.y += dead(pad.axes[1] ?? 0);
      this.state.lookYaw -= dead(pad.axes[2] ?? 0) * 0.04;
      this.state.lookPitch -= dead(pad.axes[3] ?? 0) * 0.04;
      if (pad.buttons[0]?.pressed) this.state.jump = true;
      if (pad.buttons[7]?.pressed) this.state.primary = true;
      if (pad.buttons[6]?.pressed) this.state.secondary = true;
      this.state.sprint ||= pad.buttons[10]?.pressed ?? false;
    }

    // VR thumbstick, written by the session each frame.
    move.x += this.vrMove.x;
    move.y += this.vrMove.y;
    if (this.vrJump) {
      this.state.jump = true;
      this.vrJump = false;
    }

    if (move.lengthSq() > 1) move.normalize();

    this.state.primaryPressed = this.state.primaryPressed || (this.state.primary && !this.primaryWasDown);
    this.state.secondaryPressed = this.state.secondary && !this.secondaryWasDown;
    this.primaryWasDown = this.state.primary;
    this.secondaryWasDown = this.state.secondary;

    this.state.lookPitch = THREE.MathUtils.clamp(this.state.lookPitch, -1.35, 1.35);
    return this.state;
  }

  /** Clears the one-frame flags. Call after the frame has consumed them. */
  endFrame(): void {
    this.state.jump = false;
    this.state.primaryPressed = false;
    this.state.secondaryPressed = false;
    this.state.zoom = 0;
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
  }
}
