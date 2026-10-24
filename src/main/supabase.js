// Supabase client for the main process. Auth + all personal data (entries,
// watched episodes, lists) now live in Supabase/Postgres instead of local
// SQLite, so the same account sees the same data on any device.
//
// media/episodes stay a SHARED cache (see supabase/schema.sql) — any
// authenticated account can read/write them, since TMDB data isn't personal.
//
// Session persistence: supabase-js normally persists sessions to
// localStorage, which doesn't exist in the main process. This provides a
// simple file-based storage adapter instead, so logging in once keeps you
// logged in across app restarts (same idea as a browser remembering you).

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { app } = require('electron');

// supabase-js always spins up a realtime client internally (even though this
// app never subscribes to anything), and it expects a global `WebSocket`
// constructor the way a browser or Node 22+ would provide natively.
// Electron's main process doesn't have one, so without this it throws
// immediately on createClient(). The `ws` package is a drop-in polyfill.
if (typeof global.WebSocket === 'undefined') {
    global.WebSocket = require('ws');
}

function getSessionFilePath() {
    return path.join(app.getPath('userData'), 'supabase-session.json');
}

// Minimal storage adapter matching the subset of the Storage interface
// supabase-js actually calls (getItem/setItem/removeItem).
const fileStorage = {
    getItem: (key) => {
        try {
            const data = JSON.parse(fs.readFileSync(getSessionFilePath(), 'utf-8'));
            return data[key] ?? null;
        } catch {
            return null;
        }
    },
    setItem: (key, value) => {
        let data = {};
        try { data = JSON.parse(fs.readFileSync(getSessionFilePath(), 'utf-8')); } catch { /* first write */ }
        data[key] = value;
        fs.writeFileSync(getSessionFilePath(), JSON.stringify(data));
    },
    removeItem: (key) => {
        try {
            const data = JSON.parse(fs.readFileSync(getSessionFilePath(), 'utf-8'));
            delete data[key];
            fs.writeFileSync(getSessionFilePath(), JSON.stringify(data));
        } catch { /* nothing to remove */ }
    },
};

let supabase;

function init() {
    const url = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!url || !anonKey) {
        throw new Error(
            'SUPABASE_URL / SUPABASE_ANON_KEY are not set. Add them to .env — see .env.example.'
        );
    }
    supabase = createClient(url, anonKey, {
        auth: {
            storage: fileStorage,
            autoRefreshToken: true,
            persistSession: true,
            detectSessionInUrl: false, // no browser URL in Electron's main process
        },
    });
    // Refresh tokens rotate on use — every time the SDK auto-refreshes the
    // active session in the background, the OLD stored refresh token stops
    // working. Without this, switching away from an account and back later
    // would silently fail once its original token had been rotated out from
    // under it.
    supabase.auth.onAuthStateChange((event, session) => {
        if ((event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') && session) {
            registerFamilyAccount(session).catch((err) => console.error('Failed to update family registry:', err));
        }
    });
    return supabase;
}

function getClient() {
    if (!supabase) throw new Error('Supabase client not initialized — call init() first');
    return supabase;
}

// ---- auth ----

async function signUp(email, password) {
    const { data, error } = await getClient().auth.signUp({ email, password });
    if (error) throw error;
    return data;
}

async function signIn(email, password) {
    const { data, error } = await getClient().auth.signInWithPassword({ email, password });
    if (error) throw error;
    await registerFamilyAccount(data.session);
    return data;
}

async function signOut() {
    // Grab who is signed in BEFORE signing out — afterwards there is no
    // session left to read, which used to leave this account's (now revoked)
    // tokens in the switcher registry and made switching back fail with
    // "Invalid Refresh Token".
    const { data: current } = await getClient().auth.getSession();
    const id = current?.session?.user?.id;
    // Local scope: logs out this device only, so it can't revoke the tokens
    // that other accounts/devices rely on.
    const { error } = await getClient().auth.signOut({ scope: 'local' });
    // An explicit "Log Out" forgets this profile on this device entirely —
    // "Switch Profile" (below) is the lighter action that keeps it around.
    removeFamilyAccount(id);
    if (error) throw error;
}

async function getSession() {
    const { data, error } = await getClient().auth.getSession();
    if (error) throw error;
    // Self-healing for anyone who was already logged in before this feature
    // existed — their account wouldn't have been registered by a fresh
    // SIGNED_IN event, so without this their own registry could come back
    // empty despite them actively being signed in. Idempotent either way.
    if (data.session) await registerFamilyAccount(data.session);
    return data.session;
}

// Supabase sends a confirmation link to the NEW address before the change
// actually takes effect (and, depending on project settings, one to the old
// address too) — the account's email doesn't switch over immediately.
async function updateEmail(newEmail) {
    const { data, error } = await getClient().auth.updateUser({ email: newEmail });
    if (error) throw error;
    return data;
}

// Takes effect immediately — no re-entry of the current password required,
// since this only runs with an active, already-authenticated session.
async function updatePassword(newPassword) {
    const { data, error } = await getClient().auth.updateUser({ password: newPassword });
    if (error) throw error;
    return data;
}

// ---- family accounts (separate real accounts, fast local switching) ----
//
// Genuinely different Supabase accounts, not lightweight profiles sharing
// one login. Only one can be the ACTIVE session on the Supabase client at a
// time (that's what every RLS policy in this file checks against), so
// switching means swapping which account's tokens are loaded — not running
// multiple sessions at once. This registry is what makes that fast:
// whenever an account signs in (or its token refreshes), its latest tokens
// get saved here on top of the normal single-session file, so switching
// back to it later doesn't require a password again unless its refresh
// token has actually gone stale.
//
// This is local-only, per device — nothing here is synced to Supabase.
// Removing an account from this registry just forgets it on this device;
// it never touches the actual account or its data.

function getFamilyFilePath() {
    return path.join(app.getPath('userData'), 'family-accounts.json');
}

function readFamilyRegistry() {
    try {
        return JSON.parse(fs.readFileSync(getFamilyFilePath(), 'utf-8'));
    } catch {
        return { accounts: [], activeId: null };
    }
}

function writeFamilyRegistry(registry) {
    fs.writeFileSync(getFamilyFilePath(), JSON.stringify(registry));
}

async function registerFamilyAccount(session) {
    if (!session?.user?.id) return;
    const registry = readFamilyRegistry();
    const existing = registry.accounts.find((a) => a.id === session.user.id);
    const entry = {
        id: session.user.id,
        email: session.user.email,
        label: existing?.label || null, // a nicer name than the raw email, set via renameFamilyAccount
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
    };
    registry.accounts = [...registry.accounts.filter((a) => a.id !== session.user.id), entry];
    registry.activeId = session.user.id;
    writeFamilyRegistry(registry);
}

function removeFamilyAccount(id) {
    if (!id) return;
    const registry = readFamilyRegistry();
    registry.accounts = registry.accounts.filter((a) => a.id !== id);
    if (registry.activeId === id) registry.activeId = null;
    writeFamilyRegistry(registry);
}

function renameFamilyAccount(id, label) {
    const registry = readFamilyRegistry();
    const entry = registry.accounts.find((a) => a.id === id);
    if (entry) entry.label = label;
    writeFamilyRegistry(registry);
}

// Never returns tokens to the renderer — those stay in main-process-only
// storage. Just enough to draw the picker.
function listFamilyAccounts() {
    const registry = readFamilyRegistry();
    return registry.accounts.map((a) => ({ id: a.id, email: a.email, label: a.label }));
}

// Swaps the active session on the one Supabase client to a different
// registered account. If that account's stored refresh token has gone
// stale (revoked, expired, or it was never fully registered), this throws
// and the caller falls back to asking that profile to sign in again —
// same as Netflix asking for a PIN when a profile's session lapses.
async function switchFamilyAccount(id) {
    const registry = readFamilyRegistry();
    const entry = registry.accounts.find((a) => a.id === id);
    if (!entry) throw new Error('That profile is not registered on this device');
    // Save the account we're leaving first, with its freshest tokens, so
    // switching back later doesn't use a refresh token that has since rotated.
    try {
        const { data: cur } = await getClient().auth.getSession();
        if (cur?.session && cur.session.user.id !== id) await registerFamilyAccount(cur.session);
    } catch { /* best effort */ }
    const fresh = readFamilyRegistry();
    const target = fresh.accounts.find((a) => a.id === id) || entry;
    const { data, error } = await getClient().auth.setSession({
        access_token: target.accessToken,
        refresh_token: target.refreshToken,
    });
    if (error) {
        // The saved login for this profile is no longer valid (revoked / signed in elsewhere): forget it so the
        // picker asks for the password again instead of failing every time.
        if (error.code === 'refresh_token_not_found' || /refresh token/i.test(error.message || '')) {
            removeFamilyAccount(id);
            throw new Error('This profile needs to sign in again');
        }
        throw error;
    }
    // setSession may have rotated the tokens — store the new ones.
    if (data.session) await registerFamilyAccount(data.session);
    const after = readFamilyRegistry();
    after.activeId = id;
    writeFamilyRegistry(after);
    return data.session;
}

function requireUserId(session) {
    if (!session?.user?.id) throw new Error('Not signed in');
    return session.user.id;
}

// ---- media (shared cache) ----

async function upsertMedia(media) {
    // `media` (from tmdb.js) carries extra fields for the UI — cast, creators,
    // writers, networks, studios, watch_providers, seasons — that are never
    // meant to be persisted. The old SQLite version's named-parameter SQL
    // silently ignored those; Supabase's upsert() writes every key it's
    // given as a real column, so it has to be whitelisted explicitly here.
    const row = {
        tmdb_id: media.tmdb_id,
        media_type: media.media_type,
        title: media.title,
        original_title: media.original_title,
        poster_path: media.poster_path,
        backdrop_path: media.backdrop_path,
        release_date: media.release_date,
        overview: media.overview,
        runtime: media.runtime,
        number_of_seasons: media.number_of_seasons,
        // Cached column feeds the Continue Watching progress bar's "total"
        // (see item.number_of_episodes in renderer.js) — that should mean
        // "aired so far", same as everywhere else progress is judged,
        // rather than TMDB's raw total which includes announced-but-
        // unaired episodes. Falls back to number_of_episodes for movies
        // (aired_episode_count is null there) so this stays a no-op for them.
        number_of_episodes: media.aired_episode_count ?? media.number_of_episodes,
        genres: media.genres,
        tmdb_vote_average: media.tmdb_vote_average,
        raw_json: media.raw_json,
    };
    const { data, error } = await getClient()
        .from('media')
        .upsert(row, { onConflict: 'tmdb_id,media_type' })
        .select('id')
        .single();
    if (error) throw error;
    return data.id;
}

