// Open Library client (books + authors). No API key needed.
// Docs: https://openlibrary.org/developers/api
//
// Everything is mapped onto the same shapes the TMDB client returns, so the rest
// of the app (search, detail page, person pages, lists, stats) treats a book like
// any other title:
//   - book id   -> tmdb_id = the number in the work key (OL45804W -> 45804), media_type 'book'
//   - author id -> NEGATIVE number (OL23919A -> -23919) so it can never collide with a TMDB person id
//   - posters   -> full cover URLs stored in poster_path (see imageUrl in tmdb.js)

const { matchPublishers } = require('./publishers');
const BASE = 'https://openlibrary.org';
const COVERS = 'https://covers.openlibrary.org';
const HEADERS = { 'User-Agent': 'IveAlready/0.1 (personal media tracker)', Accept: 'application/json' };

async function olGet(path, params = {}) {
    const url = new URL(`${BASE}${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
        const res = await fetch(url.toString(), { headers: HEADERS, signal: ctrl.signal });
        if (!res.ok) throw new Error(`Open Library ${res.status} — ${path}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

const workKey = (n) => `OL${n}W`;
const authorKey = (n) => `OL${Math.abs(n)}A`;
const numOf = (key) => { const m = /OL(\d+)[WA]/.exec(key || ''); return m ? Number(m[1]) : null; };
const coverUrl = (coverId) => (coverId ? `${COVERS}/b/id/${coverId}-M.jpg` : null);
const photoUrl = (photoId) => (photoId && photoId > 0 ? `${COVERS}/a/id/${photoId}-M.jpg` : null);
const textOf = (v) => (typeof v === 'string' ? v : v?.value || '');
// Open Library descriptions are user-edited markdown: strip the markup, source credits and
// "Also contained in..." tails so only the actual synopsis is left.
function cleanDescription(raw) {
    let t = textOf(raw);
    if (!t) return '';
    t = t.split(/\r?\n\s*-{3,}/)[0];                       // everything after a ---- rule is edition notes
    t = t.replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, '$1');   // [text](url) -> text
    t = t.replace(/\(\s*Source:[^)]*\)/gi, '');                    // "(Source: Wikipedia)"
    t = t.replace(/\[([^\]]+)\]\[\d*\]/g, '$1');                  // [text][1] -> text
    t = t.replace(/^\s*\[\d+\]:.*$/gm, '');                          // reference definitions
    t = t.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2').replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1$2');
    t = t.replace(/<[^>]+>/g, '').replace(/^#+\s*/gm, '');
    t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ');
    return t.trim();
}

// Open Library sometimes files a work or author under its original script (Ὀδύσσεια, Ὅμηρος).
// Prefer the Latin-script name people actually use.
const isLatin = (t) => !/[^\u0000-\u024F\u1E00-\u1EFF\u2000-\u206F]/.test(t || '');
function latinAuthorName(name, rec) {
    if (isLatin(name)) return name;
    const alts = [rec?.personal_name, ...(rec?.alternate_names || [])].filter((n) => typeof n === 'string' && isLatin(n));
    return alts.sort((a, b) => a.length - b.length)[0] || name;
}
async function latinWorkTitle(key, current) {
    if (isLatin(current)) return current;
    try {
        const ed = await olGet(`/works/${key}/editions.json`, { limit: 50 });
        const counts = {};
        for (const e of ed.entries || []) {
            const t = (e.title || '').trim();
            if (t && isLatin(t) && t.length < 80) counts[t] = (counts[t] || 0) + 1;
        }
        const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        if (best) return best[0];
    } catch { /* keep original */ }
    return current;
}
const yearDate = (y) => (y ? `${y}-01-01` : null);
// OL ratings are 1-5; the app's scale is 0-10.
const rate10 = (r) => (typeof r === 'number' ? Math.round(r * 20) / 10 : null);

const SEARCH_FIELDS = 'key,first_sentence,title,author_name,author_key,first_publish_year,cover_i,edition_count,ratings_average,ratings_count,number_of_pages_median,subject,publisher';

function bookFromDoc(d) {
    const id = numOf(d.key);
    if (!id) return null;
    return {
        tmdb_id: id,
        media_type: 'book',
        title: d.title,
        release_date: yearDate(d.first_publish_year),
        poster_path: coverUrl(d.cover_i),
        overview: null,
        vote_average: rate10(d.ratings_average),
        genre_ids: [],
        popularity: d.edition_count || 0,
        creator: d.author_name?.length
            ? { label: 'Written by', people: d.author_name.slice(0, 2).map((name, i) => ({ id: d.author_key?.[i] ? -numOf(`${d.author_key[i]}`) : 0, name })).filter((p) => p.id) }
            : null,
    };
}

