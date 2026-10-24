require('./env');
const updater = require('./updater');
const path = require('path');
const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const sb = require('./supabase');
const { registerHandlers } = require('./ipc-handlers');

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 900,
        minHeight: 600,
        show: false,
        backgroundColor: '#0e0e0e',
        frame: false,
        icon: path.join(__dirname, '..', '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    // show: false + maximize-before-show avoids a visible flash at the
    // smaller 1280x820 size before jumping to maximized.
    mainWindow.once('ready-to-show', () => {
        mainWindow.maximize();
        mainWindow.show();
    });

    // Frameless windows on Windows can occasionally repaint blank after being
    // minimized and restored (a known Chromium/GPU-compositing quirk). A
    // 1px resize nudge forces a real repaint — getSize/setSize are standard
    // Electron APIs, so this doesn't depend on anything undocumented.
    mainWindow.on('restore', () => {
        const [width, height] = mainWindow.getSize();
        mainWindow.setSize(width, height + 1);
        mainWindow.setSize(width, height);
    });

    // Menu.setApplicationMenu(null) also removes the menu's "Toggle DevTools"
    // shortcut, so wire it back up manually.
    mainWindow.webContents.on('before-input-event', (event, input) => {
        const isToggle = input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i');
        if (isToggle) mainWindow.webContents.toggleDevTools();
    });

    // Uncomment while developing:
    // mainWindow.webContents.openDevTools();
}

// Custom titlebar controls (frame: false removes native min/max/close)
function registerWindowControls() {
    ipcMain.handle('window:minimize', () => mainWindow?.minimize());
    ipcMain.handle('window:maximize', () => {
        if (!mainWindow) return;
        mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    });
    ipcMain.handle('window:close', () => mainWindow?.close());
    ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false);

    // Trailers link to YouTube, "via JustWatch" links to TMDB's watch page —
    // only allow https URLs on those two known domains through to the OS
    // browser, never anything else the renderer might pass in.
    ipcMain.handle('shell:openExternal', (_evt, { url }) => {
        try {
            const parsed = new URL(url);
            const allowedHosts = /(^|\.)(youtube\.com|themoviedb\.org)$/;
            if (parsed.protocol === 'https:' && allowedHosts.test(parsed.hostname)) {
                shell.openExternal(url);
            }
        } catch {
            // ignore malformed URLs
        }
    });
}

app.whenReady().then(() => {
    Menu.setApplicationMenu(null); // no File/Edit/View/Window/Help bar
    sb.init();
    registerHandlers();
    registerWindowControls();
    createWindow();
    updater.init(() => mainWindow);
    
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
