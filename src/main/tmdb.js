// TMDB API client.
// Docs: https://developer.themoviedb.org/reference/intro/getting-started
// Attribution required by TMDB's terms: the UI must show the TMDB logo and
// "This product uses the TMDB API but is not endorsed or certified by TMDB."
// (see src/renderer — footer credit)

const BASE_URL = 'https://api.themoviedb.org/3';
const IMAGE_BASE_URL = 'https://image.tmdb.org/t/p';

function getApiKey() {
    const key = process.env.TMDB_API_KEY;
    if (!key) {
        throw new Error(
            'TMDB_API_KEY is not set. Copy .env.example to .env and add your key from https://www.themoviedb.org/settings/api'
        );
    }
    return key;
}

async function tmdbFetch(endpoint, params = {}) {
    const url = new URL(`${BASE_URL}${endpoint}`);
    url.searchParams.set('api_key', getApiKey());
    url.searchParams.set('language', 'en-US');
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }

    const res = await fetch(url.toString());
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`TMDB ${res.status} ${res.statusText} — ${endpoint} — ${body}`);
    }
    return res.json();
}

// posterPath is what TMDB returns as e.g. "/abc123.jpg"; size is one of
// w92, w154, w185, w342, w500, w780, original
function imageUrl(path, size = 'w500') {
    if (!path) return null;
    // Books/authors (Open Library): poster_path already holds a full cover URL.
    if (/^https?:/.test(path)) {
        const big = ['w342', 'w500', 'w780', 'w1280', 'original'].includes(size);
        return path.replace(/-([SML])\.jpg/, big ? '-L.jpg' : '-M.jpg');
    }
    return `${IMAGE_BASE_URL}/${size}${path}`;
}

async function search(query, mediaType = 'multi', year = null) {
    // mediaType: 'movie' | 'tv' | 'multi' — 'multi' also includes people
    // (directors, actors, etc.), not just titles.
    const endpoint = mediaType === 'multi' ? '/search/multi' : `/search/${mediaType}`;
    // A release year narrows short/ambiguous titles (e.g. "Z") down to the right film or show.
    const yearParam = year && mediaType === 'movie' ? { year } : year && mediaType === 'tv' ? { first_air_date_year: year } : {};
    const data = await tmdbFetch(endpoint, { query, include_adult: false, ...yearParam });
    return (data.results || [])
        .filter((r) => mediaType !== 'multi' || r.media_type === 'movie' || r.media_type === 'tv' || r.media_type === 'person')
        .map(normalizeSearchResult);
}

// Director/creator + (for TV) a running year range for one search result.
// Movies: director only lives in the credits sub-resource (crew,
// job="Director"). TV: creators aren't in credits at all — they're a
// top-level `created_by` field on the main /tv endpoint, which also has
// last_air_date/status, letting us build "2011–2016" or "2011–Present" in
// the same request rather than a separate one. Non-fatal: a title with no
// credit info just shows no line, and a TV title without a resolvable
// range falls back to the first-air-date year.
async function enrichSearchResult(item) {
    if (item.media_type === 'person') return {};
    if (item.media_type === 'movie') {
        try {
            const data = await tmdbFetch(`/movie/${item.tmdb_id}/credits`);
            const director = (data.crew || []).find((c) => c.job === 'Director');
            return { creator: director ? { label: 'Directed by', people: [{ id: director.id, name: director.name }] } : null };
        } catch {
            return { creator: null };
        }
    }
    try {
        const data = await tmdbFetch(`/tv/${item.tmdb_id}`);
        const people = (data.created_by || []).map((c) => ({ id: c.id, name: c.name }));
        const startYear = (item.release_date || '').slice(0, 4);
        const endYear = (data.last_air_date || '').slice(0, 4);
        const ongoing = Boolean(data.in_production) && data.status !== 'Ended' && data.status !== 'Canceled';
        let yearRange = startYear || null;
        if (startYear && ongoing) yearRange = `${startYear}–Present`;
        else if (startYear && endYear && endYear !== startYear) yearRange = `${startYear}–${endYear}`;
        return {
            creator: people.length ? { label: 'Created by', people } : null,
            yearRange,
        };
    } catch {
        return { creator: null };
    }
}

