# Turning I've Already into an installable app (Windows)

## One-time setup
1. Copy into your project folder (overwrite when asked):
   - `package.json`  (compare with yours first; keep any extra dependencies you added)
   - `src/main/env.js`, `src/main/updater.js`  (new files)
   - `.github/workflows/release.yml`  (optional, see "Automatic builds")
2. Edit `src/main/main.js`:
   - Replace the first line `require('dotenv').config();` with `require('./env');`
   - Add near the other requires: `const updater = require('./updater');`
   - Inside `app.whenReady().then(() => { ... })`, after `createWindow();` add: `updater.init(() => mainWindow);`
3. In `package.json` change `YOUR_GITHUB_USERNAME` (publish section) to your GitHub username.
4. Create an empty GitHub repository named `ive-already` (it can be private only if you also give users a token, so make it **public**; keep your `.env` out of it — add `.env` to `.gitignore`).
5. In the project folder run: `npm install`

## Make the installer
`npm run dist`  →  `dist/I've Already Setup 0.1.0.exe`. Double-click it to install; send the same file to friends.

## Ship an update to everyone
1. Raise `"version"` in package.json (e.g. 0.1.0 → 0.1.1).
2. Create a GitHub token (Settings → Developer settings → Personal access tokens, scope: `repo`), then in PowerShell:
   `$env:GH_TOKEN="your_token"; npm run release`
3. That uploads the installer to a GitHub Release. Installed apps check on start (and every 4 hours), download it in the background and ask to restart.

## Automatic builds (optional)
Add the keys from your `.env` as repository secrets (TMDB_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, RAWG_API_KEY, OMDB_API_KEY), bump the version, then `git tag v0.1.1 && git push --tags` — GitHub builds and publishes it.

## Good to know
- The keys in `.env` are bundled inside the installer, so anyone can extract them. Fine for free TMDB/RAWG keys and the Supabase anon key (your RLS rules protect the data), but don't put private keys in it. Because of that, don't ship `STEAM_API_KEY`: the Steam import will stay off for other users unless they add their own.
- Windows will show "Windows protected your PC" for an unsigned installer (More info → Run anyway). A code-signing certificate removes it; auto-update works without one.
- New database features still need their SQL run in Supabase before you publish an app version that uses them.