// Caches season-level poster/name — called alongside upsertMedia whenever
// a TV show's full details are fetched (that response already includes
// every season's poster_path, so this is free — no extra TMDB request).
// Non-fatal by design: missing season art shouldn't break loading the show.
async function upsertSeasonMeta(mediaId, seasons) {
    if (!seasons || seasons.length === 0) return;
    const rows = seasons
        .filter((s) => s.season_number != null)
        .map((s) => ({ media_id: mediaId, season_number: s.season_number, name: s.name, poster_path: s.poster_path }));
    if (rows.length === 0) return;
    const { error } = await getClient().from('season_meta').upsert(rows, { onConflict: 'media_id,season_number' });
    if (error) throw error;
}

// Bulk lookup for the Continue Watching row — one query for the specific
// (media_id, season_number) pairs actually needed, instead of a full
// details fetch per card. Returns a map keyed "mediaId:seasonNumber" ->
// poster_path (raw path; caller builds the sized URL).
async function getSeasonPosters(pairs) {
    if (!pairs || pairs.length === 0) return {};
    const mediaIds = [...new Set(pairs.map((p) => p.mediaId))];
    const { data, error } = await getClient()
        .from('season_meta')
        .select('media_id, season_number, poster_path')
        .in('media_id', mediaIds);
    if (error) throw error;
    const wanted = new Set(pairs.map((p) => `${p.mediaId}:${p.seasonNumber}`));
    const result = {};
    for (const row of data || []) {
        const key = `${row.media_id}:${row.season_number}`;
        if (wanted.has(key)) result[key] = row.poster_path;
    }
    return result;
}

// Refreshes just the episode/season count on a cached media row — used by
// the background new-episodes check, which shouldn't have to run a full
// upsertMedia() (that needs the whole normalized TMDB payload) just to fix
// up two numbers.
async function updateMediaEpisodeCounts(mediaId, { number_of_seasons, number_of_episodes }) {
    const { error } = await getClient()
        .from('media')
        .update({ number_of_seasons, number_of_episodes })
        .eq('id', mediaId);
    if (error) throw error;
}

// IMDb/Rotten Tomatoes numbers from OMDb — separate from upsertMedia since
// they come from a different source and are optional (skipped entirely if
// OMDB_API_KEY isn't set). Cached so the detail page doesn't need a fresh
// OMDb request every single time it's opened.
// IMDb/Rotten Tomatoes numbers from OMDb — separate from upsertMedia since
// they come from a different source and are optional (skipped entirely if
// OMDB_API_KEY isn't set). ratings_checked_at drives the caching in
// ipc-handlers.js: re-checked at most once a week, so a title with no
// Tomatometer yet (e.g. it hasn't released) doesn't get hit on every single
// page view, but still catches up once a score actually exists.
async function updateMediaRatings(mediaId, { imdb_id, imdb_rating, imdb_votes, rt_tomatometer, awards }) {
    const { error } = await getClient()
        .from('media')
        .update({ imdb_id, imdb_rating, imdb_votes, rt_tomatometer, awards_text: awards, ratings_checked_at: new Date().toISOString() })
        .eq('id', mediaId);
    if (error) throw error;
}

// Read-only counterpart to the above — lets the caller decide whether the
// cached numbers are fresh enough to skip a new OMDb request entirely.
async function getMediaRatingsCache(mediaId) {
    const { data, error } = await getClient()
        .from('media')
        .select('imdb_rating, imdb_votes, rt_tomatometer, awards_text, ratings_checked_at')
        .eq('id', mediaId)
        .single();
    if (error) throw error;
    return data;
}

async function getMediaById(mediaId) {
    const { data, error } = await getClient().from('media').select('*').eq('id', mediaId).single();
    if (error) throw error;
    return data;
}

// ---- entries (personal) ----

async function upsertEntry(session, mediaId, fields) {
    const userId = requireUserId(session);
    // quick_saved (Roulette's "Save to Watch") means "watched, no date on
    // file" — the moment any real date gets saved, it's not that state
    // anymore. Centralized here so every UI path that can set a date
    // (status auto-fill, the date pickers, the main Save button) gets this
    // for free, rather than needing to remember it individually.
    const setsRealDate = fields.date_finished || fields.date_started || fields.date_rewatched;
    const row = setsRealDate && fields.quick_saved === undefined
        ? { user_id: userId, media_id: mediaId, ...fields, quick_saved: false }
        : { user_id: userId, media_id: mediaId, ...fields };
    let { data, error } = await getClient()
        .from('entries')
        .upsert(row, { onConflict: 'user_id,media_id' })
        .select('*')
        .single();
    // Column not added yet (queued-via migration not run): save without it rather than failing.
    if (error && 'queued_via' in row && /queued_via/.test(error.message || '')) {
        const { queued_via: _drop, ...rest } = row;
        ({ data, error } = await getClient().from('entries').upsert(rest, { onConflict: 'user_id,media_id' }).select('*').single());
    }
    // Spoiler flag column not added yet: save without it rather than failing.
    if (error && 'review_spoilers' in row && /review_spoilers/.test(error.message || '')) {
        const { review_spoilers: _drop, ...rest } = row;
        ({ data, error } = await getClient().from('entries').upsert(rest, { onConflict: 'user_id,media_id' }).select('*').single());
    }
    // Reading-progress columns not added yet (books-progress-migration.sql not run).
    if (error && ('current_page' in row || 'page_total' in row) && /current_page|page_total/.test(error.message || '')) {
        const { current_page: _a, page_total: _b, ...rest } = row;
        ({ data, error } = await getClient().from('entries').upsert(rest, { onConflict: 'user_id,media_id' }).select('*').single());
        if (!error) throw new Error('Run books-progress-migration.sql in Supabase to save reading progress');
    }
    if (error) throw error;
    return data;
}

// NOTE: this used to select('*, media(...)') as an embedded join, same as
// listEntries below. Switched to the two-query pattern already used by
// getStatusesForItems/listCompletedTvEntries/getLastWatchedSeason — the
// embedded join has proven unreliable in this codebase (see those
// functions' comments), and a silently-empty `media` on this path meant an
// entry would come back with no title/poster/media_type at all.
async function getEntryForMedia(session, mediaId) {
    const userId = requireUserId(session);
    const { data, error } = await getClient()
        .from('entries')
        .select('*')
        .eq('user_id', userId)
        .eq('media_id', mediaId)
        .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    // media.id must never leak into the merge — this object's `id` has to
    // stay the ENTRIES row id (used for deleteEntry, watched_episodes
    // lookups, etc.), not the media row's id. Destructuring it off here is
    // what a plain `{ ...data, ...media }` got wrong before.
    const { id: _mediaRowId, ...mediaFields } = (await getMediaById(mediaId)) || {};
    return { ...data, ...mediaFields };
}

