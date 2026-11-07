require('./env');
const updater = require('./updater');
const path = require('path');
const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require('electron');
const sb = require('./supabase');
const { registerHandlers } = require('./ipc-handlers');

let mainWindow;

// ---- ivealready://list/<token> share links ----
// Windows starts a new process for a clicked link, with the URL in argv. The
// single-instance lock below hands it to the window that's already open; on a
// cold start it's read from this process's own argv. Either way the token
// waits in pendingListToken until the renderer asks for it (it may still be
// on the sign-in screen).
const PROTOCOL = 'ivealready';
let pendingListToken = null;
function listTokenFromArgs(args) {
    for (const a of args || []) {
        const m = /^ivealready:\/\/list\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(String(a));
        if (m) return m[1];
    }
    return null;
}
function deliverListToken(token) {
    if (!token) return;
    pendingListToken = token;
    if (mainWindow) mainWindow.webContents.send('deeplink:list');
}

const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
    app.quit(); // the open window gets the link via 'second-instance'
} else {
    app.on('second-instance', (_evt, argv) => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
        deliverListToken(listTokenFromArgs(argv));
    });
    pendingListToken = listTokenFromArgs(process.argv);
}

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

    // Hands over (and forgets) a share-link token waiting from a clicked link.
    ipcMain.handle('deeplink:takeList', () => {
        const token = pendingListToken;
        pendingListToken = null;
        return token;
    });

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
    if (!isPrimaryInstance) return;
    // Registers ivealready:// for this Windows user on each start (the NSIS
    // installer doesn't — electron-builder's "protocols" only covers macOS/Appx).
    // Installed app only: a dev run shouldn't point links at node_modules/electron.
    if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);
    Menu.setApplicationMenu(null); // no File/Edit/View/Window/Help bar
    try {
        sb.init();
    } catch (err) {
        // A build whose bundled .env is missing keys used to start with no window
        // at all. Say so instead — and keep the updater running while the message
        // is up, so a fixed release can still download and install itself.
        updater.init(() => null);
        dialog.showMessageBox({
            type: 'error',
            title: "I've Already can't start",
            message: "I've Already can't start because its setup is incomplete.",
            detail: `${err.message}\n\nIf a fixed version is available it will download in the background and offer to restart — leave this open for a minute. Otherwise reinstall the latest version from GitHub.`,
            buttons: ['Close'],
        }).then(() => app.quit());
        return;
    }
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
