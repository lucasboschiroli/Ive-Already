// Auto-updates from GitHub Releases (only when running as an installed app).
const { app, dialog } = require('electron');

function init(getWindow) {
    if (!app.isPackaged) return;
    let autoUpdater;
    try { ({ autoUpdater } = require('electron-updater')); } catch (err) { console.error('updater unavailable:', err.message); return; }
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('error', (err) => console.error('update error:', err == null ? 'unknown' : err.message));
    autoUpdater.on('update-downloaded', async (info) => {
        const { response } = await dialog.showMessageBox(getWindow() || undefined, {
            type: 'info',
            buttons: ['Restart now', 'Later'],
            defaultId: 0,
            title: 'Update ready',
            message: `I've Already ${info.version} has been downloaded.`,
            detail: 'Restart to finish updating. It will also install the next time you close the app.',
        });
        if (response === 0) autoUpdater.quitAndInstall();
    });
    const check = () => autoUpdater.checkForUpdates().catch((e) => console.error('update check:', e.message));
    check();
    setInterval(check, 4 * 60 * 60 * 1000);
}
module.exports = { init };