// Supabase/PostgREST caps how many rows a single query returns (commonly
// 1000, configurable per project) — a query that doesn't explicitly page
// through results just silently truncates once the library gets big enough.
// Fetches every row in batches instead of trusting one request to return
// everything.
const PAGE_SIZE = 1000;
async function fetchAllRows(buildQuery) {
    let all = [];
    let offset = 0;
    for (;;) {
        const { data, error } = await buildQuery(offset, offset + PAGE_SIZE - 1);
        if (error) throw error;
        all = all.concat(data || []);
        if (!data || data.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
    }
    return all;
}

// Same embedded-join reliability issue as getEntryForMedia above — this is
// the query that feeds the whole dashboard (Films/Series rows), so a row
// with a silently-empty `media` here doesn't just look wrong, it vanishes
// entirely once mediaType filtering runs (media_type comes back undefined).
// Two plain queries + a client-side merge instead.
async function listEntries(session, { status = null, mediaType = null } = {}) {
    const userId = requireUserId(session);
    const entryRows = await fetchAllRows((from, to) => {
        let query = getClient()
            .from('entries')
            .select('*')
            .eq('user_id', userId)
            .order('updated_at', { ascending: false })
            .range(from, to);
        if (status) query = query.eq('status', status);
        return query;
    });
    if (entryRows.length === 0) return [];

    const mediaIds = [...new Set(entryRows.map((e) => e.media_id))];
    const mediaRows = [];
    // Big libraries: a single .in() with thousands of ids overflows the request URL, so ask in chunks.
    for (let c = 0; c < mediaIds.length; c += 150) {
    const idChunk = mediaIds.slice(c, c + 150);
    mediaRows.push(...await fetchAllRows((from, to) =>
        getClient()
            .from('media')
            .select('id, title, poster_path, backdrop_path, overview, genres, media_type, release_date, tmdb_vote_average, tmdb_id, number_of_seasons, number_of_episodes, runtime, imdb_rating, rt_tomatometer')
            .in('id', idChunk)
            .order('id', { ascending: true })
            .range(from, to)
    ));
    }
    // `id` is only kept here to build the lookup map below — it must NOT
    // end up in the merged row, or it silently overwrites the entry's own
    // id (the bug that made every entry_id-based lookup, like watched-
    // episode counts, come up empty).
    const mediaById = new Map((mediaRows || []).map((m) => [m.id, m]));

    let rows = entryRows.map((entry) => {
        const media = mediaById.get(entry.media_id);
        if (!media) console.error(`entries:list — no media row for entry ${entry.id} (media_id ${entry.media_id})`);
        const { id: _mediaRowId, ...mediaFields } = media || {};
        return { ...entry, ...mediaFields };
    });
    if (mediaType) {
        const types = Array.isArray(mediaType) ? mediaType : [mediaType];
        rows = rows.filter((r) => types.includes(r.media_type));
    }
    return rows;
}

// Per-title facets for the Stats page (directors / countries / languages).
// Pulled out of the cached TMDB JSON here so only a few short strings per
// title cross to the renderer, not the whole blob. Tolerant of shape: any
// field that isn't in the cached JSON just comes back empty.
async function getMediaFacets(mediaIds) {
    const out = {};
    // raw_json is large (full TMDB credits), so small chunks — a big one hits Postgres' statement timeout.
    // A chunk that still fails is skipped (retried once) instead of failing the whole Stats page.
    for (let i = 0; i < mediaIds.length; i += 20) {
        const chunk = mediaIds.slice(i, i + 20);
        let data = null;
        for (let attempt = 0; attempt < 2 && !data; attempt++) {
            const res = await getClient().from('media').select('id, raw_json').in('id', chunk);
            if (res.error) { if (attempt === 1) console.error('facets chunk skipped:', res.error.message); } else data = res.data;
        }
        for (const row of data || []) {
            let j = null;
            try { j = typeof row.raw_json === 'string' ? JSON.parse(row.raw_json) : row.raw_json; } catch { j = null; }
            if (!j) { out[row.id] = { countries: [], languages: [], directors: [], collection: null }; continue; }
            if (j.source === 'openlibrary') {
                // Books: authors stand in for directors; subjects aren't used here.
                const au = (j.creators || []).filter((c) => c.id).map((c) => [c.id, c.name, c.profile_path || null]);
                out[row.id] = { countries: [], languages: [], directors: au.map((c) => c[1]), collection: null, country_codes: [], cast: [], dirs: au.slice(0, 4), crew: {},
                    studios: require('./publishers').matchPublishers(j.doc && j.doc.publisher).map((p) => [p.id, p.name, null]) };
                continue;
            }
            if (j.source === 'rawg') {
                // Games: developers stand in for directors, publishers for studios.
                const dv = (j.developers || []).map((c) => [c.id, c.name, null]);
                const pb = (j.publishers || []).map((c) => [c.id, c.name, null]);
                out[row.id] = { countries: [], languages: [], directors: dv.map((c) => c[1]), collection: null, country_codes: [], cast: [], dirs: dv.slice(0, 4), crew: {}, studios: pb.slice(0, 3) };
                continue;
            }
            const countries = (j.production_countries || []).map((c) => c.name || c.iso_3166_1).filter(Boolean);
            if (!countries.length && Array.isArray(j.origin_country)) countries.push(...j.origin_country);
            const languages = j.original_language ? [j.original_language] : [];
            const crew = (j.credits && j.credits.crew) || j.crew || [];
            const cast = (j.credits && j.credits.cast) || j.cast || [];
            const directors = crew.filter((c) => c.job === 'Director').map((c) => c.name).filter(Boolean);
            if (!directors.length && Array.isArray(j.created_by)) directors.push(...j.created_by.map((c) => c.name).filter(Boolean));
            const col = j.belongs_to_collection;
            // compact people lists for the Stats page: [tmdb id, name, profile path]
            const person = (c) => [c.id, c.name, c.profile_path || null];
            const dirs = crew.filter((c) => c.job === 'Director' && c.id).map(person);
            if (!dirs.length && Array.isArray(j.created_by)) dirs.push(...j.created_by.filter((c) => c.id).map(person));
            const jobs = {
                producers: ['Producer'], execs: ['Executive Producer'], writers: ['Screenplay', 'Writer'], editors: ['Editor'],
                cinematography: ['Director of Photography'], composers: ['Original Music Composer', 'Composer'],
                design: ['Production Design'], costume: ['Costume Design'], casting: ['Casting'],
            };
            const groups = {};
            for (const [key, names] of Object.entries(jobs)) {
                const seen = new Set();
                groups[key] = crew.filter((c) => names.includes(c.job) && c.id && !seen.has(c.id) && seen.add(c.id)).slice(0, 4).map((c) => [c.id, c.name]);
            }
            const codes = (j.production_countries || []).map((c) => c.iso_3166_1).filter(Boolean);
            if (!codes.length && Array.isArray(j.origin_country)) codes.push(...j.origin_country);
            out[row.id] = { countries, languages, directors: [...new Set(directors)],
                collection: col && col.id ? { id: col.id, name: col.name } : null,
                country_codes: codes,
                cast: cast.filter((c) => c.id).slice(0, 12).map(person),
                dirs: dirs.slice(0, 4),
                crew: groups,
                studios: (j.production_companies || []).filter((c) => c.id).slice(0, 4).map((c) => [c.id, c.name, c.logo_path || null]) };
        }
    }
    return out;
}


// How many times each entry was logged in the diary (entry id -> count). Empty if the table doesn't exist yet.
async function getEntryLogCounts(session) {
    requireUserId(session);
    try {
        let rows;
        try {
            rows = await fetchAllRows((from, to) => getClient().from('entry_logs').select('id, entry_id, episode_id').order('id', { ascending: true }).range(from, to));
        } catch {
            rows = await fetchAllRows((from, to) => getClient().from('entry_logs').select('id, entry_id').order('id', { ascending: true }).range(from, to));
        }
        const counts = {};
        // Episode rows are progress, not "times watched" — only whole-title logs count.
        for (const r of rows || []) if (!r.episode_id) counts[r.entry_id] = (counts[r.entry_id] || 0) + 1;
        return counts;
    } catch { return {}; }
}

// Official lists everyone can track progress on (see official-lists-migration.sql).
async function listOfficialLists() {
    const { data: lists, error } = await getClient().from('official_lists')
        .select('id, slug, name, description, position, media_type, list_id').order('position', { ascending: true });
    if (error) throw error;
    if (!lists.length) return [];
    const ids = lists.map((l) => l.id);
    const fetchItems = (cols) => fetchAllRows((from, to) => getClient().from('official_list_items')
        .select(cols).in('list_id', ids).order('list_id').order('position').range(from, to));
    let items;
    try { items = await fetchItems('id, list_id, position, title, alt_titles, year, tmdb_id, media_type, creator'); }
    catch {
        try { items = await fetchItems('id, list_id, position, title, alt_titles, year, tmdb_id, media_type'); }
        catch { items = await fetchItems('id, list_id, position, title, alt_titles, year, tmdb_id'); } // newer columns not added yet
    }
    return lists.map((l) => ({ ...l, items: (items || []).filter((it) => it.list_id === l.id) }));
}

async function isOfficialAdmin() {
    const { data, error } = await getClient().rpc('official_is_admin');
    if (error) return false;
    return Boolean(data);
}

async function addOfficialListItem(listId, mediaId) {
    const { error } = await getClient().rpc('official_add_item', { p_list_id: listId, p_media_id: mediaId });
    if (error) throw error;
}

async function deleteEntry(session, entryId) {
    const userId = requireUserId(session);
    const { error } = await getClient().from('entries').delete().eq('id', entryId).eq('user_id', userId);
    if (error) throw error;
}

// Bulk status lookup for posters that aren't from the user's own library
// (related/similar titles, a person's filmography) — used to draw the
// small corner status flag on those posters. tmdb_id alone isn't unique
// across movies/TV, so this groups by media_type. Two plain queries
// (media -> internal ids, then entries filtered by those ids) rather than
// an embedded join — every other query in this file is a single-table
// query, and embedded-resource filtering turned out to be unreliable here.
// Returns a map keyed "media_type:tmdb_id" -> status.
async function getStatusesForItems(session, items) {
    if (!session || !items || items.length === 0) return {};
    const userId = requireUserId(session);
    const idsByType = { movie: [], tv: [] };
    for (const item of items) {
        if (item && item.tmdb_id != null && idsByType[item.media_type]) {
            idsByType[item.media_type].push(item.tmdb_id);
        }
    }
    const result = {};
    for (const mediaType of ['movie', 'tv']) {
        const tmdbIds = [...new Set(idsByType[mediaType])];
        if (tmdbIds.length === 0) continue;

        const { data: mediaRows, error: mediaError } = await getClient()
            .from('media')
            .select('id, tmdb_id')
            .eq('media_type', mediaType)
            .in('tmdb_id', tmdbIds);
        if (mediaError) throw mediaError;
        if (!mediaRows || mediaRows.length === 0) continue;

        const tmdbIdByMediaId = new Map(mediaRows.map((m) => [m.id, m.tmdb_id]));
        const { data: entryRows, error: entryError } = await getClient()
            .from('entries')
            .select('media_id, status')
            .eq('user_id', userId)
            .in('media_id', mediaRows.map((m) => m.id));
        if (entryError) throw entryError;

        for (const row of entryRows || []) {
            const tmdbId = tmdbIdByMediaId.get(row.media_id);
            if (row.status && tmdbId != null) result[`${mediaType}:${tmdbId}`] = row.status;
        }
    }
    return result;
}

// ---- episodes (shared cache) + watched_episodes (personal) ----

async function upsertEpisodes(mediaId, episodes) {
    const rows = episodes.map((ep) => ({
        media_id: mediaId,
        season_number: ep.season_number,
        episode_number: ep.episode_number,
        name: ep.name ?? null,
        air_date: ep.air_date ?? null,
    }));
    const { data, error } = await getClient()
        .from('episodes')
        .upsert(rows, { onConflict: 'media_id,season_number,episode_number' })
        .select('id');
    if (error) throw error;
    return data.map((r) => r.id);
}

async function getEpisodes(mediaId, seasonNumber = null) {
    let query = getClient().from('episodes').select('*').eq('media_id', mediaId).order('episode_number');
    if (seasonNumber != null) query = query.eq('season_number', seasonNumber);
    const { data, error } = await query;
    if (error) throw error;
    return data;
}

async function toggleWatchedEpisode(session, entryId, episodeId, watched) {
    requireUserId(session); // RLS also enforces this server-side via entry ownership
    if (watched) {
        const { error } = await getClient()
            .from('watched_episodes')
            .upsert({ entry_id: entryId, episode_id: episodeId }, { onConflict: 'entry_id,episode_id' });
        if (error) throw error;
    } else {
        const { error } = await getClient()
            .from('watched_episodes')
            .delete()
            .eq('entry_id', entryId)
            .eq('episode_id', episodeId);
        if (error) throw error;
    }
    await syncEpisodeLog(entryId, episodeId, watched);
    return getWatchedEpisodeIds(session, entryId);
}

// Ticking an episode adds a diary row dated today (local time); unticking removes it.
// Skipped silently if episode-diary-migration.sql hasn't been run yet.
function localToday() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
async function syncEpisodeLog(entryId, episodeId, watched) {
    try {
        const c = getClient();
        if (!watched) {
            await c.from('entry_logs').delete().eq('entry_id', entryId).eq('episode_id', episodeId);
            return;
        }
        const { data: existing, error: e1 } = await c.from('entry_logs').select('id').eq('entry_id', entryId).eq('episode_id', episodeId).limit(1);
        if (e1 || (existing && existing.length)) return;
        const { data: ep } = await c.from('episodes').select('season_number, episode_number, name').eq('id', episodeId).maybeSingle();
        const label = ep ? `S${ep.season_number}E${ep.episode_number}${ep.name ? ` · ${ep.name}` : ''}` : null;
        await c.from('entry_logs').insert({ entry_id: entryId, watched_on: localToday(), is_rewatch: false, episode_id: episodeId, episode_label: label });
    } catch (err) { console.error('episode diary log:', err.message); }
}

// All episode diary rows (RLS limits these to your own entries).
async function listEpisodeLogs(session) {
    requireUserId(session);
    try {
        return await fetchAllRows((from, to) => getClient().from('entry_logs')
            .select('id, entry_id, watched_on, episode_id, episode_label').not('episode_id', 'is', null)
            .order('id', { ascending: true }).range(from, to));
    } catch { return []; }
}

// Every completed TV show in the library — used by the background
// new-episodes check on app launch. Embeds media for a plain read (not
// filtering on the embedded column, which is the pattern that's been
// unreliable in this file before) and filters media_type client-side.
// Shows worth refreshing on every launch: `completed` ones need checking in
// case they should revert to Watching, and `in_progress` ones (Continue
// Watching) need their cached episode count / season art kept in sync —
// otherwise those only ever update when the user happens to reopen that
// specific show's page. Two plain queries instead of an embedded join, same
// reliability reasoning as getEntryForMedia/listEntries above (a silently-
// empty `media` here meant a show could quietly get skipped every run).
async function listTrackedTvEntries(session) {
    const userId = requireUserId(session);
    const { data: entryRows, error } = await getClient()
        .from('entries')
        .select('id, media_id, status')
        .eq('user_id', userId)
        .in('status', ['completed', 'in_progress']);
    if (error) throw error;
    if (entryRows.length === 0) return [];

    const mediaIds = [...new Set(entryRows.map((e) => e.media_id))];
    const mediaRows = [];
    for (let c = 0; c < mediaIds.length; c += 150) {
        const { data, error: mediaError } = await getClient()
            .from('media')
            .select('id, tmdb_id, media_type, title')
            .in('id', mediaIds.slice(c, c + 150));
        if (mediaError) throw mediaError;
        mediaRows.push(...(data || []));
    }
    const mediaById = new Map((mediaRows || []).map((m) => [m.id, m]));

    return entryRows
        .map((e) => ({ entry: e, media: mediaById.get(e.media_id) }))
        .filter(({ media }) => media?.media_type === 'tv')
        .map(({ entry, media }) => ({
            entryId: entry.id,
            mediaId: entry.media_id,
            tmdbId: media.tmdb_id,
            title: media.title,
            status: entry.status,
        }));
}

// ---- Videogame achievements (ticked by hand; the list itself comes from RAWG) ----
async function getUnlockedAchievements(session, mediaId) {
    const userId = requireUserId(session);
    const { data, error } = await getClient().from('game_achievements').select('achievement_id').eq('user_id', userId).eq('media_id', mediaId);
    if (error) throw error;
    return data.map((r) => Number(r.achievement_id));
}

async function getUnlockedCounts(session, mediaIds) {
    const userId = requireUserId(session);
    const counts = {};
    for (let i = 0; i < mediaIds.length; i += 100) {
        const { data, error } = await getClient().from('game_achievements').select('media_id').eq('user_id', userId).in('media_id', mediaIds.slice(i, i + 100));
        if (error) throw error;
        for (const r of data || []) counts[r.media_id] = (counts[r.media_id] || 0) + 1;
    }
    return counts;
}

async function setAchievementUnlocked(session, mediaId, achievementId, unlocked) {
    const userId = requireUserId(session);
    if (unlocked) {
        const { error } = await getClient().from('game_achievements')
            .upsert({ user_id: userId, media_id: mediaId, achievement_id: achievementId }, { onConflict: 'user_id,media_id,achievement_id' });
        if (error) throw error;
    } else {
        const { error } = await getClient().from('game_achievements').delete()
            .eq('user_id', userId).eq('media_id', mediaId).eq('achievement_id', achievementId);
        if (error) throw error;
    }
    return true;
}

async function getWatchedEpisodeIds(session, entryId) {
    requireUserId(session);
    const { data, error } = await getClient().from('watched_episodes').select('episode_id').eq('entry_id', entryId);
    if (error) throw error;
    return data.map((r) => r.episode_id);
}

// Which season to default to when opening the episode list — the one
// containing the furthest-progressed watched episode ("resume where you
// stopped"), rather than always Season 1. Two plain queries (watched ids,
// then those episodes' season/episode numbers) rather than an embedded
// join — same reasoning as getStatusesForItems above: this file's embedded-
// join attempts have been unreliable, plain queries haven't.
async function getLastWatchedSeason(session, entryId) {
    const watchedIds = await getWatchedEpisodeIds(session, entryId);
    if (watchedIds.length === 0) return null;
    const { data, error } = await getClient()
        .from('episodes')
        .select('season_number, episode_number')
        .in('id', watchedIds)
        .order('season_number', { ascending: false })
        .order('episode_number', { ascending: false })
        .limit(1);
    if (error) throw error;
    return data[0]?.season_number ?? null;
}

// Bulk version of the above for the Continue Watching row — one query for
// every in-progress show instead of one per show. Returns entry_id ->
// season_number (the season containing the furthest-watched episode), so
// the Continue Watching card can show "Season 3" instead of just a count.
async function getLastWatchedSeasons(session, entryIds) {
    requireUserId(session);
    if (!entryIds || entryIds.length === 0) return {};
    const { data: watchedRows, error } = await getClient()
        .from('watched_episodes')
        .select('entry_id, episode_id')
        .in('entry_id', entryIds);
    if (error) throw error;
    if (watchedRows.length === 0) return {};

    const episodeIds = [...new Set(watchedRows.map((r) => r.episode_id))];
    const { data: episodeRows, error: episodeError } = await getClient()
        .from('episodes')
        .select('id, season_number, episode_number')
        .in('id', episodeIds);
    if (episodeError) throw episodeError;
    const episodeById = new Map((episodeRows || []).map((e) => [e.id, e]));

    const bestByEntry = {};
    for (const row of watchedRows) {
        const ep = episodeById.get(row.episode_id);
        if (!ep) continue;
        const current = bestByEntry[row.entry_id];
        if (!current || ep.season_number > current.season_number
            || (ep.season_number === current.season_number && ep.episode_number > current.episode_number)) {
            bestByEntry[row.entry_id] = ep;
        }
    }
    const result = {};
    for (const [entryId, ep] of Object.entries(bestByEntry)) result[entryId] = ep.season_number;
    return result;
}

// Bulk version of the above for the Continue Watching row — one query for
// every in-progress show instead of one per show. Returns a map of
// entry_id -> number of episodes watched (client already knows the total
// from media.number_of_episodes, so a count is all that's needed here).
async function getTvWatchLog(session) {
    const userId = requireUserId(session);
    const c = getClient();
    const { data: ents, error: e1 } = await c.from('entries').select('id').eq('user_id', userId);
    if (e1) throw e1;
    const ids = (ents || []).map((e) => e.id);
    const out = [];
    for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        for (let from = 0; ; from += 1000) { // PostgREST returns max 1000 rows per request
            const { data, error } = await c.from('watched_episodes').select('*').in('entry_id', chunk).range(from, from + 999);
            if (error) throw error;
            (data || []).forEach((r) => {
                const at = r.watched_at || r.created_at || r.updated_at || null;
                out.push({ entry_id: r.entry_id, day: at ? String(at).slice(0, 10) : null });
            });
            if (!data || data.length < 1000) break;
        }
    }
    return out;
}

