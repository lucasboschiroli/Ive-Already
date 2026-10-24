// Collection sizes for the Stats page (Complete / Almost Complete tabs).
// Separate from tmdb.js on purpose — same API key, same endpoint style.
const BASE_URL = 'https://api.themoviedb.org/3';
const cache = new Map(); // collection id -> { id, name, total, parts: [tmdb ids] }

async function fetchCollection(id) {
    if (cache.has(id)) return cache.get(id);
    const key = process.env.TMDB_API_KEY;
    if (!key) throw new Error('TMDB_API_KEY is not set');
    const res = await fetch(`${BASE_URL}/collection/${id}?api_key=${key}&language=en-US`);
    if (!res.ok) throw new Error(`TMDB ${res.status} for collection ${id}`);
    const data = await res.json();
    // Only parts with a release date count — announced-but-undated sequels aren't "watchable" yet.
    const parts = (data.parts || []).filter((p) => p.release_date);
    const out = { id, name: data.name, total: parts.length, parts: parts.map((p) => p.id),
        films: parts.map((p) => ({ id: p.id, title: p.title, release_date: p.release_date, poster_path: p.poster_path, genre_ids: p.genre_ids || [], popularity: p.popularity || 0 })).sort((a, b) => a.release_date.localeCompare(b.release_date)) };
    cache.set(id, out);
    return out;
}

async function getCollections(ids) {
    const unique = [...new Set(ids)];
    const result = {};
    let i = 0;
    const worker = async () => {
        while (i < unique.length) {
            const id = unique[i++];
            try { result[id] = await fetchCollection(id); } catch (err) { console.error(err.message); }
        }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    return result;
}

module.exports = { getCollections };
