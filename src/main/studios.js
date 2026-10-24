// Curated "famous" studios/networks for a title, plus studio pages (TMDB companies & networks).
const BASE_URL = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/';
const cache = new Map();

async function tmdbGet(path, params = {}) {
    const key = process.env.TMDB_API_KEY;
    if (!key) throw new Error('TMDB_API_KEY is not set');
    const url = new URL(`${BASE_URL}${path}`);
    url.searchParams.set('api_key', key);
    url.searchParams.set('language', 'en-US');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const ck = url.toString();
    if (cache.has(ck)) return cache.get(ck);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TMDB ${res.status} for ${path}`);
    const data = await res.json();
    cache.set(ck, data);
    return data;
}

// Ordered by how well-known they are. `parent` = the group that owns the label (shown first as "Disney, Pixar").
const DISNEY = { kind: 'company', id: 2, name: 'Walt Disney Pictures' };
const WARNER = { kind: 'company', id: 174, name: 'Warner Bros. Pictures' };
const UNIVERSAL = { kind: 'company', id: 33, name: 'Universal Pictures' };
const FAMOUS = [
    { re: /^a24$/i, label: 'A24' },
    { re: /^neon($|\b)/i, label: 'Neon' },
    { re: /^pixar/i, parent: DISNEY },
    { re: /^marvel studios/i, parent: DISNEY },
    { re: /^lucasfilm/i, parent: DISNEY },
    { re: /^walt disney animation/i, parent: DISNEY },
    { re: /^walt disney pictures/i },
    { re: /^20th century (studios|fox)/i },
    { re: /^searchlight/i },
    { re: /^dc (studios|films|entertainment)/i, parent: WARNER },
    { re: /^new line cinema/i, parent: WARNER },
    { re: /^warner bros/i },
    { re: /^illumination/i, parent: UNIVERSAL },
    { re: /^universal pictures/i },
    { re: /^focus features/i },
    { re: /^dreamworks animation/i },
    { re: /^dreamworks pictures/i },
    { re: /^paramount/i },
    { re: /^columbia pictures/i },
    { re: /^sony pictures/i },
    { re: /^metro-goldwyn-mayer|^mgm/i },
    { re: /^lionsgate/i },
    { re: /^legendary/i },
    { re: /^blumhouse/i },
    { re: /^amblin/i },
    { re: /^studio ghibli/i },
    { re: /^miramax/i },
    { re: /^hbo|^home box office/i },
    { re: /^netflix/i },
    { re: /^apple (tv|studios|original)/i },
    { re: /^amazon (studios|mgm|prime)/i },
    { re: /^fx\b|^fx productions/i },
    { re: /^bbc/i },
];
const FAMOUS_NETWORKS = [
    /^netflix$/i, /^hbo$/i, /^max$/i, /^hulu$/i, /^disney\+/i, /^apple tv/i, /^prime video|^amazon/i, /^amc$/i, /^fx$/i,
    /^showtime$/i, /^paramount\+/i, /^peacock$/i, /^bbc/i, /^adult swim$/i, /^cartoon network$/i, /^nickelodeon$/i,
    /^abc$/i, /^nbc$/i, /^cbs$/i, /^fox$/i, /^the cw$/i, /^starz$/i, /^crunchyroll$/i, /^itv/i, /^channel 4$/i,
];

function ent(kind, c) { return { kind, id: c.id, name: c.name, logo_path: c.logo_path || null }; }

async function getTitleStudios(tmdbId, mediaType) {
    const d = await tmdbGet(`/${mediaType === 'tv' ? 'tv' : 'movie'}/${tmdbId}`);
    const companies = d.production_companies || [];
    const out = [];
    const has = (e) => out.some((x) => x.kind === e.kind && x.id === e.id);
    const add = (e) => { if (e && !has(e) && out.length < 2) out.push(e); };

    if (mediaType === 'tv') {
        const nets = d.networks || [];
        const net = nets.find((n) => FAMOUS_NETWORKS.some((re) => re.test(n.name))) || nets[0];
        if (net) add(ent('network', net));
    }
    // best-known label among the title's production companies
    let best = null;
    for (let i = 0; i < FAMOUS.length && !best; i++) {
        const c = companies.find((x) => FAMOUS[i].re.test(x.name));
        if (c) best = { rule: FAMOUS[i], c };
    }
    if (best) {
        if (out.length === 0 && best.rule.parent) {
            const p = companies.find((x) => x.id === best.rule.parent.id);
            add(p ? ent('company', p) : { ...best.rule.parent, logo_path: null });
        }
        add(ent('company', best.c));
        // a second famous label if we still have room (e.g. A24 + a co-producer)
        if (out.length < 2) {
            for (const rule of FAMOUS) {
                const c = companies.find((x) => rule.re.test(x.name) && x.id !== best.c.id);
                if (c) { add(ent('company', c)); break; }
            }
        }
    }
    if (out.length === 0 && companies[0]) add(ent('company', companies[0]));
    return out;
}

async function getStudio(kind, id) {
    const isNet = kind === 'network';
    const info = await tmdbGet(`/${isNet ? 'network' : 'company'}/${id}`);
    const pages = [1, 2, 3];
    const fetchAll = async (type) => {
        const param = isNet ? 'with_networks' : 'with_companies';
        const rs = await Promise.all(pages.map((page) => tmdbGet(`/discover/${type}`, { [param]: id, sort_by: 'popularity.desc', page }).catch(() => ({ results: [] }))));
        return rs.flatMap((r) => r.results || []).map((m) => ({
            tmdb_id: m.id, media_type: type, title: m.title || m.name || '',
            release_date: m.release_date || m.first_air_date || '', poster_path: m.poster_path || null,
            popularity: m.popularity || 0, vote_average: m.vote_average || 0,
        }));
    };
    const credits = [];
    if (!isNet) credits.push(...await fetchAll('movie'));
    credits.push(...await fetchAll('tv'));
    const seen = new Set();
    const uniq = credits.filter((c) => c.poster_path && !seen.has(`${c.media_type}:${c.tmdb_id}`) && seen.add(`${c.media_type}:${c.tmdb_id}`));
    uniq.sort((a, b) => b.popularity - a.popularity);
    return {
        kind, id: Number(id), name: info.name, description: info.description || '', headquarters: info.headquarters || '',
        homepage: info.homepage || '', origin_country: info.origin_country || '',
        logo_path: info.logo_path || null,
        parent: info.parent_company ? { kind: 'company', id: info.parent_company.id, name: info.parent_company.name } : null,
        credits: uniq,
    };
}

module.exports = { getTitleStudios, getStudio, tmdbGet, imgBase: IMG };
