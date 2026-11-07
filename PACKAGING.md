# Turning I've Already into an installable app (Windows)

Packaging is already set up: `package.json` has the electron-builder config, `src/main/env.js` loads the bundled `.env`, and `src/main/updater.js` handles auto-updates from GitHub Releases (`lucasboschiroli/Ive-Already`, see the `publish` section of `package.json`).

## First time on a machine
1. `npm install`
2. Copy `.env.example` to `.env` and fill in the keys (see the README).

## Make the installer
`npm run dist`  →  `dist/I've Already Setup <version>.exe`. Double-click it to install; send the same file to friends.

## Ship an update to everyone
1. Raise `"version"` in package.json (e.g. 0.1.0 → 0.1.1).
2. Create a GitHub token (Settings → Developer settings → Personal access tokens, scope: `repo`), then in PowerShell:
   `$env:GH_TOKEN="your_token"; npm run release`
3. That uploads the installer to a GitHub Release. Installed apps check on start (and every 4 hours), download it in the background and ask to restart.

## Automatic builds (optional)
`.github/workflows/release.yml` builds and publishes on every `v*` tag. Add the keys from your `.env` as repository secrets (TMDB_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, RAWG_API_KEY, OMDB_API_KEY), bump the version, then `git tag v0.1.1 && git push --tags`.

## Good to know
- The keys in `.env` are bundled inside the installer, so anyone can extract them. Fine for free TMDB/RAWG keys and the Supabase anon key (your RLS rules protect the data), but don't put private keys in it. Because of that, don't ship `STEAM_API_KEY`: the Steam import will stay off for other users unless they add their own.
- Windows will show "Windows protected your PC" for an unsigned installer (More info → Run anyway). A code-signing certificate removes it; auto-update works without one.
- New database features still need their migration run in Supabase before you publish an app version that uses them (see "Database" in the README).