// Full search-results page — same results as search(), plus director/
// creator (and TV year range) per title, and real pagination metadata from
// TMDB. The per-title enrichment is one extra request per result (run in
// parallel), which is fine for a results page but too slow for the
// live-typing dropdown — that one still uses the plain search() above.
async function searchFull(query, mediaType = 'multi', page = 1) {
    const endpoint = mediaType === 'multi' ? '/search/multi' : `/search/${mediaType}`;
    const data = await tmdbFetch(endpoint, { query, include_adult: false, page });
    const results = (data.results || [])
        .filter((r) => mediaType !== 'multi' || r.media_type === 'movie' || r.media_type === 'tv' || r.media_type === 'person')
        .map(normalizeSearchResult);
    const enriched = await Promise.all(results.map(async (r) => ({ ...r, ...(await enrichSearchResult(r)) })));
    return {
        results: enriched,
        page: data.page || 1,
        totalPages: Math.min(data.total_pages || 1, 500), // TMDB caps pagination at 500 regardless of true total
        totalResults: data.total_results || enriched.length,
    };
}

function normalizeSearchResult(r) {
    const mediaType = r.media_type || (r.first_air_date ? 'tv' : 'movie');
    if (mediaType === 'person') {
        return {
            tmdb_id: r.id,
            media_type: 'person',
            title: r.name,
            poster_path: r.profile_path, // same field name as movie/tv so the UI doesn't need a special case for the image
            department: r.known_for_department || null,
            popularity: r.popularity || 0,
        };
    }
    return {
        tmdb_id: r.id,
        media_type: mediaType,
        title: r.title || r.name,
        release_date: r.release_date || r.first_air_date || null,
        poster_path: r.poster_path,
        overview: r.overview,
        vote_average: r.vote_average,
        genre_ids: r.genre_ids || [],
        popularity: r.popularity || 0,
    };
}

// Watch-provider (JustWatch) data is licensed per-country by TMDB. There's no
// good way to auto-detect "the right" region for a desktop app without asking
// the person, so this defaults to US (TMDB's most complete region) — override
// via TMDB_WATCH_REGION in .env if you want a different one.
const WATCH_REGION = process.env.TMDB_WATCH_REGION || 'US';

async function getMovieDetails(tmdbId) {
    const data = await tmdbFetch(`/movie/${tmdbId}`, { append_to_response: 'videos,credits,watch/providers,recommendations,release_dates,external_ids' });
    const details = normalizeDetails(data, 'movie');
    // "Related" — other entries in the same franchise/collection (e.g. Toy
    // Story 2/3/4 for Toy Story). TMDB only models this for movies; there's
    // no equivalent collection concept for TV, so `related` stays empty there.
    details.related = [];
    if (data.belongs_to_collection) {
        try {
            const collection = await tmdbFetch(`/collection/${data.belongs_to_collection.id}`);
            details.related = (collection.parts || [])
                .filter((p) => p.id !== tmdbId)
                .sort((a, b) => (a.release_date || '').localeCompare(b.release_date || ''))
                .map((p) => normalizeRelatedItem(p, 'movie'));
        } catch (err) {
            // Non-fatal — the rest of the page still works without it.
            console.error(`Failed to fetch collection ${data.belongs_to_collection.id}:`, err);
        }
    }
    return details;
}

async function getTvDetails(tmdbId) {
    const data = await tmdbFetch(`/tv/${tmdbId}`, { append_to_response: 'videos,credits,watch/providers,recommendations,content_ratings,external_ids' });
    const details = normalizeDetails(data, 'tv');
    details.related = [];
    return details;
}

