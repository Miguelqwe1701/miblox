/**
 * Preload script.
 *
 * Deliberately almost empty: the client needs nothing from Node, so exposing
 * anything here would only widen what a place's code could reach. It tells the
 * page it is running in the desktop app, which is all the client asks for.
 */
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("miblox", {
  platform: "Desktop",
  isDesktopApp: true,
  version: process.versions.electron,
});
