/**
 * MiBlox desktop client.
 *
 * A window around the same web client the browser runs, which is the whole
 * point of building the engine in TypeScript: desktop is a packaging decision
 * rather than a second implementation to keep in step.
 *
 * What it adds over a browser tab: a real fullscreen mode, no address bar,
 * and WebXR for PC headsets without a browser in the way.
 */
const { app, BrowserWindow, shell, Menu } = require("electron");
const path = require("node:path");

/** Where the portal is. Override with MIBLOX_URL to point at a real server. */
const PORTAL_URL = process.env.MIBLOX_URL ?? "http://localhost:3000";
const isDev = process.argv.includes("--dev");

let window = null;

function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#0b0e14",
    title: "MiBlox",
    // The renderer is ordinary web content from the portal and gets no Node
    // access: it is not more trusted here than it is in a browser.
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
    show: false,
  });

  window.once("ready-to-show", () => window.show());
  void window.loadURL(PORTAL_URL);

  // Links to anywhere else open in the user's own browser, not in the game.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(PORTAL_URL)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  window.on("closed", () => {
    window = null;
  });
}

function buildMenu() {
  const template = [
    {
      label: "MiBlox",
      submenu: [
        {
          label: "Reload",
          accelerator: "CmdOrCtrl+R",
          click: () => window?.webContents.reload(),
        },
        {
          label: "Toggle Fullscreen",
          accelerator: "F11",
          click: () => window?.setFullScreen(!window.isFullScreen()),
        },
        ...(isDev
          ? [
              {
                label: "Developer Tools",
                accelerator: "CmdOrCtrl+Shift+I",
                click: () => window?.webContents.toggleDevTools(),
              },
            ]
          : []),
        { type: "separator" },
        { role: "quit" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // macOS keeps the app running with no windows; everywhere else quits.
  if (process.platform !== "darwin") app.quit();
});
