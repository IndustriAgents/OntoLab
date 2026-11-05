import { app, BrowserWindow, dialog, Menu, session, shell, utilityProcess, type UtilityProcess } from "electron";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const bridgeMode = process.argv.includes("--mcp-stdio");
if (bridgeMode) {
  void import("node:url")
    .then(async ({ pathToFileURL }) => {
      const { startBridge } = await import(pathToFileURL(join(__dirname, "mcp.mjs")).href);
      const index = process.argv.indexOf("--connection");
      if (index < 0 || !process.argv[index + 1]) throw new Error("A connection credential path is required.");
      app.dock?.hide();
      const server = await startBridge(process.argv[index + 1]);
      server.onclose = () => app.exit(0);
    })
    .catch((error: Error) => {
      process.stderr.write(`${error.message}\n`);
      app.exit(1);
    });
}

if (!bridgeMode) {
  app.setName("OntoLab");
  // Development gets its own workspace; packaged applications use OntoLab's profile.
  const profilePath =
    process.env.ONTOLAB_DESKTOP_PROFILE || join(app.getPath("appData"), app.isPackaged ? "OntoLab" : "OntoLab Development");
  if (!isAbsolute(profilePath)) throw new Error("The desktop profile must be an absolute path.");
  mkdirSync(profilePath, { recursive: true, mode: 0o700 });
  app.setPath("userData", profilePath);
}

let backend: UtilityProcess | undefined;
let origin = "";
let mainWindow: BrowserWindow | undefined;
let quitting = false;
let shutdownStarted = false;
const desktopSession = "ontolab-desktop";

function openExternal(url: string): void {
  try {
    if (["https:", "http:"].includes(new URL(url).protocol)) void shell.openExternal(url);
  } catch {
    // Malformed links never reach the operating system's protocol handlers.
  }
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    title: "OntoLab",
    icon: join(__dirname, "icon.png"),
    width: 1360,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    backgroundColor: "#f7f8fa",
    webPreferences: {
      partition: desktopSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow = win;
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = undefined;
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== origin) {
      event.preventDefault();
      openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin === origin) void win.loadURL(url);
    else openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  await win.loadURL(origin);
}

async function startBackend(): Promise<void> {
  const profile = app.getPath("userData");
  if (!isAbsolute(profile)) throw new Error("The desktop profile must be an absolute path.");
  await mkdir(profile, { recursive: true });
  const log = createWriteStream(join(profile, "desktop.log"), { flags: "a", mode: 0o600 });
  const secret = randomBytes(32).toString("hex");
  const child = utilityProcess.fork(join(__dirname, "server.mjs"), [], {
    cwd: profile,
    env: {
      ...process.env,
      ONTOLAB_DESKTOP_EXECUTABLE: process.execPath,
      ONTOLAB_DESKTOP_APP_PATH: app.isPackaged ? "" : app.getAppPath(),
      ONTOLAB_DESKTOP_DATA_DIR: join(profile, "workspace"),
      ONTOLAB_DESKTOP_SECRET: secret,
      ONTOLAB_DESKTOP_RESOURCES: __dirname,
      NODE_ENV: "production",
    },
    stdio: "pipe",
    serviceName: "OntoLab local backend",
  });
  backend = child;
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  const ready = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("The local backend did not start within 30 seconds. See desktop.log in the app profile.")),
      30_000,
    );
    const onMessage = (message: { type?: string; port?: number }) => {
      if (message?.type !== "ready" || !Number.isInteger(message.port) || message.port! < 1 || message.port! > 65535) return;
      clearTimeout(timer);
      child.off("message", onMessage);
      resolve(`http://127.0.0.1:${message.port}`);
    };
    child.on("message", onMessage);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The local backend exited during startup (code ${code}). See desktop.log in the app profile.`));
    });
  });
  child.on("message", (message: { type?: string; destination?: string }) => {
    if (message.type !== "open" || !message.destination || !/^\/p\/[A-Za-z0-9_-]+\//.test(message.destination) || !origin) return;
    const target = new URL(message.destination, origin);
    if (target.origin !== origin) return;
    if (mainWindow) {
      const win = mainWindow;
      // Let the application save pending edits and navigate through its router.
      void win.webContents
        .executeJavaScript(
          `!window.dispatchEvent(new CustomEvent("ontolab-open", { detail: ${JSON.stringify(message.destination)}, cancelable: true }))`,
        )
        .then((handled: boolean) => {
          if (!handled && !win.isDestroyed()) return win.loadURL(target.href);
        })
        .catch(() => {
          if (!win.isDestroyed()) void win.loadURL(target.href);
        });
      mainWindow.show();
      mainWindow.focus();
    } else {
      void createWindow().then(() => mainWindow?.loadURL(target.href));
    }
  });
  child.once("exit", (code) => {
    backend = undefined;
    log.end();
    if (!shutdownStarted && origin) {
      dialog.showErrorBox(
        "OntoLab backend stopped",
        `The local backend exited (code ${code}). Restart OntoLab to continue. Your saved projects remain on disk.`,
      );
      app.quit();
    }
  });
  origin = await ready;
  const ses = session.fromPartition(desktopSession);
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  await ses.cookies.set({
    url: origin,
    name: `ontolab-desktop-${new URL(origin).port}`,
    value: secret,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
  });
}

if (bridgeMode) {
  // A bridge is an independent protocol process; it never owns the workspace.
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.show();
    mainWindow?.focus();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (!mainWindow && origin && !shutdownStarted)
      void createWindow().catch((error: Error) => dialog.showErrorBox("Could not open OntoLab", error.message));
  });
  app.on("before-quit", (event) => {
    if (quitting || !backend) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    const child = backend;
    const timer = setTimeout(() => child.kill(), 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      quitting = true;
      app.quit();
    });
    child.postMessage({ type: "shutdown" });
  });
  void app
    .whenReady()
    .then(async () => {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
          {
            label: "File",
            submenu: [
              {
                label: "Open local data folder",
                click: () => {
                  void shell.openPath(app.getPath("userData"));
                },
              },
              { type: "separator" },
              { role: process.platform === "darwin" ? "close" : "quit" },
            ],
          },
          { role: "editMenu" },
          { role: "viewMenu" },
          { role: "windowMenu" },
          {
            role: "help",
            submenu: [
              {
                label: "OntoLab documentation",
                click: () => {
                  if (!mainWindow || !origin) return;
                  const current = new URL(mainWindow.webContents.getURL());
                  const returnQuery =
                    current.origin === origin && !current.pathname.startsWith("/docs")
                      ? `?${new URLSearchParams({ returnTo: current.pathname + current.search + current.hash })}`
                      : "";
                  void mainWindow.loadURL(`${origin}/docs/${returnQuery}`);
                },
              },
            ],
          },
        ]),
      );
      await startBackend();
      await createWindow();
    })
    .catch((error: Error) => {
      dialog.showErrorBox("Could not start OntoLab", error.message);
      app.quit();
    });
}
