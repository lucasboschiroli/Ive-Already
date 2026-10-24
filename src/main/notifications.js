// New / upcoming releases from the people and studios you follow (for the notification bell).
const { tmdbGet } = require('./studios');

const cache = { at: 0, key: '', items: [] };
const iso = (d) => d.toISOString().slice(0, 10);

async function pool(list, n, fn) {
    const out = [];
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
        while (i < list.length) { const x = list[i++]; try { out.push(await fn(x)); } catch { /* skip */ } }
    }));
    return out.flat().filter(Boolean);
}

async function getReleaseNotifications(people, studios, library = { tvIds: [], collections: [], ownedMovies: [] }) {
    const key = JSON.stringify([people.map((p) => p.tmdb_person_id), studios.map((s) => `${s.kind}${s.tmdb_id}`), library.tvIds, library.collections]);
    if (cache.key === key && Date.now() - cache.at < 30 * 60 * 1000) return cache.items;
    const now = new Date();
    const from = iso(new Date(now.getTime() - 45 * 864e5)), to = iso(new Date(now.getTime() + 150 * 864e5)), today = iso(now);
    const inWindow = (d) => d && d >= from && d <= to;
    const found = new Map(); // "movie:123" -> notification
    const add = (n) => {
        const k = n.key || `${n.media_type}:${n.tmdb_id}`;
        const ex = found.get(k);
        if (ex) { if (!ex.sources.includes(n.source)) ex.sources.push(n.source); return; }
        found.set(k, { id: `rel:${k}`, type: 'release', tmdb_id: n.tmdb_id, media_type: n.media_type, title: n.title, date: n.date,
            upcoming: n.date > today, poster_path: n.poster_path || null, sources: [n.source], role: n.role });
    };

    // Authors (negative ids, Open Library) have no release dates to watch, so they're skipped here.
    people = people.filter((p) => p.tmdb_person_id > 0);
    studios = studios.filter((s) => s.kind !== 'publisher' && s.kind !== 'developer' && s.kind !== 'gpublisher'); // publishers have no release dates to watch
    await pool(people, 5, async (p) => {
        const d = await tmdbGet(`/person/${p.tmdb_person_id}`, { append_to_response: 'combined_credits' });
        const dep = d.known_for_department;
        const cc = d.combined_credits || { cast: [], crew: [] };
        const mk = (c, role) => {
            const date = c.release_date || c.first_air_date || '';
            if (!inWindow(date) || !c.poster_path) return;
            add({ tmdb_id: c.id, media_type: c.media_type === 'tv' ? 'tv' : 'movie', title: c.title || c.name, date, poster_path: c.poster_path, source: d.name, role });
        };
        if (dep === 'Acting') {
            (cc.cast || []).filter((c) => (c.order ?? 99) <= 9 && !/self|himself|herself|narrator/i.test(c.character || '')).forEach((c) => mk(c, d.gender === 1 ? 'Actress' : 'Actor'));
        } else {
            (cc.crew || []).filter((c) => ['Director', 'Writer', 'Screenplay', 'Creator'].includes(c.job)).forEach((c) => mk(c, c.job === 'Director' ? 'Director' : 'Writer'));
        }
    });

    // Shows you've watched: a new season premiering (or just premiered).
    await pool(library.tvIds, 6, async (tvId) => {
        const d = await tmdbGet(`/tv/${tvId}`);
        (d.seasons || []).filter((se) => se.season_number >= 2 && inWindow(se.air_date)).forEach((se) => {
            add({ key: `tv:${tvId}:s${se.season_number}`, tmdb_id: tvId, media_type: 'tv', title: `${d.name} — Season ${se.season_number}`,
                date: se.air_date, poster_path: se.poster_path || d.poster_path, source: 'New season', role: 'From your library' });
        });
        // Weekly shows: the next episode about to air (within 2 weeks) and ones that just aired (last 10 days).
        const ago = (n) => iso(new Date(now.getTime() - n * 864e5)), ahead = (n) => iso(new Date(now.getTime() + n * 864e5));
        const ep = (e, upcoming) => {
            if (!e || !e.air_date || e.episode_number === 1) return; // premieres are covered by the season alert
            if (upcoming ? (e.air_date < today || e.air_date > ahead(14)) : (e.air_date < ago(10) || e.air_date > today)) return;
            add({ key: `tv:${tvId}:s${e.season_number}e${e.episode_number}`, tmdb_id: tvId, media_type: 'tv',
                title: `${d.name} — S${e.season_number}E${e.episode_number}${e.name ? ` · ${e.name}` : ''}`,
                date: e.air_date, poster_path: d.poster_path, source: 'New episode', role: 'From your library' });
        };
        ep(d.next_episode_to_air, true);
        ep(d.last_episode_to_air, false);
    });
    // Films you've watched: a sequel / next part of the same collection you don't have yet.
    const owned = new Set(library.ownedMovies);
    await pool(library.collections, 6, async (colId) => {
        const c = await tmdbGet(`/collection/${colId}`);
        (c.parts || []).filter((m) => !owned.has(m.id) && inWindow(m.release_date) && m.poster_path).forEach((m) => {
            add({ tmdb_id: m.id, media_type: 'movie', title: m.title, date: m.release_date, poster_path: m.poster_path, source: c.name, role: 'Sequel' });
        });
    });

    await pool(studios, 4, async (st) => {
        const isNet = st.kind === 'network';
        const r = isNet
            ? await tmdbGet('/discover/tv', { with_networks: st.tmdb_id, 'first_air_date.gte': from, 'first_air_date.lte': to, sort_by: 'popularity.desc' })
            : await tmdbGet('/discover/movie', { with_companies: st.tmdb_id, 'primary_release_date.gte': from, 'primary_release_date.lte': to, sort_by: 'popularity.desc' });
        (r.results || []).slice(0, 4).forEach((c) => {
            const date = c.release_date || c.first_air_date || '';
            if (!inWindow(date) || !c.poster_path) return;
            add({ tmdb_id: c.id, media_type: isNet ? 'tv' : 'movie', title: c.title || c.name, date, poster_path: c.poster_path, source: st.name, role: 'Studio' });
        });
    });

    const items = [...found.values()].sort((a, b) => (a.upcoming === b.upcoming ? (a.upcoming ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)) : (a.upcoming ? -1 : 1))).slice(0, 60);
    cache.key = key; cache.at = Date.now(); cache.items = items;
    return items;
}

module.exports = { getReleaseNotifications };