function normalizeWatchProviders(d) {
    const region = d['watch/providers']?.results?.[WATCH_REGION];
    if (!region) return { link: null, flatrate: [], rent: [], buy: [] };
    const mapProviders = (list) => (list || []).map((p) => ({
        name: p.provider_name,
        logo_path: p.logo_path,
    }));
    return {
        link: region.link || null,
        flatrate: mapProviders(region.flatrate),
        rent: mapProviders(region.rent),
        buy: mapProviders(region.buy),
    };
}

// Content rating ("TV-MA", "PG-13", etc.) — like watch providers, this is
// region-specific in TMDB's data, so it reuses the same WATCH_REGION.
// Movies: buried in release_dates.results[region].release_dates[].certification
// (often several release-date entries per region — theatrical, digital,
// etc. — so this takes the first one that actually has a certification).
// TV: content_ratings.results[region].rating, much flatter.
function extractCertification(d, mediaType) {
    if (mediaType === 'movie') {
        const region = (d.release_dates?.results || []).find((r) => r.iso_3166_1 === WATCH_REGION);
        const withCert = (region?.release_dates || []).find((rd) => rd.certification);
        return withCert?.certification || null;
    }
    const region = (d.content_ratings?.results || []).find((r) => r.iso_3166_1 === WATCH_REGION);
    return region?.rating || null;
}

// "1999–2007" (ended) or "1999–Present" (still airing) — movies don't have
// a range concept, so this only applies to TV.
function computeYearRange(d, mediaType) {
    if (mediaType !== 'tv') return null;
    const startYear = (d.first_air_date || '').slice(0, 4);
    if (!startYear) return null;
    const endYear = (d.last_air_date || '').slice(0, 4);
    const ongoing = Boolean(d.in_production) && d.status !== 'Ended' && d.status !== 'Canceled';
    if (ongoing) return `${startYear}–Present`;
    if (endYear && endYear !== startYear) return `${startYear}–${endYear}`;
    return startYear;
}

// TMDB adds a season's full episode list (with future air_dates) as soon as
// it's announced — well before any of it actually airs. `number_of_episodes`
// counts all of those right away, so comparing watched count against it
// falsely looks like "new episodes" the moment a season is announced, not
// when it actually starts airing. `last_episode_to_air` is TMDB's own
// guarantee of what has actually aired, so: every earlier season counts in
// full (already aired, done), plus however far into that last-aired
// episode's season we've gotten. No new fetch needed — this is on the same
// /tv/{id} response already being read for everything else.
function airedEpisodeCount(d) {
    const last = d.last_episode_to_air;
    // Season 0 is TMDB's "Specials" bucket — behind-the-scenes/extras, not
    // part of the numbered season progression. The app's own season picker
    // (numberedSeasons, in renderer.js) already filters these out entirely,
    // so counting them here just inflates the total past what's actually
    // navigable/checkable in the UI.
    if (!last || last.season_number <= 0) return 0;
    const priorSeasonsTotal = (d.seasons || [])
        .filter((s) => s.season_number != null && s.season_number > 0 && s.season_number < last.season_number)
        .reduce((sum, s) => sum + (s.episode_count || 0), 0);
    return priorSeasonsTotal + (last.episode_number || 0);
}

