// Importers: Letterboxd export (ZIP or a single list CSV) and Steam library.
const zlib = require('zlib');
const tmdb = require('./tmdb');
const rawg = require('./rawg');
const sb = require('./supabase');

// ---------- tiny ZIP reader (stored + deflate) ----------
function unzip(buf) {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('That does not look like a ZIP file');
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    const files = {};
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) break;
        const method = buf.readUInt16LE(p + 10);
        const csize = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const cmtLen = buf.readUInt16LE(p + 32);
        const local = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
        p += 46 + nameLen + extraLen + cmtLen;
        if (name.endsWith('/')) continue;
        const lnLen = buf.readUInt16LE(local + 26);
        const leLen = buf.readUInt16LE(local + 28);
        const start = local + 30 + lnLen + leLen;
        const raw = buf.subarray(start, start + csize);
        files[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    }
    return files;
}

// ---------- CSV ----------
function parseCsv(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const rows = [];
    let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) {
            if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
            else cur += c;
        } else if (c === '"') q = true;
        else if (c === ',') { row.push(cur); cur = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(cur); cur = ''; rows.push(row); row = [];
        } else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
}
function csvObjects(text) {
    const rows = parseCsv(text).filter((r) => r.some((c) => c !== ''));
    if (!rows.length) return [];
    const head = rows[0].map((h) => h.trim());
    return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}
function parseListCsv(text, fallbackName) {
    const rows = parseCsv(text);
    const hi = rows.findIndex((r) => (r[0] || '').trim() === 'Position');
    let name = fallbackName, description = '';
    for (let i = 0; i < rows.length - 1 && (hi < 0 || i < hi); i++) {
        if ((rows[i][1] || '').trim() === 'Name' || rows[i].includes('Name') && rows[i].includes('Date')) {
            const h = rows[i].map((x) => x.trim()); const v = rows[i + 1] || [];
            if (v[h.indexOf('Name')]) name = v[h.indexOf('Name')].trim();
            description = (v[h.indexOf('Description')] || '').trim();
            break;
        }
    }
    const items = [];
    if (hi >= 0) {
        const h = rows[hi].map((x) => x.trim());
        for (const r of rows.slice(hi + 1)) {
            const nm = (r[h.indexOf('Name')] || '').trim();
            if (nm) items.push({ name: nm, year: Number(r[h.indexOf('Year')]) || 0 });
        }
    }
    return { name: name || 'Imported list', description, items };
}

// ---------- parse a Letterboxd upload ----------
const parsed = new Map(); // session user id -> parsed data
function parseLetterboxd(userId, name, bytes) {
    const buf = Buffer.from(bytes);
    const out = { films: new Map(), lists: [], hasData: false };
    const film = (n, y) => {
        const k = `${n}|${y}`;
        if (!out.films.has(k)) out.films.set(k, { name: n, year: Number(y) || 0, rating: null, watched: false, liked: false, watchlist: false, dates: [], review: '' });
        return out.films.get(k);
    };
    const isZip = buf.length > 3 && buf.readUInt32LE(0) === 0x04034b50;
    if (!isZip) {
        out.lists.push(parseListCsv(buf.toString('utf8'), name.replace(/\.csv$/i, '')));
    } else {
        const files = unzip(buf);
        const get = (re) => Object.entries(files).filter(([k]) => re.test(k.replace(/\\/g, '/')));
        const txt = (re) => { const f = get(re)[0]; return f ? f[1].toString('utf8') : ''; };
        for (const r of csvObjects(txt(/(^|\/)watched\.csv$/i))) { const f = film(r.Name, r.Year); f.watched = true; out.hasData = true; }
        for (const r of csvObjects(txt(/(^|\/)ratings\.csv$/i))) { const f = film(r.Name, r.Year); f.watched = true; f.rating = Number(r.Rating) || null; out.hasData = true; }
        for (const r of csvObjects(txt(/(^|\/)diary\.csv$/i))) {
            const f = film(r.Name, r.Year); f.watched = true;
            if (r.Rating) f.rating = Number(r.Rating) || f.rating;
            if (r['Watched Date']) f.dates.push({ date: r['Watched Date'], rewatch: /yes/i.test(r.Rewatch || '') });
            out.hasData = true;
        }
        for (const r of csvObjects(txt(/(^|\/)reviews\.csv$/i))) { const f = film(r.Name, r.Year); if (r.Review) f.review = r.Review; }
        for (const r of csvObjects(txt(/(^|\/)likes\/films\.csv$/i))) { film(r.Name, r.Year).liked = true; out.hasData = true; }
        for (const r of csvObjects(txt(/(^|\/)watchlist\.csv$/i))) { const f = film(r.Name, r.Year); f.watchlist = true; out.hasData = true; }
        for (const [k, v] of get(/(^|\/)lists\/.+\.csv$/i)) {
            const l = parseListCsv(v.toString('utf8'), k.split('/').pop().replace(/\.csv$/i, ''));
            if (l.items.length) out.lists.push(l);
        }
    }
    parsed.set(userId, out);
    const list = [...out.films.values()];
    return {
        lists: out.lists.map((l) => ({ name: l.name, count: l.items.length })),
        watched: list.filter((f) => f.watched).length,
        rated: list.filter((f) => f.rating).length,
        diary: list.reduce((t, f) => t + f.dates.length, 0),
        liked: list.filter((f) => f.liked).length,
        watchlist: list.filter((f) => f.watchlist).length,
    };
}

