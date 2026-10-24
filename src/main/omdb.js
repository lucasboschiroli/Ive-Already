// OMDb (omdbapi.com) — the only practical free source for IMDb/Rotten
// Tomatoes numbers, since neither IMDb nor TMDB exposes them directly, and
// Rotten Tomatoes' own API has been closed to the public for years.
//
// Known limitation, not a bug: OMDb can only give us Rotten Tomatoes'
// Tomatometer (critics score) — the Popcornmeter (audience score) isn't in
// OMDb's data at all, because RT stopped publishing it through any API
// years ago. There's no free/legal way to get that number right now.
//
// Get a free key at http://www.omdbapi.com/apikey.aspx (1,000 requests/day
// on the free tier) and set OMDB_API_KEY in .env. Entirely optional — if
// the key isn't set, ratings are just skipped, nothing else breaks.

const OMDB_BASE = 'https://www.omdbapi.com/';

function getKey() {
    return process.env.OMDB_API_KEY || null;
}

async function getRatings(imdbId) {
    const key = getKey();
    if (!key || !imdbId) return null;

    const url = `${OMDB_BASE}?apikey=${encodeURIComponent(key)}&i=${encodeURIComponent(imdbId)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OMDb request failed: ${res.status}`);
    const data = await res.json();
    if (data.Response === 'False') return null;

    const rtEntry = (data.Ratings || []).find((r) => r.Source === 'Rotten Tomatoes');
    const tomatometer = rtEntry ? parseInt(rtEntry.Value, 10) : null;
    const imdbRating = data.imdbRating && data.imdbRating !== 'N/A' ? parseFloat(data.imdbRating) : null;

    return {
        imdb_rating: Number.isFinite(imdbRating) ? imdbRating : null,
        imdb_votes: data.imdbVotes && data.imdbVotes !== 'N/A' ? data.imdbVotes : null,
        rt_tomatometer: Number.isFinite(tomatometer) ? tomatometer : null,
        // e.g. "Won 1 Oscar. 55 wins & 149 nominations total." Free text,
        // OMDb's own summary — not something we can parse into structured
        // wins/nominations ourselves, so it's shown as-is.
        awards: data.Awards && data.Awards !== 'N/A' ? data.Awards : null,
    };
}

module.exports = { getRatings };
