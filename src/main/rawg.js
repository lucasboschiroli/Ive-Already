// RAWG client (video games). Free key: https://rawg.io/apidocs  ->  RAWG_API_KEY in .env
// Games are mapped onto the same shapes as TMDB titles, media_type 'game', tmdb_id = the RAWG game id.
// RAWG only has landscape art, so the cover is the game's main image (cropped to the poster frame).

const BASE = 'https://api.rawg.io/api';

async function rawgGet(path, params = {}) {
    const key = process.env.RAWG_API_KEY;
    if (!key) throw new Error('RAWG_API_KEY is not set. Get a free key at https://rawg.io/apidocs and add it to .env');
    const url = new URL(`${BASE}${path}`);
    url.searchParams.set('key', key);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
        const res = await fetch(url.toString(), { signal: ctrl.signal });
        if (!res.ok) throw new Error(`RAWG ${res.status} — ${path}`);
        return await res.json();
    } finally { clearTimeout(timer); }
}

const rate10 = (r) => (typeof r === 'number' && r > 0 ? Math.round(r * 20) / 10 : null); // RAWG rates 0-5
const asDate = (d) => (d && /^\d{4}(-\d{2}-\d{2})?$/.test(d) ? (d.length === 4 ? `${d}-01-01` : d) : null);

function gameFromRow(g) {
    return {
        tmdb_id: g.id,
        media_type: 'game',
        title: g.name,
        release_date: asDate(g.released),
        poster_path: g.background_image || null,
        overview: null,
        vote_average: rate10(g.rating),
        genre_ids: [],
        popularity: g.added || g.ratings_count || 0,
        creator: null,
    };
}

async function searchGames(query, limit = 10, page = 1) {
    const data = await rawgGet('/games', { search: query, search_precise: 'true', page_size: limit, page });
    return { results: (data.results || []).map(gameFromRow), total: data.count || 0 };
}

// RAWG has no portrait art. For games sold on Steam, Steam's own 600x900 library cover is a true
// portrait; it's used when it exists, otherwise the landscape image stays.
async function steamPortrait(id) {
    try {
        const stores = await rawgGet(`/games/${id}/stores`);
        const steam = (stores.results || []).find((x) => /store\.steampowered\.com\/app\/(\d+)/.test(x.url || ''));
        const appid = steam && /app\/(\d+)/.exec(steam.url)[1];
        if (!appid) return null;
        for (const base of ['https://cdn.akamai.steamstatic.com/steam/apps', 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps']) {
            const url = `${base}/${appid}/library_600x900.jpg`;
            try {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), 5000);
                const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
                clearTimeout(t);
                if (res.ok) return url;
            } catch { /* try next */ }
        }
    } catch { /* no stores listed */ }
    return null;
}

async function getGameDetails(id) {
    const [g, series, portrait] = await Promise.all([
        rawgGet(`/games/${id}`),
        rawgGet(`/games/${id}/game-series`, { page_size: 12 }).catch(() => ({ results: [] })),
        steamPortrait(id),
    ]);
    const developers = (g.developers || []).map((d) => ({ id: d.id, name: d.name, image: d.image_background || null }));
    const publishers = (g.publishers || []).map((d) => ({ id: d.id, name: d.name, image: d.image_background || null }));
    const platforms = (g.platforms || []).map((p) => p.platform?.name).filter(Boolean);
    const genres = (g.genres || []).map((x) => x.name);
    const similar = (series.results || []).filter((s) => s.background_image).map((s) => ({
        tmdb_id: s.id, media_type: 'game', title: s.name, release_date: asDate(s.released), poster_path: s.background_image,
    }));
    return {
        tmdb_id: g.id,
        imdb_id: null,
        media_type: 'game',
        title: g.name,
        original_title: g.name_original || g.name,
        poster_path: portrait || g.background_image || null,
        backdrop_path: g.background_image_additional || g.background_image || null,
        release_date: asDate(g.released),
        overview: (g.description_raw || '').trim(),
        original_language: null,
        runtime: null,
        episode_runtime: null,
        year_range: null,
        certification: g.esrb_rating?.name || null,
        number_of_seasons: null,
        is_limited_series: false,
        number_of_episodes: null,
        aired_episode_count: null,
        page_count: null,
        playtime_hours: g.playtime || null,
        metacritic: g.metacritic || null,
        platforms,
        achievements_count: g.achievements_count || 0,
        genres: JSON.stringify(genres),
        tmdb_vote_average: rate10(g.rating),
        trailer_key: null,
        networks: [],
        studios: developers.map((d) => d.name),
        publisher_links: developers.map((d) => ({ kind: 'developer', id: d.id, name: d.name })),
        publishers_list: publishers.map((d) => ({ kind: 'gpublisher', id: d.id, name: d.name })),
        creators: [],
        writers: [],
        watch_providers: {},
        cast: [],
        seasons: null,
        related: [],
        similar,
        raw_json: JSON.stringify({ source: 'rawg', developers, publishers, platforms, metacritic: g.metacritic || null, playtime: g.playtime || null }),
    };
}