async function searchBooks(query, limit = 10, page = 1, extra = {}) {
    const data = await olGet('/search.json', { q: query || undefined, ...extra, limit, page, fields: SEARCH_FIELDS });
    const results = (data.docs || []).map(bookFromDoc).filter(Boolean);
    return { results, total: data.numFound || results.length };
}

async function searchAuthors(query, limit = 3) {
    const data = await olGet('/search/authors.json', { q: query, limit });
    return (data.docs || [])
        .map((a) => {
            const id = numOf(a.key);
            if (!id) return null;
            return {
                tmdb_id: -id,
                media_type: 'person',
                title: a.name,
                poster_path: `${COVERS}/a/olid/${a.key}-M.jpg?default=false`,
                department: 'Author',
                popularity: a.work_count || 0,
            };
        })
        .filter(Boolean);
}

async function getBookDetails(id) {
    const key = workKey(id);
    const [work, found] = await Promise.all([
        olGet(`/works/${key}.json`),
        olGet('/search.json', { q: `key:/works/${key}`, limit: 1, fields: SEARCH_FIELDS }).catch(() => ({ docs: [] })),
    ]);
    const doc = (found.docs || [])[0] || {};
    const authorKeys = (work.authors || []).map((a) => numOf(a.author?.key)).filter(Boolean);
    const names = doc.author_name || [];
    // Prefer the search doc's names (already resolved); fall back to fetching author records.
    let creators = [];
    if (doc.author_key?.length && names.length) {
        creators = doc.author_key.slice(0, 4).map((k, i) => ({ id: -numOf(k), name: names[i] || 'Unknown', profile_path: null }));
    }
    if (!creators.length && authorKeys.length) {
        creators = (await Promise.all(authorKeys.slice(0, 4).map(async (n) => {
            try { const a = await olGet(`/authors/${authorKey(n)}.json`); return { id: -n, name: a.name, profile_path: null }; }
            catch { return null; }
        }))).filter(Boolean);
    }
    // Author portraits (one small request each).
    await Promise.all(creators.map(async (c) => {
        try {
            const a = await olGet(`/authors/${authorKey(c.id)}.json`);
            c.profile_path = photoUrl((a.photos || []).find((p) => p > 0));
            c.name = latinAuthorName(c.name, a);
        } catch { /* no portrait */ }
    }));

    const coverId = (work.covers || []).find((c) => c > 0) || doc.cover_i || null;
    const subjects = (doc.subject || work.subjects || []).filter((s) => typeof s === 'string' && s.length < 28).slice(0, 6);
    const year = doc.first_publish_year || (/\d{4}/.exec(work.first_publish_date || '') || [])[0] || null;
    const publishers = [...new Set((doc.publisher || []).filter((p) => p.length < 40))].slice(0, 3);

    // "Similar": other well-known books by the same first author.
    let similar = [];
    if (creators[0]) {
        try {
            const more = await olGet('/search.json', { q: `author_key:${authorKey(creators[0].id)}`, sort: 'editions', limit: 14, fields: SEARCH_FIELDS });
            similar = (more.docs || []).map(bookFromDoc).filter((b) => b && b.tmdb_id !== id && b.poster_path).slice(0, 12)
                .map((b) => ({ tmdb_id: b.tmdb_id, media_type: 'book', title: b.title, release_date: b.release_date, poster_path: b.poster_path }));
        } catch { /* optional */ }
    }

    const cover = coverId ? `${COVERS}/b/id/${coverId}-L.jpg` : null;
    const title = await latinWorkTitle(key, work.title || doc.title);
    return {
        tmdb_id: id,
        imdb_id: null,
        media_type: 'book',
        title,
        original_title: title,
        poster_path: cover,
        backdrop_path: cover,
        release_date: yearDate(year),
        overview: cleanDescription(work.description) || (doc.first_sentence ? cleanDescription(Array.isArray(doc.first_sentence) ? doc.first_sentence[0] : doc.first_sentence) : ''),
        original_language: null,
        runtime: null,
        episode_runtime: null,
        year_range: null,
        certification: null,
        number_of_seasons: null,
        is_limited_series: false,
        number_of_episodes: null,
        aired_episode_count: null,
        page_count: doc.number_of_pages_median || null,
        genres: JSON.stringify(subjects),
        tmdb_vote_average: rate10(doc.ratings_average),
        trailer_key: null,
        networks: [],
        studios: publishers,
        publisher_links: matchPublishers(doc.publisher),
        creators,
        writers: [],
        watch_providers: {},
        cast: [],
        seasons: null,
        related: [],
        similar,
        raw_json: JSON.stringify({ source: 'openlibrary', work, doc, creators }),
    };
}

