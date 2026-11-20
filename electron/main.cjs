/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, dialog, shell, utilityProcess } = require("electron");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const API_KEY_NAMES = ["OPENAI_API_KEY", "GEMINI_API_KEY", "ATLASCLOUD_API_KEY", "FAL_KEY"];
let serverProcess = null;
let mainWindow = null;
let isQuitting = false;
let serverExitCode = null;
let serverUrl = null;

app.setName("fal flow");

function isMissingFile(error) {
  return error && typeof error === "object" && error.code === "ENOENT";
}

async function loadApiKeys(userDataPath) {
  let contents;
  try {
    contents = await require("node:fs/promises").readFile(path.join(userDataPath, "api-keys.json"), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error("The saved API key file is invalid JSON. Move or repair api-keys.json in fal flow's user data folder.", {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The saved API key file must contain an object.");
  }
  const keys = {};
  for (const name of API_KEY_NAMES) {
    if (parsed[name] === undefined) continue;
    if (typeof parsed[name] !== "string" || parsed[name].length > 4096) {
      throw new Error(`The saved ${name} value is invalid. Repair api-keys.json in fal flow's user data folder.`);
    }
    keys[name] = parsed[name];
  }
  return keys;
}

function reserveLocalPort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close();
        reject(new Error("Could not reserve a local app port."));
        return;
      }
      listener.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForServer(url) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    if (serverExitCode !== null) {
      throw new Error(`The fal flow server stopped during startup (exit code ${serverExitCode}).`);
    }
    try {
      const response = await fetch(`${url}/api/setup`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
      lastError = new Error(`The local app server returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`The fal flow server did not start in time.${lastError instanceof Error ? ` ${lastError.message}` : ""}`);
}

function openExternalUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") void shell.openExternal(parsed.toString());
  } catch {
    // Ignore malformed navigation targets.
  }
}

function isSameOrigin(targetUrl, origin) {
  try {
    return new URL(targetUrl).origin === origin;
  } catch {
    return false;
  }
}

function createMainWindow(url) {
  const origin = new URL(url).origin;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (!isSameOrigin(targetUrl, origin)) openExternalUrl(targetUrl);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (isSameOrigin(targetUrl, origin)) return;
    event.preventDefault();
    openExternalUrl(targetUrl);
  });
  mainWindow.once("ready-to-show", () => mainWindow && mainWindow.show());
  mainWindow.on("closed", () => { mainWindow = null; });
  void mainWindow.loadURL(url).catch((error) => {
    dialog.showErrorBox("fal flow could not open", error instanceof Error ? error.message : "The app page could not be loaded.");
  });
}

async function startDesktopApp() {
  const userDataPath = app.getPath("userData");
  const apiKeys = await loadApiKeys(userDataPath);
  const resourcesPath = process.resourcesPath;
  const standalonePath = path.join(resourcesPath, "standalone");
  const serverPath = path.join(standalonePath, "server.js");
  const ffmpegDirectory = path.join(resourcesPath, "ffmpeg", `${process.platform}-${process.arch}`);
  const executableExtension = process.platform === "win32" ? ".exe" : "";
  const ffmpegPath = path.join(ffmpegDirectory, `ffmpeg${executableExtension}`);
  const ffprobePath = path.join(ffmpegDirectory, `ffprobe${executableExtension}`);
  if (!fs.existsSync(serverPath) || !fs.existsSync(ffmpegPath) || !fs.existsSync(ffprobePath)) {
    throw new Error("The bundled FFmpeg tools are unavailable for this computer.");
  }
  const port = await reserveLocalPort();
  const environment = {
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || userDataPath,
    TMP: process.env.TMP || app.getPath("temp"),
    TEMP: process.env.TEMP || app.getPath("temp"),
    TMPDIR: process.env.TMPDIR || app.getPath("temp"),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    NODE_ENV: "production",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    FAL_FLOW_DESKTOP: "1",
    FAL_FLOW_USER_DATA_PATH: userDataPath,
    FFMPEG_PATH: ffmpegPath,
    FFPROBE_PATH: ffprobePath,
    NEXT_TELEMETRY_DISABLED: "1",
    ...apiKeys,
  };

  serverProcess = utilityProcess.fork(serverPath, [], {
    cwd: standalonePath,
    env: environment,
    serviceName: "fal flow local server",
    stdio: "pipe",
  });
  serverProcess.once("exit", (code) => {
    serverExitCode = code ?? 1;
    if (!isQuitting) {
      dialog.showErrorBox("fal flow stopped", `The local app server exited unexpectedly (code ${serverExitCode}).`);
      app.quit();
    }
  });
  serverProcess.stderr?.on("data", (chunk) => console.error(`[fal flow server] ${String(chunk).trimEnd()}`));
  serverProcess.stdout?.on("data", (chunk) => console.log(`[fal flow server] ${String(chunk).trimEnd()}`));

  serverUrl = `http://127.0.0.1:${port}`;
  await waitForServer(serverUrl);
  createMainWindow(serverUrl);
}

app.whenReady().then(startDesktopApp).catch((error) => {
  const message = error instanceof Error ? error.message : "fal flow could not start.";
  dialog.showErrorBox("fal flow could not start", message);
  app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  serverProcess?.kill();
});

app.on("activate", () => {
  if (mainWindow === null && serverUrl && serverProcess && serverExitCode === null) createMainWindow(serverUrl);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
