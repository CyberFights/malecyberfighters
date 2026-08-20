// Male Cyber Fighters — Electron desktop app (thin client).
//
// Opens the live website in a native desktop window, so the app shares the
// exact same backend, accounts, chat and Discord bridge as the site. No
// server or credentials are bundled, so nothing about the app's behaviour
// changes — this is simply the website packaged as an installable app.
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

// The live site this app wraps. Change this if the domain ever moves.
const APP_URL = 'https://malecyberfighters-production.up.railway.app/';

let mainWindow = null;

function createWindow() {
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

  mainWindow.loadURL(APP_URL);

  // Keep the app in its own window: popups and any navigation away from the
  // app open in the user's default browser instead of the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_URL)) {
      event.preventDefault();
      if (url.startsWith('http://') || url.startsWith('https://')) {
        shell.openExternal(url);
      }
    }
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

  app.whenReady().then(createWindow);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