async function getAuthorDetails(negId) {
    const key = authorKey(negId);
    const [a, works] = await Promise.all([
        olGet(`/authors/${key}.json`),
        olGet('/search.json', { q: `author_key:${key}`, sort: 'editions', limit: 60, fields: SEARCH_FIELDS }),
    ]);
    const seen = new Set();
    const credits = (works.docs || []).map(bookFromDoc).filter((b) => {
        if (!b || !b.poster_path) return false;
        const t = (b.title || '').toLowerCase();
        if (seen.has(t)) return false;
        seen.add(t);
        return true;
    }).map((b) => ({
        tmdb_id: b.tmdb_id,
        media_type: 'book',
        title: b.title,
        role: null,
        section: 'Books',
        release_date: b.release_date,
        poster_path: b.poster_path,
        popularity: b.popularity,
        vote_average: b.vote_average || 0,
    }));
    const born = a.birth_date ? String(a.birth_date) : null;
    return {
        id: negId,
        name: latinAuthorName(a.name, a),
        biography: cleanDescription(a.bio) || (a.top_work ? `Known for ${a.top_work}.` : ''),
        profile_path: photoUrl((a.photos || []).find((p) => p > 0)),
        birthday: born && a.death_date ? `${born} – ${a.death_date}` : born,
        known_for_department: 'Books',
        credits,
    };
}

// ---- Matching a known title + author to an Open Library work (official lists, series covers) ----
const normT = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^(the|a|an) /, '');

async function findBook(title, creator, year, alts = []) {
    const wanted = [title, ...alts].map(normT);
    const checkAuthor = creator && !/^anonymous$/i.test(creator);
    const tokens = checkAuthor ? normT(creator).split(' ').filter((t) => t.length > 2) : [];
    const authorOk = (r) => !tokens.length || (r.creator?.people || []).some((p) => tokens.some((t) => normT(p.name).includes(t)));
    const yr = (r) => (year && r.release_date ? Math.abs(Number(r.release_date.slice(0, 4)) - year) : 0);
    const byPopularity = (a, b) => (b.popularity || 0) - (a.popularity || 0);
    const attempts = [];
    if (checkAuthor) attempts.push({ q: '', extra: { title, author: creator } });
    attempts.push({ q: checkAuthor ? `${title} ${creator}` : title, extra: {} });
    attempts.push({ q: '', extra: { title } });
    const seen = [];
    for (const a of attempts) {
        let results = [];
        try { results = (await searchBooks(a.q, 20, 1, a.extra)).results; } catch { continue; }
        seen.push(...results);
        const exact = results.filter((r) => wanted.includes(normT(r.title)) && authorOk(r));
        const loose = results.filter((r) => !exact.includes(r) && authorOk(r) && wanted.some((w) => normT(r.title).startsWith(`${w} `)));
        for (const pool of [exact, loose]) {
            if (!pool.length) continue;
            const near = pool.filter((r) => yr(r) <= 3);
            return (near.length ? near : pool).sort(byPopularity)[0];
        }
    }
    // Translated classics list their author under many spellings; if nothing matched by author,
    // trust a heavily-published exact title.
    const anyExact = seen.filter((r) => wanted.includes(normT(r.title))).sort(byPopularity)[0];
    if (anyExact && ((anyExact.popularity || 0) >= 40 || (year && year < 1900) || !year)) return anyExact;
    return null;
}

const seriesCache = new Map();
async function lookupSeries(series) {
    if (seriesCache.has(series.id)) return seriesCache.get(series.id);
    const out = new Array(series.books.length);
    let i = 0;
    const worker = async () => {
        while (i < series.books.length) {
            const idx = i++;
            const b = series.books[idx];
            let hit = null;
            try { hit = await findBook(b.title, series.author, b.year, b.alt); } catch { /* leave unmatched */ }
            out[idx] = { title: b.title, year: b.year, id: hit ? hit.tmdb_id : 0, poster_path: hit ? hit.poster_path : null };
        }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    seriesCache.set(series.id, out);
    return out;
}

module.exports = { searchBooks, searchAuthors, getBookDetails, getAuthorDetails, findBook, lookupSeries };
