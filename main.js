const { app, BrowserWindow, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const DesktopServer = require('./src/server');

let mainWindow = null;
let tray = null;
let serverInstance = null; // the DesktopServer (has .engine)
let httpServer = null;      // the underlying http.Server
const SERVER_PORT = 4587;

function createServer() {
  const srv = new DesktopServer(SERVER_PORT);
  httpServer = srv.start();
  serverInstance = srv;
  return srv;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'SheetsToOBS - Desktop Control Center',
    backgroundColor: '#0c0f17',
    icon: path.join(__dirname, 'src', 'public', 'SheetsToOBS_Logo.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    },
    autoHideMenuBar: true
  });

  mainWindow.loadURL(`http://localhost:${SERVER_PORT}`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', () => {
    app.isQuitting = true;
    if (tray) {
      tray.destroy();
      tray = null;
    }
    if (serverInstance && serverInstance.engine) {
      serverInstance.engine.stop();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });
}

function createTray() {
  // Simple tray menu
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open SheetsToOBS',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: 'Force Sync Now',
      click: () => {
        if (serverInstance && serverInstance.engine) {
          serverInstance.engine.updateCycle().catch(() => {});
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  try {
    const iconPath = path.join(__dirname, 'src', 'public', 'SheetsToOBS_Logo.png');
    tray = new Tray(iconPath);
    tray.setToolTip('SheetsToOBS - Real-Time Google Sheet Importer');
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (e) {
    // If icon file missing or tray unsupported, continue gracefully
  }
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createServer();
    createWindow();
    createTray();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    if (tray) {
      tray.destroy();
      tray = null;
    }
    if (serverInstance && serverInstance.engine) {
      serverInstance.engine.stop();
    }
  });

  app.on('window-all-closed', () => {
    if (tray) {
      tray.destroy();
      tray = null;
    }
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