function normalizeDetails(d, mediaType) {
    const trailer = (d.videos?.results || []).find(
        (v) => v.site === 'YouTube' && v.type === 'Trailer'
    );
    const creators = mediaType === 'tv'
        ? (d.created_by || []).map((c) => ({ id: c.id, name: c.name, profile_path: c.profile_path }))
        : (d.credits?.crew || [])
            .filter((c) => c.job === 'Director')
            .map((c) => ({ id: c.id, name: c.name, profile_path: c.profile_path }));

    // Writers: dedupe by person id since someone can hold multiple writing
    // credits (e.g. "Screenplay" + "Story") on the same title.
    const writerJobs = new Set(['Writer', 'Screenplay', 'Story', 'Teleplay']);
    const seenWriterIds = new Set();
    const writers = (d.credits?.crew || [])
        .filter((c) => writerJobs.has(c.job))
        .filter((c) => (seenWriterIds.has(c.id) ? false : (seenWriterIds.add(c.id), true)))
        .map((c) => ({ id: c.id, name: c.name, profile_path: c.profile_path }));

    return {
        tmdb_id: d.id,
        imdb_id: d.imdb_id || d.external_ids?.imdb_id || null,
        media_type: mediaType,
        title: d.title || d.name,
        original_title: d.original_title || d.original_name,
        poster_path: d.poster_path,
        backdrop_path: d.backdrop_path,
        release_date: d.release_date || d.first_air_date || null,
        overview: d.overview,
        original_language: d.original_language || null,
        runtime: mediaType === 'movie' ? d.runtime ?? null : null,
        episode_runtime: mediaType === 'tv' ? (d.episode_run_time && d.episode_run_time[0]) || null : null,
        year_range: computeYearRange(d, mediaType),
        certification: extractCertification(d, mediaType),
        number_of_seasons: mediaType === 'tv' ? d.number_of_seasons ?? null : null,
        // TMDB's own classification (e.g. "Scripted" vs "Miniseries") —
        // authoritative source for the "Limited Series" label, rather than
        // guessing from season/episode counts.
        is_limited_series: mediaType === 'tv' && d.type === 'Miniseries',
        number_of_episodes: mediaType === 'tv' ? d.number_of_episodes ?? null : null,
        // Episodes actually aired so far — see airedEpisodeCount() above.
        // This (not number_of_episodes) is what "new episodes available"
        // and "every episode watched" checks should compare against.
        aired_episode_count: mediaType === 'tv' ? airedEpisodeCount(d) : null,
        genres: JSON.stringify((d.genres || []).map((g) => g.name)),
        tmdb_vote_average: d.vote_average ?? null,
        trailer_key: trailer ? trailer.key : null,
        networks: mediaType === 'tv' ? (d.networks || []).map((n) => n.name) : [],
        studios: (d.production_companies || []).map((c) => c.name),
        creators,
        writers,
        watch_providers: normalizeWatchProviders(d),
        cast: (d.credits?.cast || []).slice(0, 12).map((c) => ({
            id: c.id,
            name: c.name,
            character: c.character,
            profile_path: c.profile_path,
        })),
        seasons: mediaType === 'tv' ? (d.seasons || []).map((s) => ({
            season_number: s.season_number,
            episode_count: s.episode_count,
            name: s.name,
            poster_path: s.poster_path,
        })) : null,
        // "Similar" — TMDB's recommendation engine (genres/keywords/audience
        // overlap), same media type as the title being viewed.
        similar: (d.recommendations?.results || []).slice(0, 12).map((r) => normalizeRelatedItem(r, mediaType)),
        raw_json: JSON.stringify(d),
    };
}

// Shared shape for both "related" (collection parts) and "similar"
// (recommendations) items — just enough to render a poster tile.
function normalizeRelatedItem(r, mediaType) {
    return {
        tmdb_id: r.id,
        media_type: mediaType,
        title: r.title || r.name,
        release_date: r.release_date || r.first_air_date || null,
        poster_path: r.poster_path,
    };
}