// ---------- shared helpers ----------
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
async function pool(items, n, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
    }));
}

const filmCache = new Map(); // "name|year" -> mediaId | null
async function filmMediaId(name, year) {
    const key = `${norm(name)}|${year}`;
    if (filmCache.has(key)) return filmCache.get(key);
    let pick = null;
    const want = norm(name);
    const yearOk = (r) => !year || Math.abs((Number((r.release_date || '').slice(0, 4)) || 0) - year) <= 1;
    const attempts = year ? [year, null] : [null];
    for (const y of attempts) {
        let res = [];
        try { res = await tmdb.search(name, 'movie', y); } catch { res = []; }
        pick = res.find((r) => norm(r.title) === want && yearOk(r))
            || res.find((r) => yearOk(r) && (norm(r.title).includes(want) || want.includes(norm(r.title))) && norm(r.title).length > 2);
        if (!pick && y && res[0] && yearOk(res[0]) && Math.abs((Number((res[0].release_date || '').slice(0, 4)) || 0) - year) === 0) pick = res[0];
        if (pick) break;
    }
    let id = null;
    if (pick) {
        const { data } = await sb.getClient().from('media').select('id').eq('tmdb_id', pick.tmdb_id).eq('media_type', 'movie').maybeSingle();
        id = data?.id || null;
        if (!id) id = await sb.upsertMedia(await tmdb.getMovieDetails(pick.tmdb_id));
    }
    filmCache.set(key, id);
    return id;
}

// ---------- run the Letterboxd import ----------
async function runLetterboxd(session, opts, send) {
    const data = parsed.get(session.user.id);
    if (!data) throw new Error('Nothing to import — choose the file again');
    const result = { lists: 0, entries: 0, logs: 0, failed: [] };
    const films = [...data.films.values()].filter((f) => (opts.diary && (f.watched || f.liked)) || (opts.watchlist && f.watchlist));
    const lists = opts.lists ? data.lists.filter((l) => !opts.listNames || opts.listNames.includes(l.name)) : [];
    const total = films.length + lists.reduce((t, l) => t + l.items.length, 0);
    let done = 0;
    const tick = (label) => { done++; send({ done, total, label }); };

    // Films / diary / watchlist
    await pool(films, 4, async (f) => {
        try {
            const mediaId = await filmMediaId(f.name, f.year);
            if (!mediaId) { result.failed.push(`${f.name} (${f.year})`); return; }
            const existing = await sb.getEntryForMedia(session, mediaId);
            const dates = f.dates.map((d) => d.date).sort();
            const fields = {};
            if (f.watched || f.liked) {
                if (!existing || existing.status === 'planned' || !existing.status) fields.status = 'completed';
                if (dates.length && !existing?.date_finished) fields.date_finished = dates[dates.length - 1];
                if (f.rating && !existing?.rating) fields.rating = f.rating * 2;
                else if (f.liked && !f.rating && !existing?.rating && !existing?.is_favorite) fields.is_favorite = true;
                if (f.review && !existing?.review) fields.review = f.review;
            } else if (f.watchlist && !existing) {
                fields.status = 'planned';
            }
            if (!Object.keys(fields).length && !(existing && dates.length)) { return; }
            const entry = Object.keys(fields).length ? await sb.upsertEntry(session, mediaId, fields) : existing;
            result.entries++;
            if (opts.diary && dates.length && entry?.id) {
                const have = new Set((await sb.listEntryLogs(session, entry.id)).map((l) => l.watched_on));
                for (const d of f.dates) {
                    if (have.has(d.date)) continue;
                    await sb.addEntryLog(session, { entryId: entry.id, watchedOn: d.date, isRewatch: d.rewatch });
                    result.logs++;
                }
            }
        } catch (err) {
            result.failed.push(`${f.name} (${f.year}) — ${err.message}`);
        } finally { tick(f.name); }
    });

    // Lists
    for (const l of lists) {
        try {
            const { data: found } = await sb.getClient().from('lists').select('id').eq('user_id', session.user.id).eq('name', l.name).limit(1);
            const list = found?.[0] || await sb.createList(session, { name: l.name, description: l.description, genres: [], isRanked: false, visibility: 'private' });
            const { data: have } = await sb.getClient().from('list_items').select('media_id').eq('list_id', list.id);
            const haveSet = new Set((have || []).map((r) => r.media_id));
            for (const it of l.items) {
                try {
                    const mediaId = await filmMediaId(it.name, it.year);
                    if (!mediaId) result.failed.push(`${it.name} (${it.year}) — in "${l.name}"`);
                    else if (!haveSet.has(mediaId)) { await sb.addListItem(list.id, mediaId); haveSet.add(mediaId); }
                } catch (err) { result.failed.push(`${it.name} — ${err.message}`); }
                tick(`${l.name}: ${it.name}`);
            }
            result.lists++;
        } catch (err) {
            result.failed.push(`List "${l.name}" — ${err.message}`);
            done += l.items.length;
        }
    }
    return result;
}

