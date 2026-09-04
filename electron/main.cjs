// SparkX desktop shell.
//
// Electron owns the window; the API server runs as a child process (see the
// comment at the top of server/index.ts for why). This file starts the server,
// waits for it to answer, then points a window at it — and makes sure the
// server dies with the window.

const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = process.env.PORT || 5178;
const URL = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');

let server = null;

function startServer() {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  server = spawn(npx, ['tsx', 'server/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  server.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[spark] server exited with code ${code}`);
    }
  });
}

async function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${URL}/api/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    backgroundColor: '#0d1214',
    title: 'SparkX',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // External links open in the real browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const ready = await waitForServer();
  if (!ready) {
    await win.loadURL(
      'data:text/html,' +
      encodeURIComponent(`
        <body style="font:15px system-ui;padding:40px;background:#0d1214;color:#e5ecec">
          <h2>The SparkX server did not start.</h2>
          <p>Run <code>npm run start</code> in a terminal and read the error it prints.</p>
          <p>The most common cause is that dependencies are not installed yet — try <code>npm install</code>.</p>
        </body>`),
    );
    return;
  }
  await win.loadURL(URL);
}

app.whenReady().then(() => {
  startServer();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function stopServer() {
  if (server && !server.killed) server.kill();
  server = null;
}

app.on('window-all-closed', () => {
  stopServer();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', stopServer);
process.on('exit', stopServer);
