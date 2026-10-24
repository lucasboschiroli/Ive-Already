# I've Already

Track everything you've already watched, read and played — movies, TV, books and videogames in one place, synced through your own Supabase project.

Data sources: **TMDB** (films, series, people, studios), **OMDb** (IMDb / Rotten Tomatoes scores), **Open Library** (books, authors), **RAWG** (videogames), **Wikidata** (author countries, company logos), **Steam Web API** (optional library import).

## Setup (development)

```bash
npm install
cp .env.example .env      # then fill in the keys below
npm start
```

`.env` keys:

| Key | Needed | Where to get it |
| --- | --- | --- |
| `TMDB_API_KEY` | yes | themoviedb.org/settings/api |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | yes | Supabase → Project Settings → API |
| `RAWG_API_KEY` | for games | rawg.io/apidocs |
| `OMDB_API_KEY` | optional | omdbapi.com (IMDb / Rotten Tomatoes numbers) |
| `STEAM_API_KEY` | optional | steamcommunity.com/dev/apikey (Steam import; your Steam profile must be public) |

### Database

All data lives in Supabase (Postgres + row-level security). Run the `*.sql` files in the project root in the Supabase SQL editor — the base schema in `supabase/` first, then each `*-migration.sql` (lists, social, diary logs, favorites, publishers/studios, official lists, game achievements, `delete-account-migration.sql`, …). Run any new migration **before** using the feature that needs it.

## Features

**Library**
- Four media types: movies, TV series, books, videogames. Status (planned / in progress / completed / rewatched / dropped), 0–10 rating, review (with spoiler flag), start/finish/rewatch dates, favorites.
- Home / Watch / Read / Play pages with Continue rows (episode progress, reading progress, game achievement progress), Up Next queue, and a library search bar.
- Diary: every watch/read/play logged with dates and rewatches; per-episode logging for series.
- Roulette to pick what to watch next.

**Discovery & details**
- Search across films, series, books and games; detail pages with cast, crew, trailers, where to watch, season/episode tracking, IMDb / Rotten Tomatoes scores.
- Profile-style pages for people (directors, cast, authors), studios, publishers and developers — tabs per media type, banner from their latest work, follow for release notifications.
- Game achievements (Steam-style titles) with unlock tracking and progress bars.

**Lists**
- Custom lists (ranked or not, private / shared / public), likes, comments, family sharing.
- Official lists (Oscars, Penguin Classics, game lists, …) with a "Match titles" step that links them to real titles, shown as progress rings in Stats.

**Stats**
- Totals and hours, genres, decades, countries (world map for films, series and books), top people/studios, collections (film franchises, book series, game series), official-list progress.

**Social**
- Follow people, activity feed, family accounts, notification bell (new releases, upcoming, activity — configurable).

**Import**
- Letterboxd data export (ZIP) or a single list `.csv`: watched films, ratings, diary dates, reviews, likes, watchlist and lists.
- Steam library (owned games and playtime) via the Steam Web API.
- Entry points: the **Import** button on a list (lists only) and **Account → Connected Accounts** (full import).

**Account**
- Email/password change, family management, sign out of other devices, notification preferences, data export (JSON), clear local cache, delete account.

## Architecture

```
src/
  main/             Electron main process — all network and database access
    main.js         window, app lifecycle
    env.js          loads .env (project folder in dev, app resources when installed)
    updater.js      auto-update from GitHub Releases (installed app only)
    supabase.js     database layer (Supabase client, RLS-protected queries)
    ipc-handlers.js the only bridge between renderer requests and services
    tmdb.js  books.js  rawg.js  omdb.js  studios.js  publishers.js
    tmdb-collections.js  book-series.js  author-countries.js  notifications.js
    importers.js    Letterboxd ZIP/CSV parser + Steam importer
  preload/
    preload.js      contextBridge — the renderer can only call what is exposed as window.api
  renderer/         the UI (vanilla JS, no Node access)
    index.html  renderer.js  styles/app.css  assets/logos/
build/              app icons
```

Flow: renderer → `window.api.xxx()` → IPC → main process → Supabase / external APIs. The renderer never touches the network or database directly (`contextIsolation: true`, `nodeIntegration: false`, sandboxed).

### Data model (short version)

- `media` — one cached row per title, keyed by `(tmdb_id, media_type)` where `media_type` is `movie`, `tv`, `book` or `game` (books use the Open Library work number, games the RAWG id).
- `entries` — a user's relationship to a title (status, rating, review, dates, favorite, queue). Never overwritten by re-fetching metadata.
- `entry_logs` — diary rows (watch dates, rewatches, per-episode logs).
- `episodes`, `watched_episodes` — episode tracking, fetched per season on demand.
- `lists`, `list_items`, list likes/comments/shares; `official_lists`, `official_list_items` for curated lists.
- `game_achievements` — unlocked achievements per user.
- Social tables for follows, family accounts and activity.

## Packaging & updates (Windows)

See `PACKAGING.md`. In short:

```bash
npm run dist        # builds dist/I've Already Setup x.y.z.exe
npm run release     # builds and publishes to GitHub Releases (needs GH_TOKEN)
```

Installed apps check GitHub Releases on start and every 4 hours, download new versions in the background and offer a restart. Bump `version` in `package.json` for every release.

- The `.env` keys are bundled into the installer, so they can be extracted by anyone. Fine for TMDB / RAWG / OMDb and the Supabase **anon** key (RLS protects the data) — never bundle private keys. Leave `STEAM_API_KEY` out of public builds.
- Unsigned installers trigger Windows SmartScreen ("More info → Run anyway"); auto-update still works.

## Notes

- TMDB attribution is required by their terms — the footer credit in `index.html` must stay.
- Not available: PlayStation / Xbox / GOG account connections (no usable public APIs), two-factor authentication.
- The legacy local-SQLite layer (`db.js`, `schema.sql`) is no longer used and is excluded from builds.