// ---------- Steam ----------
async function steamResolve(input) {
    const key = process.env.STEAM_API_KEY;
    if (!key) throw new Error('STEAM_API_KEY is not set. Get a free key at https://steamcommunity.com/dev/apikey and add it to .env');
    let s = String(input || '').trim();
    const m = s.match(/steamcommunity\.com\/(profiles|id)\/([^/?#]+)/i);
    if (m) s = m[2]; 
    if (/^\d{17}$/.test(s)) return { key, steamId: s };
    const r = await fetch(`https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${key}&vanityurl=${encodeURIComponent(s)}`);
    const j = await r.json();
    if (j?.response?.success !== 1) throw new Error('Steam profile not found');
    return { key, steamId: j.response.steamid };
}
async function steamLibrary(input) {
    const { key, steamId } = await steamResolve(input);
    const r = await fetch(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${key}&steamid=${steamId}&include_appinfo=1&include_played_free_games=1&format=json`);
    if (!r.ok) throw new Error(`Steam returned ${r.status}`);
    const j = await r.json();
    const games = j?.response?.games;
    if (!games) throw new Error('No games visible — set your Steam profile\'s "Game details" to Public and try again');
    return {
        steamId,
        games: games.map((g) => ({ appid: g.appid, name: g.name, hours: Math.round((g.playtime_forever || 0) / 6) / 10 }))
            .sort((a, b) => b.hours - a.hours),
    };
}
async function runSteam(session, { input, playedStatus, unplayed }, send) {
    const lib = await steamLibrary(input);
    const result = { added: 0, skipped: 0, failed: [] };
    const todo = lib.games.filter((g) => g.hours > 0 ? playedStatus !== 'skip' : unplayed);
    let done = 0;
    await pool(todo, 3, async (g) => {
        try {
            const hit = await rawg.findGame(g.name, 0);
            if (!hit) { result.failed.push(g.name); return; }
            const { data: found } = await sb.getClient().from('media').select('id').eq('tmdb_id', hit.tmdb_id).eq('media_type', 'game').maybeSingle();
            const mediaId = found?.id || await sb.upsertMedia(await rawg.getGameDetails(hit.tmdb_id));
            const existing = await sb.getEntryForMedia(session, mediaId);
            if (existing) { result.skipped++; return; }
            await sb.upsertEntry(session, mediaId, { status: g.hours > 0 ? playedStatus : 'planned' });
            result.added++;
        } catch (err) { result.failed.push(`${g.name} — ${err.message}`); }
        finally { done++; send({ done, total: todo.length, label: g.name }); }
    });
    return result;
}

module.exports = { parseLetterboxd, runLetterboxd, steamLibrary, runSteam, steamConfigured: () => !!process.env.STEAM_API_KEY };