async function getWatchedEpisodeCounts(session, entryIds) {
    requireUserId(session);
    if (!entryIds || entryIds.length === 0) return {};
    const counts = {};
    for (let c = 0; c < entryIds.length; c += 100) {
        const chunk = entryIds.slice(c, c + 100);
        let from = 0;
        for (;;) {
            const { data, error } = await getClient().from('watched_episodes').select('entry_id').in('entry_id', chunk).range(from, from + 999);
            if (error) throw error;
            for (const row of data) counts[row.entry_id] = (counts[row.entry_id] || 0) + 1;
            if (data.length < 1000) break;
            from += 1000;
        }
    }
    return counts;
}

// ---- person follows (actors/directors) ----

async function followPerson(session, { tmdbPersonId, personName, profilePath }) {
    const userId = requireUserId(session);
    const { error } = await getClient()
        .from('person_follows')
        .upsert(
            { user_id: userId, tmdb_person_id: tmdbPersonId, person_name: personName, profile_path: profilePath },
            { onConflict: 'user_id,tmdb_person_id' }
        );
    if (error) throw error;
}

async function unfollowPerson(session, tmdbPersonId) {
    const userId = requireUserId(session);
    const { error } = await getClient()
        .from('person_follows')
        .delete()
        .eq('user_id', userId)
        .eq('tmdb_person_id', tmdbPersonId);
    if (error) throw error;
}

async function isFollowingPerson(session, tmdbPersonId) {
    const userId = requireUserId(session);
    const { data, error } = await getClient()
        .from('person_follows')
        .select('id')
        .eq('user_id', userId)
        .eq('tmdb_person_id', tmdbPersonId)
        .maybeSingle();
    if (error) throw error;
    return Boolean(data);
}

