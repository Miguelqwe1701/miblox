/** Player preferences, persisted per browser. */
export interface Settings {
  sensitivity: number;
  fieldOfView: number;
  /** Chunks streamed around the player. */
  viewDistance: number;
  terrainStyle: "smooth" | "blocky";
  shadows: boolean;
  invertY: boolean;
  showStats: boolean;
  /** Ask to enter VR when a headset is detected. Desktop asks on launch. */
  askForVr: boolean;
  /** Skip the menu and go straight to the lobby. */
  autoLobby: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 1,
  fieldOfView: 70,
  viewDistance: 5,
  terrainStyle: "smooth",
  shadows: true,
  invertY: false,
  showStats: false,
  askForVr: true,
  autoLobby: false,
};

const KEY = "miblox.settings";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    // Merged over the defaults so a setting added later is not undefined.
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // Private windows and blocked storage both throw; defaults are fine.
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Not being able to remember a preference is not worth interrupting play.
  }
}
