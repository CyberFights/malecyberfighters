// Male Cyber Fighters — Electron desktop wrapper.
// This file turns the existing Node.js web app (index.js) into a native
// desktop application. It boots the exact same Express + Socket.IO server
// in-process, then opens a desktop window pointed at it. Nothing about the
// web app's behaviour is changed — the same routes, Socket.IO events,
// MongoDB connection and static files are used as-is.
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const net = require('net');

let mainWindow = null;

// Ask the OS for a free port so the bundled server never clashes with an
// existing process (or another copy of the app that is already running).
function getFreePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', () => resolve(0));
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

// Poll the port until the Express server accepts connections.
function waitForServer(port) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 20000;
    (function tryConnect() {
      const sock = net.connect({ port, host: '127.0.0.1' });
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) {
          reject(new Error('The bundled server did not start in time.'));
          return;
        }
        setTimeout(tryConnect, 150);
      });
    })();
  });
}

async function createWindow() {
  const port = await getFreePort();

  // Hand the chosen port to the server before it is required, because
  // index.js reads process.env.PORT at module-load time.
  process.env.PORT = String(port);
  process.env.HOST = '127.0.0.1';

  // Boot the production server (identical code to `npm start`).
  require(path.join(__dirname, '..', 'index.js'));

  await waitForServer(port);

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 920,
    minWidth: 960,
    minHeight: 620,
    title: 'Male Cyber Fighters',
    backgroundColor: '#020617',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'public', 'images', 'mcf.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  // Keep the app in its own window: external links (e.g. Discord) open in the
  // user's default browser instead of navigating the app window away.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Only allow a single running copy of the desktop app.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(createWindow).catch((err) => {
    console.error('Failed to start Male Cyber Fighters:', err);
    app.quit();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