async function listFollowedPeople(session) {
    const userId = requireUserId(session);
    const { data, error } = await getClient()
        .from('person_follows')
        .select('tmdb_person_id, person_name, profile_path, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
}

// ---- studio / network follows ----
async function followStudio(session, { kind, tmdbId, name, logoPath }) {
    const userId = requireUserId(session);
    const { error } = await getClient().from('studio_follows')
        .upsert({ user_id: userId, kind, tmdb_id: tmdbId, name, logo_path: logoPath || null }, { onConflict: 'user_id,kind,tmdb_id' });
    if (error) throw error;
}
async function unfollowStudio(session, { kind, tmdbId }) {
    const userId = requireUserId(session);
    const { error } = await getClient().from('studio_follows').delete().eq('user_id', userId).eq('kind', kind).eq('tmdb_id', tmdbId);
    if (error) throw error;
}
async function isFollowingStudio(session, { kind, tmdbId }) {
    const userId = requireUserId(session);
    const { data, error } = await getClient().from('studio_follows').select('id').eq('user_id', userId).eq('kind', kind).eq('tmdb_id', tmdbId).maybeSingle();
    if (error) throw error;
    return Boolean(data);
}
async function listFollowedStudios(session) {
    const userId = requireUserId(session);
    const { data, error } = await getClient().from('studio_follows').select('kind, tmdb_id, name, logo_path, created_at').eq('user_id', userId).order('created_at', { ascending: false });
    if (error) return []; // table not created yet
    return data || [];
}

// ---- profile (display name/avatar/bio) ----

async function getProfile(session) {
    const userId = requireUserId(session);
    const { data, error } = await getClient()
        .from('profiles')
        .select('display_name, avatar_color, avatar_url, banner_url, bio, location, x_handle')
        .eq('id', userId)
        .maybeSingle();
    if (error) {
        // location/x_handle columns missing (profile-social-migration.sql not run yet)
        const retry = await getClient().from('profiles')
            .select('display_name, avatar_color, avatar_url, banner_url, bio').eq('id', userId).maybeSingle();
        if (retry.error) throw retry.error;
        return retry.data;
    }
    return data;
}

async function upsertProfile(session, { display_name, avatar_color, avatar_url, banner_url, bio, location, x_handle }) {
    const userId = requireUserId(session);
    const row = { id: userId, display_name, avatar_color, bio, updated_at: new Date().toISOString() };
    if (avatar_url !== undefined) row.avatar_url = avatar_url;
    if (banner_url !== undefined) row.banner_url = banner_url;
    if (location !== undefined) row.location = location;
    if (x_handle !== undefined) row.x_handle = x_handle;
    let { error } = await getClient().from('profiles').upsert(row);
    if (error && (location !== undefined || x_handle !== undefined)) {
        delete row.location; delete row.x_handle; // columns not there yet — save everything else
        ({ error } = await getClient().from('profiles').upsert(row));
    }
    if (error) throw error;
}

async function uploadAvatar(session, { fileName, base64Data, contentType }) {
    const userId = requireUserId(session);
    const path = `${userId}/${Date.now()}-${fileName}`;
    const buffer = Buffer.from(base64Data, 'base64');
    const { error } = await getClient().storage.from('avatars').upload(path, buffer, { contentType, upsert: true });
    if (error) throw error;
    const { data } = getClient().storage.from('avatars').getPublicUrl(path);
    return data.publicUrl;
}

// ---- family (real invite/accept relationship — see supabase/schema.sql) ----

// Whichever family this account actually belongs to — as owner, or as an
// accepted member of someone else's — plus its name. Null if they've never
// been part of one (the normal, unremarkable case for a solo account).
async function getMyFamily(session) {
    const userId = requireUserId(session);
    const { data: owned, error: ownErr } = await getClient().from('families').select('id, name').eq('owner_id', userId).maybeSingle();
    if (ownErr) throw ownErr;
    if (owned) return { id: owned.id, name: owned.name, isOwner: true };
    const { data: membership, error: memErr } = await getClient().from('family_members').select('family_id, families(name)').eq('user_id', userId).maybeSingle();
    if (memErr) throw memErr;
    if (!membership) return null;
    return { id: membership.family_id, name: membership.families?.name || null, isOwner: false };
}

// Explicit "Create a Family" action — unlike the old implicit
// ensureOwnFamily, this only ever runs when the user actually chooses to
// create one, with a name they picked, matching Steam's own setup flow.
async function createFamily(session, name) {
    const userId = requireUserId(session);
    const { data: created, error: insErr } = await getClient()
        .from('families').insert({ owner_id: userId, name: name.trim() }).select('id, name').single();
    if (insErr) throw insErr;
    const { error: memErr } = await getClient()
        .from('family_members').insert({ family_id: created.id, user_id: userId, email: session.user.email });
    if (memErr) throw memErr;
    return created;
}

async function renameFamily(session, familyId, name) {
    const { error } = await getClient().from('families').update({ name: name.trim() }).eq('id', familyId);
    if (error) throw error;
}

async function inviteToFamily(session, email) {
    const family = await getMyFamily(session);
    if (!family) throw new Error('Create a family before inviting anyone');
    const { error } = await getClient()
        .from('family_invites')
        .upsert(
            { family_id: family.id, invited_email: email.trim().toLowerCase(), invited_by: session.user.id, status: 'pending' },
            { onConflict: 'family_id,invited_email' }
        );
    if (error) throw error;
}

async function revokeFamilyInvite(inviteId) {
    const { error } = await getClient().from('family_invites').delete().eq('id', inviteId);
    if (error) throw error;
}

async function listMyFamily(session) {
    const family = await getMyFamily(session);
    if (!family) return { family: null, members: [], sentInvites: [] };
    const [{ data: members, error: memErr }, { data: sentInvites, error: invErr }] = await Promise.all([
        getClient().from('family_members').select('user_id, email, created_at').eq('family_id', family.id),
        getClient().from('family_invites').select('id, invited_email, status, created_at').eq('family_id', family.id).eq('status', 'pending'),
    ]);
    if (memErr) throw memErr;
    if (invErr) throw invErr;
    return { family, members: members || [], sentInvites: sentInvites || [] };
}

async function listPendingInvitesForMe(session) {
    const { data, error } = await getClient()
        .from('family_invites')
        .select('id, family_id, invited_by, created_at')
        .eq('invited_email', session.user.email.toLowerCase())
        .eq('status', 'pending');
    if (error) throw error;
    return data;
}

async function acceptFamilyInvite(session, inviteId) {
    const userId = requireUserId(session);
    const { data: invite, error: invErr } = await getClient()
        .from('family_invites').select('family_id').eq('id', inviteId).single();
    if (invErr) throw invErr;

    const { error: memErr } = await getClient()
        .from('family_members')
        .insert({ family_id: invite.family_id, user_id: userId, email: session.user.email });
    if (memErr) throw memErr;

    const { error: updErr } = await getClient().from('family_invites').update({ status: 'accepted' }).eq('id', inviteId);
    if (updErr) throw updErr;
}

async function declineFamilyInvite(inviteId) {
    const { error } = await getClient().from('family_invites').update({ status: 'declined' }).eq('id', inviteId);
    if (error) throw error;
}

// Owner removing someone else, or a member removing themself (leaving).
async function removeFamilyMember(memberUserId) {
    const { error } = await getClient().from('family_members').delete().eq('user_id', memberUserId);
    if (error) throw error;
}

// ---- custom lists (personal, with optional sharing — see supabase/schema.sql) ----

// NOTE: chaining .select() straight onto .insert() consistently fails with
// a 42501 RLS error here, even though the row inserts fine and the owner
// can normally select their own rows — something about how PostgREST's
// INSERT...RETURNING interacts with the can_view_list() policy function
// (see https://github.com/orgs/supabase/discussions/45715). Splitting into
// a bare insert followed by a separate select sidesteps it entirely.
async function createList(session, { name, description, genres, isRanked, visibility }) {
    const userId = requireUserId(session);
    const { error: insertErr } = await getClient()
        .from('lists')
        .insert({
            user_id: userId,
            name: name.trim(),
            description: description?.trim() || null,
            genres: genres || [],
            is_ranked: !!isRanked,
            visibility: visibility || 'private',
        });
    if (insertErr) throw insertErr;

    const { data, error } = await getClient()
        .from('lists')
        .select('id, name, description, genres, is_ranked, visibility, is_official, created_at, updated_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
    if (error) throw error;
    return data;
}

async function renameList(listId, { name, description, genres, isRanked, visibility }) {
    const { error } = await getClient()
        .from('lists')
        .update({
            name: name.trim(),
            description: description?.trim() || null,
            genres: genres || [],
            is_ranked: !!isRanked,
            ...(visibility ? { visibility } : {}),
        })
        .eq('id', listId);
    if (error) throw error;
}

async function deleteList(listId) {
    const { error } = await getClient().from('lists').delete().eq('id', listId);
    if (error) throw error;
}

// Bumps updated_at so "Sort by When Updated" reflects item changes too, not
// just renames (the DB trigger only fires on an UPDATE to the lists row
// itself, which adding/removing an item never touches).
async function touchList(listId) {
    const { error } = await getClient().from('lists').update({ updated_at: new Date().toISOString() }).eq('id', listId);
    if (error) throw error;
}

// Item counts fetched separately and merged in — Supabase's client doesn't
// do aggregate joins, and this is one extra query total either way.
async function attachListCounts(lists) {
    if (lists.length === 0) return [];
    const listIds = lists.map((l) => l.id);
    const { data: items, error } = await getClient()
        .from('list_items').select('list_id, media_id, added_at, position').in('list_id', listIds);
    if (error) throw error;

    const counts = {};
    for (const it of items) counts[it.list_id] = (counts[it.list_id] || 0) + 1;

    // Up to 5 poster thumbnails per list for the card's overlapping-pile
    // preview — first items in the list's displayed (position) order.
    let postersById = {};
    if (items.length) {
        const mediaIds = [...new Set(items.map((it) => it.media_id))];
        const { data: mediaRows, error: mediaErr } = await getClient()
            .from('media').select('id, poster_path').in('id', mediaIds);
        if (mediaErr) throw mediaErr;
        postersById = Object.fromEntries(mediaRows.map((m) => [m.id, m.poster_path]));
    }
    const previewsByList = {};
    for (const it of [...items].sort((a, b) => ((a.position ?? 1e9) - (b.position ?? 1e9)) || (new Date(a.added_at) - new Date(b.added_at)))) {
        const list = previewsByList[it.list_id] || (previewsByList[it.list_id] = []);
        if (list.length < 5 && postersById[it.media_id]) list.push(postersById[it.media_id]);
    }

    return lists.map((l) => ({ ...l, item_count: counts[l.id] || 0, preview_posters: previewsByList[l.id] || [] }));
}

// Likes, family-share counts, and the user's own manual ordering — all
// fetched separately and merged in. Each lookup is wrapped so that if the
// matching migration hasn't been run yet, the Lists page still loads (just
// without that piece) instead of failing outright.
async function attachListSocial(session, lists) {
    if (lists.length === 0) return [];
    const userId = requireUserId(session);
    const listIds = lists.map((l) => l.id);
    const likeCount = {}; const likedByMe = new Set(); const shareCount = {}; const customPos = {};

    try {
        const { data, error } = await getClient().from('list_likes').select('list_id, user_id').in('list_id', listIds);
        if (error) throw error;
        for (const r of data) {
            likeCount[r.list_id] = (likeCount[r.list_id] || 0) + 1;
            if (r.user_id === userId) likedByMe.add(r.list_id);
        }
    } catch (err) { console.error('list likes lookup failed (run the likes migration?):', err.message || err); }

    try {
        const { data, error } = await getClient().from('list_shares').select('list_id').in('list_id', listIds);
        if (error) throw error;
        for (const r of data) shareCount[r.list_id] = (shareCount[r.list_id] || 0) + 1;
    } catch (err) { console.error('list shares lookup failed:', err.message || err); }

    try {
        const { data, error } = await getClient().from('list_order').select('list_id, position').eq('user_id', userId).in('list_id', listIds);
        if (error) throw error;
        for (const r of data) customPos[r.list_id] = r.position;
    } catch (err) { console.error('list order lookup failed (run the list-order migration?):', err.message || err); }

    return lists.map((l) => ({
        ...l,
        like_count: likeCount[l.id] || 0,
        liked_by_me: likedByMe.has(l.id),
        share_count: shareCount[l.id] || 0,
        custom_position: customPos[l.id] ?? null,
    }));
}

// Every account has a "Favorite Titles" list (see favorites-migration.sql).
const favoritesEnsured = new Set();
async function ensureFavoritesList(userId) {
    if (favoritesEnsured.has(userId)) return;
    const { error } = await getClient().rpc('my_favorites_list');
    if (!error) favoritesEnsured.add(userId);
}

// The signed-in user's favorites, in their chosen order, with the "show on profile" flag.
async function getFavoritesOrder(session) {
    const userId = requireUserId(session);
    const { data: list } = await getClient().from('lists').select('id').eq('user_id', userId).eq('is_favorites', true).maybeSingle();
    if (!list) return { listId: null, items: [] };
    const { data, error } = await getClient().from('list_items')
        .select('media_id, position, show_on_profile').eq('list_id', list.id).order('position', { ascending: true });
    if (error) throw error;
    return { listId: list.id, items: data };
}

async function setListItemProfileVisible(listId, mediaId, visible) {
    const { error } = await getClient().from('list_items').update({ show_on_profile: Boolean(visible) })
        .eq('list_id', listId).eq('media_id', mediaId);
    if (error) throw error;
}

async function getFollowCounts(session) {
    const userId = requireUserId(session);
    const c = getClient();
    const count = async (col) => {
        const { count, error } = await c.from('user_follows').select('*', { count: 'exact', head: true }).eq(col, userId);
        return error ? 0 : (count || 0); // table missing (migration not run yet) -> 0
    };
    return { following: await count('follower_id'), followers: await count('followee_id') };
}

async function getFollowState(session, userId) {
    const me = requireUserId(session);
    const c = getClient();
    const [a, b] = await Promise.all([
        c.from('user_follows').select('*', { count: 'exact', head: true }).eq('followee_id', userId),
        c.from('user_follows').select('follower_id').eq('followee_id', userId).eq('follower_id', me).limit(1),
    ]);
    return { followers: a.error ? 0 : (a.count || 0), i_follow: !b.error && (b.data || []).length > 0, is_me: userId === me };
}
// Everything the Activity tab needs beyond your own entries/lists. Each piece is
// fetched separately and fails soft (missing table / RLS) so the tab still loads.
async function getActivityExtras(session) {
    const me = requireUserId(session);
    const c = getClient();
    const out = { likedLists: [], newFollowers: [], following: [], listLikes: [], friends: [], family: [], officialIds: [] };
    const officialSet = new Set();
    const names = async (ids) => {
        ids = [...new Set(ids.filter(Boolean))];
        if (!ids.length) return {};
        const { data } = await c.from('profiles').select('id, display_name').in('id', ids);
        const res = Object.fromEntries((data || []).map((p) => [p.id, p.display_name || 'Member']));
        try {
            const { data: off } = await c.from('lists').select('user_id').eq('is_official', true).in('user_id', ids);
            (off || []).forEach((r) => { res[r.user_id] = 'Official Lists'; officialSet.add(r.user_id); });
        } catch { /* ignore */ }
        return res;
    };
    try {
        const { data } = await c.from('list_likes').select('*').eq('user_id', me);
        const rows = data || [];
        if (rows.length) {
            const { data: lists } = await c.from('lists').select('id, name, user_id').in('id', rows.map((r) => r.list_id));
            const nm = await names((lists || []).map((l) => l.user_id));
            const byId = Object.fromEntries((lists || []).map((l) => [l.id, l]));
            out.likedLists = rows.filter((r) => byId[r.list_id]).map((r) => ({
                id: r.list_id, name: byId[r.list_id].name, owner_id: byId[r.list_id].user_id,
                owner_name: nm[byId[r.list_id].user_id] || 'Member', at: r.created_at || null,
            }));
        }
    } catch { /* ignore */ }
    try {
        const { data } = await c.from('user_follows').select('follower_id, followee_id, created_at').or(`follower_id.eq.${me},followee_id.eq.${me}`);
        const rows = data || [];
        const nm = await names(rows.flatMap((r) => [r.follower_id, r.followee_id]));
        rows.forEach((r) => {
            if (r.followee_id === me) out.newFollowers.push({ id: r.follower_id, name: nm[r.follower_id] || 'Member', at: r.created_at });
            else out.following.push({ id: r.followee_id, name: nm[r.followee_id] || 'Member', at: r.created_at });
        });
    } catch { /* ignore */ }
    try {
        const { data: mine } = await c.from('lists').select('id, name').eq('user_id', me);
        if (mine && mine.length) {
            const { data } = await c.from('list_likes').select('*').in('list_id', mine.map((l) => l.id)).neq('user_id', me);
            const nm = await names((data || []).map((r) => r.user_id));
            const lname = Object.fromEntries(mine.map((l) => [l.id, l.name]));
            out.listLikes = (data || []).map((r) => ({ list_id: r.list_id, list_name: lname[r.list_id], user_id: r.user_id, user_name: nm[r.user_id] || 'Member', at: r.created_at || null }));
        }
    } catch { /* ignore */ }
    const entriesFor = async (ids, nameMap) => {
        if (!ids.length) return [];
        const runQ = (cols) => c.from('entries').select(cols)
            .in('user_id', ids).in('status', ['completed', 'rewatched']).order('updated_at', { ascending: false }).limit(60);
        let { data: ents, error: entsErr } = await runQ('user_id, media_id, status, rating, review, review_spoilers, date_finished, date_rewatched, updated_at');
        if (entsErr) ({ data: ents } = await runQ('user_id, media_id, status, rating, review, date_finished, date_rewatched, updated_at'));
        const mids = [...new Set((ents || []).map((e) => e.media_id))];
        let media = {};
        if (mids.length) {
            const { data: m } = await c.from('media').select('id, tmdb_id, media_type, title, release_date, poster_path').in('id', mids);
            media = Object.fromEntries((m || []).map((x) => [x.id, x]));
        }
        return (ents || []).filter((e) => media[e.media_id]).map((e) => ({
            user_id: e.user_id, user_name: nameMap[e.user_id] || 'Member', rating: e.rating, review: e.review, review_spoilers: !!e.review_spoilers,
            at: e.date_rewatched || e.date_finished || e.updated_at, media: media[e.media_id],
        }));
    };
    try {
        out.friends = await entriesFor(out.following.map((f) => f.id), Object.fromEntries(out.following.map((f) => [f.id, f.name])));
    } catch { /* entries of others not readable (run activity-migration.sql) */ }
    out.family = [];
    try {
        const fam = await getMyFamily(session);
        if (fam) {
            const { data: mem } = await c.from('family_members').select('user_id, email').eq('family_id', fam.id);
            const others = (mem || []).filter((m) => m.user_id !== me);
            const nm = await names(others.map((m) => m.user_id));
            const nameMap = Object.fromEntries(others.map((m) => [m.user_id, (nm[m.user_id] && nm[m.user_id] !== 'Member') ? nm[m.user_id] : (m.email || 'Member').split('@')[0]]));
            out.family = await entriesFor(others.map((m) => m.user_id), nameMap);
        }
    } catch { /* ignore */ }
    out.officialIds = [...officialSet];
    return out;
}

// ---- diary logs (each time something was watched / read / played) ----
async function listEntryLogs(session, entryId) {
    requireUserId(session);
    let { data, error } = await getClient().from('entry_logs')
        .select('id, watched_on, started_on, is_rewatch, created_at, episode_id').eq('entry_id', entryId)
        .order('watched_on', { ascending: false, nullsFirst: false });
    if (error) {
        ({ data, error } = await getClient().from('entry_logs')
            .select('id, watched_on, started_on, is_rewatch, created_at').eq('entry_id', entryId)
            .order('watched_on', { ascending: false, nullsFirst: false }));
    }
    if (error) throw error;
    return (data || []).filter((r) => !r.episode_id); // per-episode rows live in the Diary tab, not in this title's log
}
async function addEntryLog(session, { entryId, watchedOn, startedOn, isRewatch }) {
    requireUserId(session);
    const { data, error } = await getClient().from('entry_logs')
        .insert({ entry_id: entryId, watched_on: watchedOn || null, started_on: startedOn || null, is_rewatch: !!isRewatch })
        .select('id, watched_on, started_on, is_rewatch, created_at').single();
    if (error) throw error;
    return data;
}
async function deleteEntryLog(session, logId) {
    requireUserId(session);
    const { error } = await getClient().from('entry_logs').delete().eq('id', logId);
    if (error) throw error;
}

async function followUser(session, userId) {
    const me = requireUserId(session);
    const { error } = await getClient().from('user_follows').insert({ follower_id: me, followee_id: userId });
    if (error && error.code !== '23505') throw error;
}
async function unfollowUser(session, userId) {
    const me = requireUserId(session);
    const { error } = await getClient().from('user_follows').delete().eq('follower_id', me).eq('followee_id', userId);
    if (error) throw error;
}
// Decorates a list of profile rows with follower/following counts and whether I follow them.
async function decorateMembers(session, rows) {
    if (!rows.length) return [];
    const me = requireUserId(session);
    const ids = rows.map((r) => r.id);
    const c = getClient();
    const [a, b] = await Promise.all([
        c.from('user_follows').select('follower_id, followee_id').in('followee_id', ids),
        c.from('user_follows').select('follower_id, followee_id').in('follower_id', ids),
    ]);
    const followers = {}; const following = {}; const iFollow = new Set();
    for (const r of a.data || []) { followers[r.followee_id] = (followers[r.followee_id] || 0) + 1; if (r.follower_id === me) iFollow.add(r.followee_id); }
    for (const r of b.data || []) following[r.follower_id] = (following[r.follower_id] || 0) + 1;
    let officialIds = new Set();
    try {
        const { data: off } = await c.from('lists').select('user_id').eq('is_official', true).in('user_id', ids);
        officialIds = new Set((off || []).map((r) => r.user_id));
    } catch { /* ignore */ }
    return rows.map((r) => ({ ...r, is_official: officialIds.has(r.id), display_name: officialIds.has(r.id) ? 'Official Lists' : r.display_name, followers: followers[r.id] || 0, following: following[r.id] || 0, i_follow: iFollow.has(r.id) }));
}
// kind: 'following' (people I follow) | 'followers' (people who follow me)
async function listNetwork(session, kind) {
    const me = requireUserId(session);
    const c = getClient();
    const col = kind === 'following' ? 'follower_id' : 'followee_id';
    const other = kind === 'following' ? 'followee_id' : 'follower_id';
    const { data, error } = await c.from('user_follows').select(`${other}, created_at`).eq(col, me).order('created_at', { ascending: false });
    if (error) return [];
    const ids = data.map((r) => r[other]);
    if (!ids.length) return [];
    const { data: profs } = await c.from('profiles').select('id, display_name, avatar_url, avatar_color').in('id', ids);
    const byId = Object.fromEntries((profs || []).map((p) => [p.id, p]));
    return decorateMembers(session, ids.map((id) => byId[id] || { id, display_name: 'Member' }));
}
async function searchMembers(session, query) {
    const me = requireUserId(session);
    const q = String(query || '').trim();
    if (q.length < 2) return [];
    const { data, error } = await getClient().from('profiles')
        .select('id, display_name, avatar_url, avatar_color').ilike('display_name', `%${q.replace(/[%_]/g, '')}%`).neq('id', me).limit(20);
    if (error) throw error;
    return decorateMembers(session, data || []);
}
async function listLikedLists(session) {
    const me = requireUserId(session);
    const { data, error } = await getClient().from('list_likes').select('list_id').eq('user_id', me);
    if (error || !data.length) return [];
    const { data: lists } = await getClient().from('lists')
        .select('id, name, description, is_ranked, visibility, user_id, created_at, updated_at')
        .in('id', data.map((r) => r.list_id));
    return attachListCounts(lists || []);
}

async function listMyLists(session) {
    const userId = requireUserId(session);
    await ensureFavoritesList(userId);
    const { data, error } = await getClient()
        .from('lists')
        .select('id, name, description, genres, is_ranked, visibility, is_official, is_favorites, created_at, updated_at')
        .eq('user_id', userId)
        .eq('is_official', false)
        .order('updated_at', { ascending: false });
    if (error) throw error;
    return attachListSocial(session, await attachListCounts(data));
}

// Which of the user's own lists already contain this title — powers the
// Spotify-style "Add to list" checklist on the detail page.
async function listsContainingMedia(session, mediaId) {
    const userId = requireUserId(session);
    const { data, error } = await getClient()
        .from('list_items')
        .select('list_id, lists!inner(user_id)')
        .eq('media_id', mediaId)
        .eq('lists.user_id', userId);
    if (error) throw error;
    return data.map((r) => r.list_id);
}

// The public "Official Lists" account's lists — visible to every signed-in user.
async function listOfficialPublicLists(session) {
    const userId = requireUserId(session);
    const { data, error } = await getClient()
        .from('lists')
        .select('id, name, description, genres, is_ranked, visibility, is_official, created_at, updated_at, user_id')
        .eq('is_official', true)
        .order('created_at', { ascending: true });
    if (error) throw error;
    const withSocial = await attachListSocial(session, await attachListCounts(data));
    return withSocial.map((l) => ({ ...l, owner_name: 'Official Lists', is_mine: l.user_id === userId }));
}

async function listSharedWithMe(session) {
    const userId = requireUserId(session);
    const { data: shares, error } = await getClient()
        .from('list_shares')
        .select('lists(id, name, description, genres, is_ranked, visibility, is_official, created_at, updated_at, user_id)')
        .eq('shared_with_user_id', userId);
    if (error) throw error;
    const lists = shares.map((s) => s.lists).filter(Boolean);
    if (lists.length === 0) return [];
    const ownerIds = [...new Set(lists.map((l) => l.user_id))];
    const { data: owners } = await getClient().from('profiles').select('id, display_name').in('id', ownerIds);
    const ownerNameById = Object.fromEntries((owners || []).map((o) => [o.id, o.display_name]));
    const withCounts = await attachListCounts(lists);
    const withSocial = await attachListSocial(session, withCounts);
    return withSocial.map((l) => ({ ...l, owner_name: ownerNameById[l.user_id] || 'Someone' }));
}

async function getList(session, listId) {
    const userId = requireUserId(session);
    const { data: list, error } = await getClient()
        .from('lists').select('id, name, description, genres, is_ranked, visibility, is_official, is_favorites, created_at, updated_at, user_id').eq('id', listId).single();
    if (error) throw error;

    // Owner's name/avatar for the "List by ..." header — fetched for both
    // the owner's own lists and ones shared with someone else, so the
    // header always has something to show.
    const { data: ownerProfile } = await getClient()
        .from('profiles').select('display_name, avatar_url, avatar_color').eq('id', list.user_id).maybeSingle();

    // Manual drag-to-reorder position is now the one true order — a ranked
    // list just additionally shows that order as numbered badges.
    const { data: itemRows, error: itemErr } = await getClient()
        .from('list_items').select('id, media_id, added_at, position, note, show_on_profile').eq('list_id', listId).order('position', { ascending: true });
    if (itemErr) throw itemErr;

    let items = [];
    let watchedCount = 0;
    if (itemRows.length) {
        const mediaIds = itemRows.map((r) => r.media_id);
        const { data: mediaRows, error: mediaErr } = await getClient()
            .from('media').select('id, tmdb_id, media_type, title, poster_path, backdrop_path, overview, release_date, genres').in('id', mediaIds);
        if (mediaErr) throw mediaErr;
        const mediaById = Object.fromEntries(mediaRows.map((m) => [m.id, m]));

        // Cross-reference this user's own entries so each row can show
        // whether they've actually watched/read/played it already.
        const { data: entryRows } = await getClient()
            .from('entries').select('media_id, status').eq('user_id', userId).in('media_id', mediaIds);
        const statusByMediaId = Object.fromEntries((entryRows || []).map((e) => [e.media_id, e.status]));

        items = itemRows
            .map((r) => ({
                ...mediaById[r.media_id],
                added_at: r.added_at,
                position: r.position,
                note: r.note || '',
                show_on_profile: r.show_on_profile !== false,
                status: statusByMediaId[r.media_id] || null,
                watched: statusByMediaId[r.media_id] === 'completed' || statusByMediaId[r.media_id] === 'rewatched',
            }))
            .filter((it) => it.id); // drops any item whose media row vanished
        watchedCount = items.filter((it) => it.watched).length;
    }
    let likeCount = 0; let likedByMe = false;
    try {
        const { data: likeRows, error: likeErr } = await getClient().from('list_likes').select('user_id').eq('list_id', listId);
        if (likeErr) throw likeErr;
        likeCount = likeRows.length;
        likedByMe = likeRows.some((r) => r.user_id === userId);
    } catch (err) { console.error('list likes lookup failed (run the likes migration?):', err.message || err); }

    let cloneCount = 0;
    try {
        const { count } = await getClient().from('list_clones').select('id', { count: 'exact', head: true }).eq('list_id', listId);
        cloneCount = count || 0;
    } catch { /* run list-social-migration.sql */ }
    return {
        ...list,
        like_count: likeCount,
        liked_by_me: likedByMe,
        clone_count: cloneCount,
        isOwner: list.user_id === userId,
        items,
        watchedCount,
        owner_name: list.is_official ? 'Official Lists' : (ownerProfile?.display_name || null),
        owner_avatar_url: list.is_official ? null : (ownerProfile?.avatar_url || null),
        owner_avatar_color: ownerProfile?.avatar_color || null,
    };
}

async function addListItem(listId, mediaId) {
    const { data: lastRow } = await getClient()
        .from('list_items').select('position').eq('list_id', listId).order('position', { ascending: false }).limit(1).maybeSingle();
    const nextPosition = (lastRow?.position ?? 0) + 1;
    const { error } = await getClient()
        .from('list_items').upsert({ list_id: listId, media_id: mediaId, position: nextPosition }, { onConflict: 'list_id,media_id' });
    if (error) throw error;
    await touchList(listId);
}

async function removeListItem(listId, mediaId) {
    const { error } = await getClient().from('list_items').delete().eq('list_id', listId).eq('media_id', mediaId);
    if (error) throw error;
    await touchList(listId);
}

async function setListItemNote(listId, mediaId, note) {
    const { error } = await getClient()
        .from('list_items').update({ note: note?.trim() || null }).eq('list_id', listId).eq('media_id', mediaId);
    if (error) throw error;
    await touchList(listId);
}

// Persists a drag-and-drop reorder — mediaIdsInOrder is the full new order,
// top to bottom. Small lists in practice, so one UPDATE per row is fine.
async function reorderListItems(listId, mediaIdsInOrder) {
    const results = await Promise.all(mediaIdsInOrder.map((mediaId, i) =>
        getClient().from('list_items').update({ position: i + 1 }).eq('list_id', listId).eq('media_id', mediaId)
    ));
    const firstError = results.find((r) => r.error)?.error;
    if (firstError) throw firstError;
    await touchList(listId);
}

// Like / unlike — one row per (list, user), so toggling is just insert or
// delete. Returns the fresh state so the UI doesn't need a second fetch.
async function toggleListLike(session, listId) {
    const userId = requireUserId(session);
    const { data: existing, error: findErr } = await getClient()
        .from('list_likes').select('list_id').eq('list_id', listId).eq('user_id', userId).maybeSingle();
    if (findErr) throw findErr;
    if (existing) {
        const { error } = await getClient().from('list_likes').delete().eq('list_id', listId).eq('user_id', userId);
        if (error) throw error;
    } else {
        const { error } = await getClient().from('list_likes').insert({ list_id: listId, user_id: userId });
        if (error) throw error;
    }
    const { count, error: countErr } = await getClient()
        .from('list_likes').select('list_id', { count: 'exact', head: true }).eq('list_id', listId);
    if (countErr) throw countErr;
    return { liked: !existing, count: count || 0 };
}

// ---- cloning, visibility toggle, comments ----

async function cloneList(session, listId) {
    const userId = requireUserId(session);
    const { data: src, error: srcErr } = await getClient()
        .from('lists').select('id, name, description, genres, is_ranked').eq('id', listId).single();
    if (srcErr) throw srcErr;
    const { data: srcItems, error: itemsErr } = await getClient()
        .from('list_items').select('media_id, position, note').eq('list_id', listId).order('position', { ascending: true });
    if (itemsErr) throw itemsErr;

    const created = await createList(session, {
        name: src.name, description: src.description, genres: src.genres, isRanked: src.is_ranked, visibility: 'private',
    });
    if (srcItems.length) {
        const rows = srcItems.map((it) => ({ list_id: created.id, media_id: it.media_id, position: it.position, note: it.note }));
        const { error } = await getClient().from('list_items').insert(rows);
        if (error) throw error;
    }
    try {
        await getClient().from('list_clones').insert({ list_id: listId, cloner_id: userId, new_list_id: created.id });
    } catch (err) { console.error('recording clone failed (run list-social-migration.sql?):', err.message || err); }
    return created;
}

async function setListVisibility(listId, visibility) {
    const { error } = await getClient().from('lists').update({ visibility }).eq('id', listId);
    if (error) throw error;
}

async function listComments(session, listId) {
    const userId = requireUserId(session);
    const { data: rows, error } = await getClient()
        .from('list_comments').select('id, user_id, parent_id, body, created_at')
        .eq('list_id', listId).order('created_at', { ascending: true });
    if (error) throw error;
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const userIds = [...new Set(rows.map((r) => r.user_id))];
    const likeCount = {}; const likedByMe = new Set();
    try {
        const { data } = await getClient().from('list_comment_likes').select('comment_id, user_id').in('comment_id', ids);
        for (const l of data || []) {
            likeCount[l.comment_id] = (likeCount[l.comment_id] || 0) + 1;
            if (l.user_id === userId) likedByMe.add(l.comment_id);
        }
    } catch { /* ignore */ }
    const profileById = {};
    try {
        const { data } = await getClient().from('profiles').select('id, display_name, avatar_url, avatar_color').in('id', userIds);
        for (const p of data || []) profileById[p.id] = p;
    } catch { /* ignore */ }
    return rows.map((r) => ({
        ...r,
        author_name: profileById[r.user_id]?.display_name || 'Someone',
        author_avatar_url: profileById[r.user_id]?.avatar_url || null,
        author_avatar_color: profileById[r.user_id]?.avatar_color || null,
        like_count: likeCount[r.id] || 0,
        liked_by_me: likedByMe.has(r.id),
        is_mine: r.user_id === userId,
    }));
}

async function isListThreadMuted(session, listId) {
    const userId = requireUserId(session);
    const { data, error } = await getClient()
        .from('list_comment_mutes').select('list_id').eq('list_id', listId).eq('user_id', userId).maybeSingle();
    if (error) throw error;
    return Boolean(data);
}

async function toggleListThreadMute(session, listId) {
    const userId = requireUserId(session);
    const muted = await isListThreadMuted(session, listId);
    if (muted) {
        const { error } = await getClient().from('list_comment_mutes').delete().eq('list_id', listId).eq('user_id', userId);
        if (error) throw error;
    } else {
        const { error } = await getClient().from('list_comment_mutes').insert({ list_id: listId, user_id: userId });
        if (error) throw error;
    }
    return !muted;
}

async function addListComment(session, listId, body, parentId) {
    const userId = requireUserId(session);
    const text = (body || '').trim().slice(0, 1000);
    if (!text) throw new Error('Write something first');
    const { error } = await getClient()
        .from('list_comments').insert({ list_id: listId, user_id: userId, parent_id: parentId || null, body: text });
    if (error) throw error;
}

async function toggleCommentLike(session, commentId) {
    const userId = requireUserId(session);
    const { data: existing, error: findErr } = await getClient()
        .from('list_comment_likes').select('comment_id').eq('comment_id', commentId).eq('user_id', userId).maybeSingle();
    if (findErr) throw findErr;
    if (existing) {
        const { error } = await getClient().from('list_comment_likes').delete().eq('comment_id', commentId).eq('user_id', userId);
        if (error) throw error;
    } else {
        const { error } = await getClient().from('list_comment_likes').insert({ comment_id: commentId, user_id: userId });
        if (error) throw error;
    }
}

async function deleteListComment(commentId) {
    const { error } = await getClient().from('list_comments').delete().eq('id', commentId);
    if (error) throw error;
}


// The user's own manual ordering of their lists (Lists page, "Sort by List
// Order"). Kept in its own per-user table rather than a column on `lists`, so
// reordering never touches lists.updated_at — "When Updated" stays truthful.
async function reorderMyLists(session, listIdsInOrder) {
    const userId = requireUserId(session);
    if (!listIdsInOrder.length) return;
    const rows = listIdsInOrder.map((listId, i) => ({ user_id: userId, list_id: listId, position: i + 1 }));
    const { error } = await getClient().from('list_order').upsert(rows, { onConflict: 'user_id,list_id' });
    if (error) throw error;
}

// Sharing is scoped to family members — the only real "people you know"
// relationship this app has (see the family feature); there's no separate
// friends/followers system to pick from.
async function shareList(listId, targetUserId) {
    const { error } = await getClient()
        .from('list_shares').upsert({ list_id: listId, shared_with_user_id: targetUserId }, { onConflict: 'list_id,shared_with_user_id' });
    if (error) throw error;
}

async function unshareList(listId, targetUserId) {
    const { error } = await getClient().from('list_shares').delete().eq('list_id', listId).eq('shared_with_user_id', targetUserId);
    if (error) throw error;
}

async function listListShares(listId) {
    const { data, error } = await getClient().from('list_shares').select('shared_with_user_id').eq('list_id', listId);
    if (error) throw error;
    if (!data.length) return [];
    const ids = data.map((r) => r.shared_with_user_id);
    const { data: profiles } = await getClient().from('profiles').select('id, display_name').in('id', ids);
    return data.map((r) => ({
        user_id: r.shared_with_user_id,
        display_name: profiles?.find((p) => p.id === r.shared_with_user_id)?.display_name || 'Unknown',
    }));
}

module.exports = {
    getEntryLogCounts,
    followStudio, unfollowStudio, isFollowingStudio, listFollowedStudios,
    listEntryLogs, addEntryLog, deleteEntryLog,
    getActivityExtras,
    getTvWatchLog,
    listEpisodeLogs,
    getFollowState,
    followUser, unfollowUser, listNetwork, searchMembers, listLikedLists,
    getFollowCounts,
    getFavoritesOrder,
    setListItemProfileVisible,
    isOfficialAdmin,
    addOfficialListItem,
    init,
    getClient,
    signUp,
    signIn,
    signOut,
    getSession,
    updateEmail,
    updatePassword,
    listFamilyAccounts,
    switchFamilyAccount,
    removeFamilyAccount,
    renameFamilyAccount,
    followPerson,
    unfollowPerson,
    isFollowingPerson,
    listFollowedPeople,
    getProfile,
    upsertProfile,
    uploadAvatar,
    inviteToFamily,
    revokeFamilyInvite,
    listMyFamily,
    createFamily,
    renameFamily,
    listPendingInvitesForMe,
    acceptFamilyInvite,
    declineFamilyInvite,
    removeFamilyMember,
    createList,
    renameList,
    deleteList,
    listMyLists,
    listSharedWithMe,
    listsContainingMedia,
    getList,
    addListItem,
    removeListItem,
    setListItemNote,
    reorderListItems,
    shareList,
    unshareList,
    listListShares,
    toggleListLike,
    cloneList,
    getMediaFacets,
    listOfficialLists,
    listOfficialPublicLists,
    setListVisibility,
    listComments,
    isListThreadMuted,
    toggleListThreadMute,
    addListComment,
    toggleCommentLike,
    deleteListComment,
    reorderMyLists,
    upsertMedia,
    upsertSeasonMeta,
    getSeasonPosters,
    updateMediaEpisodeCounts,
    updateMediaRatings,
    getMediaRatingsCache,
    getMediaById,
    upsertEntry,
    getEntryForMedia,
    listEntries,
    deleteEntry,
    getStatusesForItems,
    upsertEpisodes,
    getEpisodes,
    toggleWatchedEpisode,
    getWatchedEpisodeIds,
    getUnlockedAchievements,
    getUnlockedCounts,
    setAchievementUnlocked,
    getLastWatchedSeason,
    getLastWatchedSeasons,
    listTrackedTvEntries,
    getWatchedEpisodeCounts,
};