async function getAchievements(id) {
    const out = [];
    let page = 1;
    while (page <= 3) {
        const data = await rawgGet(`/games/${id}/achievements`, { page_size: 40, page });
        for (const a of data.results || []) {
            out.push({ id: a.id, name: a.name, description: (a.description || '').replace(/<[^>]+>/g, ''), image: a.image || null, percent: Number(a.percent) || null });
        }
        if (!data.next) break;
        page++;
    }
    // Most common (highest unlock rate) first, rarest last.
    out.sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1));
    return out;
}

const stripHtml = (t) => String(t || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();

// RAWG has no company logos, only background art. Wikidata usually has the real logo (P154).
const logoCache = new Map();
async function companyLogo(name) {
    if (logoCache.has(name)) return logoCache.get(name);
    let url = null;
    try {
        const WD = 'https://www.wikidata.org/w/api.php';
        const hdr = { headers: { 'User-Agent': 'IveAlready/0.1 (personal media tracker)' } };
        const found = await (await fetch(`${WD}?action=wbsearchentities&format=json&origin=*&language=en&type=item&limit=6&search=${encodeURIComponent(name)}`, hdr)).json();
        const cands = (found.search || []).filter((c) => c.label && c.label.toLowerCase() === name.toLowerCase());
        const likely = (c) => /video game|game (developer|publisher|studio|company)|software|entertainment|studio/i.test(c.description || '');
        const ordered = [...cands.filter(likely), ...cands.filter((c) => !likely(c))].slice(0, 3);
        if (ordered.length) {
            const ents = await (await fetch(`${WD}?action=wbgetentities&format=json&origin=*&props=claims&ids=${ordered.map((c) => c.id).join('|')}`, hdr)).json();
            for (const c of ordered) {
                const claim = (((ents.entities || {})[c.id] || {}).claims || {}).P154;
                const file = claim && claim[0] && claim[0].mainsnak && claim[0].mainsnak.datavalue && claim[0].mainsnak.datavalue.value;
                if (file) { url = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=400`; break; }
            }
        }
    } catch { /* no logo */ }
    logoCache.set(name, url);
    return url;
}

// Developer / publisher pages: kind 'developer' or 'gpublisher' (RAWG keeps separate id spaces).
async function getCompany(kind, id) {
    const isDev = kind === 'developer';
    const info = await rawgGet(`/${isDev ? 'developers' : 'publishers'}/${id}`);
    const [logo, games] = await Promise.all([
        companyLogo(info.name),
        rawgGet('/games', { [isDev ? 'developers' : 'publishers']: id, ordering: '-added', page_size: 40 }),
    ]);
    return {
        kind, id: Number(id), name: info.name, description: stripHtml(info.description), headquarters: '', homepage: '', origin_country: '',
        logo_path: logo || info.image_background || null, parent: null,
        credits: (games.results || []).map((g) => ({
            tmdb_id: g.id, media_type: 'game', title: g.name, release_date: asDate(g.released) || '',
            poster_path: g.background_image || null, popularity: g.added || 0, vote_average: rate10(g.rating) || 0,
        })),
    };
}

const normT = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^(the|a|an) /, '');

// Match a known title + release year to a RAWG game (official lists).
async function findGame(title, year) {
    const want = normT(title);
    const data = await rawgGet('/games', { search: title, search_precise: 'true', page_size: 20 });
    const rows = (data.results || []).map(gameFromRow);
    const exact = rows.filter((r) => normT(r.title) === want);
    const yr = (r) => (year && r.release_date ? Math.abs(Number(r.release_date.slice(0, 4)) - year) : 0);
    const near = exact.filter((r) => yr(r) <= 1);
    const pool = near.length ? near : exact;
    return pool.sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0] || null;
}

// Which other games belong to the same series (RAWG "game-series"), cached per game.
const seriesCache = new Map();
async function getSeriesFor(ids) {
    const out = {};
    let i = 0;
    const todo = [...new Set(ids)];
    const worker = async () => {
        while (i < todo.length) {
            const id = todo[i++];
            if (!seriesCache.has(id)) {
                try {
                    const d = await rawgGet(`/games/${id}/game-series`, { page_size: 40 });
                    seriesCache.set(id, (d.results || []).map((g) => ({ id: g.id, name: g.name, released: asDate(g.released), image: g.background_image || null })));
                } catch { seriesCache.set(id, []); }
            }
            out[id] = seriesCache.get(id);
        }
    };
    await Promise.all(Array.from({ length: 5 }, worker));
    return out;
}

const achCountCache = new Map();
async function achievementCount(id) {
    if (!achCountCache.has(id)) {
        try { achCountCache.set(id, (await getAchievements(id)).length); } catch { return 0; }
    }
    return achCountCache.get(id);
}

module.exports = { achievementCount, searchGames, getGameDetails, getAchievements, getCompany, findGame, getSeriesFor };