async function getPersonDetails(personId) {
    const d = await tmdbFetch(`/person/${personId}`, { append_to_response: 'combined_credits' });

    const mapCredit = (c, role, section) => ({
        tmdb_id: c.id,
        media_type: c.media_type,
        title: c.title || c.name,
        role: role || null,
        section,
        release_date: c.release_date || c.first_air_date || null,
        poster_path: c.poster_path,
        popularity: c.popularity || 0,
        vote_average: c.vote_average || 0,
    });

    // Talk-show/award-show cameos ("Self", "Self - Guest", "Self (uncredited)"
    // etc.) get their own section rather than mixed into "Acting" — the
    // *show* (Tonight Show, WWHL...) is a long-running series with its own
    // high TMDB popularity score regardless of this one appearance, so they'd
    // otherwise crowd out someone's actual acclaimed work when sorted by
    // popularity. Real self-portrayals in scripted work (biopics etc.) keep
    // a real character name, not literally "Self", so this stays narrow.
    const isSelfAppearance = (character) => /^self\b/i.test((character || '').trim());

    const castCredits = (d.combined_credits?.cast || [])
        .filter((c) => c.poster_path)
        .map((c) => mapCredit(c, c.character, isSelfAppearance(c.character) ? 'As Themselves' : 'Acting'));

    // Group crew work into a few recognizable buckets rather than TMDB's
    // full department list — anything outside these three (Editing, Sound,
    // Camera, etc.) is uncommon enough on a person page to just bucket
    // together rather than fragment into a dozen tiny one-item sections.
    const crewCredits = (d.combined_credits?.crew || [])
        .filter((c) => c.poster_path)
        .map((c) => {
            let section = 'Crew';
            if (c.department === 'Directing') section = 'Directing';
            else if (c.department === 'Writing') section = 'Writing';
            else if (c.department === 'Production') section = 'Production';
            return mapCredit(c, c.job, section);
        });

    // The same person can rack up multiple crew credits on one title (e.g.
    // Director + Writer both land in "Writing"/"Directing" separately, but
    // two "Writing" jobs like Screenplay + Story on the same film would
    // otherwise show as duplicate posters in the same section) — keep one
    // per title per section.
    const seen = new Set();
    const crewDeduped = crewCredits.filter((c) => {
        const key = `${c.section}:${c.media_type}:${c.tmdb_id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    // Sorted by popularity rather than release date — a director's page
    // should lead with their most notable work, not just their most recent.
    const credits = [...castCredits, ...crewDeduped]
        .sort((a, b) => b.popularity - a.popularity);

    return {
        id: d.id,
        name: d.name,
        biography: d.biography,
        profile_path: d.profile_path,
        birthday: d.birthday,
        known_for_department: d.known_for_department,
        credits,
    };
}

async function getTvSeasonEpisodes(tmdbId, seasonNumber) {
    const data = await tmdbFetch(`/tv/${tmdbId}/season/${seasonNumber}`);
    return (data.episodes || []).map((ep) => ({
        season_number: ep.season_number,
        episode_number: ep.episode_number,
        name: ep.name,
        air_date: ep.air_date,
    }));
}

// Lightweight — just the counts, for the background new-episodes check
// across a whole library. The full getTvDetails() pulls videos/credits/
// watch-providers/recommendations/content_ratings too, which is fine for
// one title's detail page but wasteful run in bulk.
// number_of_episodes here is the AIRED count (see airedEpisodeCount above),
// not TMDB's raw total — otherwise a show flips back to Watching the moment
// a season is announced, before anything in it has actually aired. Also
// returns number_of_seasons so the caller can refresh the cached media row
// immediately — otherwise that row (and any Continue Watching progress bar
// built from it) stays stale until the user happens to reopen the title's
// own page.
async function getTvEpisodeCount(tmdbId) {
    const data = await tmdbFetch(`/tv/${tmdbId}`);
    return {
        number_of_episodes: airedEpisodeCount(data),
        number_of_seasons: data.number_of_seasons ?? null,
        // Base /tv/{id} already includes this (no append_to_response
        // needed) — piggyback on the same request to keep season_meta
        // in sync for every tracked show, not just ones the user reopens.
        seasons: (data.seasons || []).map((s) => ({ season_number: s.season_number, name: s.name, poster_path: s.poster_path })),
    };
}

async function getBackdropPath(tmdbId, mediaType) {
    const d = await tmdbFetch(`/${mediaType === 'tv' ? 'tv' : 'movie'}/${tmdbId}`);
    return d.backdrop_path || null;
}

module.exports = {
    imageUrl,
    search,
    searchFull,
    getTvEpisodeCount,
    getMovieDetails,
    getTvDetails,
    getTvSeasonEpisodes,
    getPersonDetails,
    getBackdropPath,
};
