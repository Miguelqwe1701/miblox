# @miblox/desktop

The desktop client: an Electron window around the same web client the browser
runs.

That is the point of building the engine in TypeScript. Desktop is a packaging
decision, not a second implementation — the renderer, the physics, the Luau VM
and the networking are all the same code. What the window adds is a real
fullscreen mode, no address bar, and WebXR for PC headsets without going
through a browser.

```bash
npm install            # fetches Electron (a large download)
npm start              # opens http://localhost:3000
MIBLOX_URL=https://your-server npm start
```

The renderer runs with `contextIsolation` on, `nodeIntegration` off and the
sandbox enabled. Content from the portal is web content and is not more
trusted here than it would be in a browser; the preload exposes only which
platform the client is on.
