// Author -> country (ISO alpha-2) for the Literature world map.
// Open Library author record -> Wikidata id -> country of citizenship (P27), falling back to the
// country of the birthplace (P19 -> P17). Results are cached on disk so each author is looked up once.
const fs = require('fs');
const path = require('path');

const OL = 'https://openlibrary.org';
const WD = 'https://www.wikidata.org/w/api.php';
const HEADERS = { 'User-Agent': 'IveAlready/0.1 (personal media tracker)', Accept: 'application/json' };

// Historical states Wikidata has no modern ISO code for.
const ALIAS = {
    'Russian Empire': 'RU', 'Soviet Union': 'RU', 'Tsardom of Russia': 'RU', 'Russian Soviet Federative Socialist Republic': 'RU',
    'Kingdom of Great Britain': 'GB', 'United Kingdom of Great Britain and Ireland': 'GB', 'Kingdom of England': 'GB', 'Kingdom of Scotland': 'GB', 'Great Britain': 'GB',
    'Kingdom of France': 'FR', 'First French Empire': 'FR', 'French Second Empire': 'FR', 'French Third Republic': 'FR', 'July Monarchy': 'FR', 'Kingdom of the French': 'FR',
    'Austria-Hungary': 'AT', 'Austrian Empire': 'AT', 'Habsburg monarchy': 'AT', 'German Empire': 'DE', 'Kingdom of Prussia': 'DE', 'Weimar Republic': 'DE', 'Nazi Germany': 'DE', 'Confederation of the Rhine': 'DE',
    'Ottoman Empire': 'TR', 'Kingdom of Italy': 'IT', 'Roman Empire': 'IT', 'Ancient Rome': 'IT', 'Roman Republic': 'IT', 'Ancient Greece': 'GR', 'Kingdom of Spain': 'ES', 'Spanish Empire': 'ES',
    'Kingdom of Ireland': 'IE', 'Kingdom of Poland': 'PL', 'Polish–Lithuanian Commonwealth': 'PL', 'Congress Poland': 'PL', 'Kingdom of Portugal': 'PT', 'Kingdom of Denmark': 'DK', 'Kingdom of Sweden': 'SE',
    'Kingdom of Hungary': 'HU', 'Kingdom of Bohemia': 'CZ', 'Czechoslovakia': 'CS', 'Qing dynasty': 'CN', 'Empire of Japan': 'JP', 'Tokugawa shogunate': 'JP', 'British Raj': 'IN', 'British India': 'IN',
};

let cache = null;
let cachePath = null;
function load() {
    if (cache) return;
    try {
        const { app } = require('electron');
        cachePath = path.join(app.getPath('userData'), 'author-countries.json');
        cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch { cache = cache || {}; }
}
function save() { try { if (cachePath) fs.writeFileSync(cachePath, JSON.stringify(cache)); } catch { /* cache is optional */ } }

async function getJson(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
        const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
        if (!res.ok) throw new Error(`${res.status} ${url}`);
        return await res.json();
    } finally { clearTimeout(t); }
}

async function wikidataIdFor(negId) {
    try {
        const a = await getJson(`${OL}/authors/OL${Math.abs(negId)}A.json`);
        return (a.remote_ids && a.remote_ids.wikidata) || null;
    } catch { return null; }
}

async function entities(ids, props) {
    const out = {};
    const list = [...new Set(ids)];
    for (let i = 0; i < list.length; i += 40) {
        const chunk = list.slice(i, i + 40);
        try {
            const d = await getJson(`${WD}?action=wbgetentities&format=json&origin=*&languages=en&props=${props}&ids=${chunk.join('|')}`);
            Object.assign(out, d.entities || {});
        } catch { /* skip chunk */ }
    }
    return out;
}
const claimIds = (ent, prop) => ((ent && ent.claims && ent.claims[prop]) || [])
    .map((c) => c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value && c.mainsnak.datavalue.value.id).filter(Boolean);
const claimStr = (ent, prop) => {
    const c = ((ent && ent.claims && ent.claims[prop]) || [])[0];
    return c && c.mainsnak && c.mainsnak.datavalue ? c.mainsnak.datavalue.value : null;
};
const codeOf = (ent) => {
    if (!ent) return null;
    const iso = claimStr(ent, 'P297');
    if (iso) return String(iso).toUpperCase();
    const label = ent.labels && ent.labels.en && ent.labels.en.value;
    return (label && ALIAS[label]) || null;
};

async function getAuthorCountries(negIds) {
    load();
    const todo = [...new Set(negIds)].filter((id) => !(id in cache));
    if (todo.length) {
        // 1. Open Library -> Wikidata id
        const qOf = {};
        let i = 0;
        await Promise.all(Array.from({ length: 6 }, async () => {
            while (i < todo.length) { const id = todo[i++]; qOf[id] = await wikidataIdFor(id); }
        }));
        const qs = Object.values(qOf).filter(Boolean);
        // 2. Wikidata: citizenship, else birthplace
        const people = await entities(qs, 'claims');
        const firstHop = {}; // negId -> { ids, viaPlace }
        const toFetch = [];
        for (const id of todo) {
            const ent = people[qOf[id]];
            let ids = claimIds(ent, 'P27');
            let viaPlace = false;
            if (!ids.length) { ids = claimIds(ent, 'P19'); viaPlace = ids.length > 0; }
            firstHop[id] = { ids, viaPlace };
            toFetch.push(...ids);
        }
        const hop1 = await entities(toFetch, 'claims|labels');
        // places need one more hop to their country (P17)
        const secondIds = [];
        for (const id of todo) {
            const h = firstHop[id];
            if (!h.viaPlace) continue;
            h.ids.forEach((pid) => claimIds(hop1[pid], 'P17').forEach((c) => secondIds.push(c)));
        }
        const hop2 = secondIds.length ? await entities(secondIds, 'claims|labels') : {};
        for (const id of todo) {
            const h = firstHop[id];
            let code = null;
            if (!h.viaPlace) for (const cid of h.ids) { code = codeOf(hop1[cid]); if (code) break; }
            else for (const pid of h.ids) { for (const cid of claimIds(hop1[pid], 'P17')) { code = codeOf(hop2[cid]); if (code) break; } if (code) break; }
            // Only remember a definite answer or a definite "no Wikidata id"; a network failure is retried next time.
            if (code || qOf[id] === null) cache[id] = code || '';
            else if (people[qOf[id]]) cache[id] = '';
        }
        save();
    }
    const out = {};
    for (const id of negIds) if (cache[id]) out[id] = cache[id];
    return out;
}

module.exports = { getAuthorCountries };
