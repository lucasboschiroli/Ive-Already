// Curated "famous" book publishers, the way studios.js does it for film/TV.
// Publisher pages are built from Open Library (works that have an edition by that publisher).
// Ids are fixed numbers in this list (stored as the follow's tmdb_id with kind 'publisher').

const BASE = 'https://openlibrary.org';
const COVERS = 'https://covers.openlibrary.org';
const HEADERS = { 'User-Agent': 'IveAlready/0.1 (personal media tracker)', Accept: 'application/json' };
const cache = new Map();

// parent: id of the group that owns an imprint ("Penguin Random House, Vintage").
// ol: names to search for on Open Library. re: matches the publisher strings found on editions.
const LIST = [
    { id: 1, name: 'Penguin Random House', re: /penguin random house/i, ol: ['Penguin Random House', 'Random House', 'Penguin Books', 'Penguin Classics', 'Vintage', 'Alfred A. Knopf', 'Doubleday', 'Ballantine Books', 'Bantam'], desc: 'The largest trade book publisher in the world, home to Penguin, Random House, Vintage, Knopf and many more imprints.', country: 'US / UK' },
    { id: 2, name: 'HarperCollins', re: /harper ?collins|^harper\b/i, ol: ['HarperCollins', 'Harper & Row', 'William Morrow', 'Harper Perennial'], desc: 'One of the "Big Five" English-language publishers, owned by News Corp.', country: 'US / UK' },
    { id: 3, name: 'Simon & Schuster', re: /simon (&|and) schuster/i, ol: ['Simon & Schuster', 'Scribner', 'Pocket Books', 'Gallery Books'], desc: 'New York publisher known for Scribner, Pocket Books and a huge backlist of bestsellers.', country: 'US' },
    { id: 4, name: 'Hachette', re: /hachette/i, ol: ['Hachette', 'Little, Brown', 'Orion', 'Gollancz', 'Grand Central Publishing'], desc: 'French-owned global publisher, behind Little, Brown, Orion and Gollancz.', country: 'France / US / UK' },
    { id: 5, name: 'Macmillan', re: /macmillan/i, ol: ['Macmillan', 'Tor Books', "St. Martin's Press", 'Farrar, Straus and Giroux', 'Picador'], desc: 'Publisher of Tor, Farrar, Straus and Giroux, St. Martin\'s Press and Picador.', country: 'US / UK' },
    { id: 6, name: 'Bloomsbury', re: /bloomsbury/i, ol: ['Bloomsbury'], desc: 'London publisher best known for the original Harry Potter books.', country: 'UK' },
    { id: 7, name: 'Scholastic', re: /scholastic/i, ol: ['Scholastic'], desc: 'The world\'s largest publisher of children\'s books.', country: 'US' },
    { id: 8, name: 'Oxford University Press', re: /oxford university press|^oxford u\. ?p/i, ol: ['Oxford University Press'], desc: 'The university press of Oxford, publisher of the Oxford World\'s Classics.', country: 'UK' },
    { id: 9, name: 'Cambridge University Press', re: /cambridge university press/i, ol: ['Cambridge University Press'], desc: 'The university press of Cambridge, one of the oldest publishers in the world.', country: 'UK' },
    { id: 11, name: 'Penguin Books', parent: 1, re: /^penguin(?! random house)( books| classics| modern classics)?\b|penguin group/i, ol: ['Penguin Books', 'Penguin Classics', 'Penguin Group'], desc: 'The paperback pioneer, famous for its orange spines and the Penguin Classics series.', country: 'UK' },
    { id: 12, name: 'Vintage', parent: 1, re: /^vintage/i, ol: ['Vintage', 'Vintage Books', 'Vintage International'], desc: 'Quality paperback imprint of Penguin Random House.', country: 'US' },
    { id: 13, name: 'Random House', parent: 1, re: /^random house/i, ol: ['Random House'], desc: 'Founded in 1927, a cornerstone of American publishing.', country: 'US' },
    { id: 14, name: 'Alfred A. Knopf', parent: 1, re: /knopf/i, ol: ['Alfred A. Knopf', 'Knopf'], desc: 'Prestigious literary house with its borzoi logo.', country: 'US' },
    { id: 15, name: 'Doubleday', parent: 1, re: /doubleday/i, ol: ['Doubleday'], desc: 'Historic American publisher of fiction and non-fiction.', country: 'US' },
    { id: 16, name: 'Ballantine Books', parent: 1, re: /ballantine/i, ol: ['Ballantine Books'], desc: 'Known for pioneering science-fiction and fantasy paperbacks.', country: 'US' },
    { id: 17, name: 'Bantam', parent: 1, re: /^bantam/i, ol: ['Bantam', 'Bantam Books'], desc: 'Mass-market paperback publisher.', country: 'US' },
    { id: 18, name: 'Tor Books', parent: 5, re: /^tor\b|tor\/forge/i, ol: ['Tor Books', 'Tor'], desc: 'The leading American publisher of science fiction and fantasy.', country: 'US' },
    { id: 19, name: 'Farrar, Straus and Giroux', parent: 5, re: /farrar/i, ol: ['Farrar, Straus and Giroux'], desc: 'Literary publisher with an extraordinary roster of Nobel laureates.', country: 'US' },
    { id: 20, name: "St. Martin's Press", parent: 5, re: /st\.? martin/i, ol: ["St. Martin's Press"], desc: 'Large New York publisher of fiction and non-fiction.', country: 'US' },
    { id: 21, name: 'Picador', parent: 5, re: /picador/i, ol: ['Picador'], desc: 'Imprint for international and contemporary literary writing.', country: 'UK' },
    { id: 22, name: 'Little, Brown', parent: 4, re: /little,? brown/i, ol: ['Little, Brown', 'Little, Brown and Company'], desc: 'Boston-founded publisher of literary and commercial fiction.', country: 'US' },
    { id: 23, name: 'Gollancz', parent: 4, re: /gollancz|orion/i, ol: ['Gollancz', 'Victor Gollancz', 'Orion'], desc: 'The home of British science fiction and fantasy.', country: 'UK' },
    { id: 24, name: 'Faber & Faber', re: /faber/i, ol: ['Faber & Faber', 'Faber and Faber'], desc: 'Independent London house famous for poetry and literary fiction.', country: 'UK' },
    { id: 26, name: 'Scribner', parent: 3, re: /scribner/i, ol: ['Scribner', "Charles Scribner's Sons"], desc: 'Publisher of Hemingway and Fitzgerald.', country: 'US' },
    { id: 27, name: 'Dover Publications', re: /dover/i, ol: ['Dover Publications', 'Dover'], desc: 'Low-cost reprints of classics.', country: 'US' },
    { id: 28, name: 'Harper', parent: 2, re: /^harper\b(?! ?collins)/i, ol: ['Harper', 'Harper & Row', 'Harper Perennial'], desc: 'The flagship imprint of HarperCollins.', country: 'US' },
    { id: 30, name: 'Marvel Comics', re: /marvel/i, ol: ['Marvel Comics', 'Marvel'], desc: 'The home of Spider-Man, the X-Men and the Avengers.', country: 'US' },
    { id: 31, name: 'DC Comics', re: /^dc comics|^dc\b/i, ol: ['DC Comics'], desc: 'Publisher of Batman, Superman and Wonder Woman.', country: 'US' },
    { id: 32, name: 'Dark Horse Comics', re: /dark horse/i, ol: ['Dark Horse Comics', 'Dark Horse'], desc: 'Publisher of Hellboy, Sin City and many licensed comics.', country: 'US' },
    { id: 33, name: 'Image Comics', re: /image comics/i, ol: ['Image Comics'], desc: 'Creator-owned comics publisher behind The Walking Dead and Saga.', country: 'US' },
    { id: 34, name: 'Kodansha', re: /kodansha/i, ol: ['Kodansha', 'Kodansha Comics'], desc: 'Japan\'s largest publisher of manga.', country: 'Japan' },
    { id: 35, name: 'VIZ Media', re: /\bviz\b/i, ol: ['VIZ Media', 'Viz'], desc: 'Leading English-language manga publisher.', country: 'US / Japan' },
    { id: 36, name: 'Shueisha', re: /shueisha/i, ol: ['Shueisha'], desc: 'Publisher of Weekly Shōnen Jump.', country: 'Japan' },
    { id: 38, name: "Everyman's Library", re: /everyman/i, ol: ["Everyman's Library", 'Everyman'], desc: 'Hardcover classics series.', country: 'UK / US' },
    { id: 39, name: 'Modern Library', parent: 1, re: /modern library/i, ol: ['Modern Library'], desc: 'Classics imprint founded in 1917.', country: 'US' },
];
const byId = new Map(LIST.map((p) => [p.id, p]));
// imprints first so "Penguin Books" wins over the group name
const MATCH_ORDER = [...LIST].sort((a, b) => (b.parent ? 1 : 0) - (a.parent ? 1 : 0));

// Which curated publishers does an edition's publisher list point at? Returns up to 2: [group, imprint] or [publisher].
function matchPublishers(names) {
    const list = (names || []).filter((n) => typeof n === 'string');
    let hit = null;
    for (const p of MATCH_ORDER) {
        if (list.some((n) => p.re.test(n.trim()))) { hit = p; break; }
    }
    if (!hit) return [];
    const out = [];
    if (hit.parent) { const g = byId.get(hit.parent); if (g) out.push({ kind: 'publisher', id: g.id, name: g.name }); }
    out.push({ kind: 'publisher', id: hit.id, name: hit.name });
    return out.slice(0, 2);
}

async function olSearch(params) {
    const url = new URL(`${BASE}/search.json`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const key = url.toString();
    if (cache.has(key)) return cache.get(key);
    const res = await fetch(key, { headers: HEADERS });
    if (!res.ok) throw new Error(`Open Library ${res.status}`);
    const data = await res.json();
    cache.set(key, data);
    return data;
}

async function getPublisher(id) {
    const def = byId.get(Number(id));
    if (!def) throw new Error('Unknown publisher');
    const q = `publisher:(${def.ol.map((n) => `"${n}"`).join(' OR ')})`;
    const data = await olSearch({ q, sort: 'editions', limit: 80, fields: 'key,title,first_publish_year,cover_i,edition_count,ratings_average' });
    const seen = new Set();
    const credits = (data.docs || []).filter((d) => d.cover_i).map((d) => ({
        tmdb_id: Number((/OL(\d+)W/.exec(d.key) || [])[1]),
        media_type: 'book', title: d.title,
        release_date: d.first_publish_year ? `${d.first_publish_year}-01-01` : '',
        poster_path: `${COVERS}/b/id/${d.cover_i}-M.jpg`,
        popularity: d.edition_count || 0,
        vote_average: typeof d.ratings_average === 'number' ? Math.round(d.ratings_average * 20) / 10 : 0,
    })).filter((c) => c.tmdb_id && !seen.has(c.title.toLowerCase()) && seen.add(c.title.toLowerCase()));
    const parent = def.parent ? byId.get(def.parent) : null;
    return {
        kind: 'publisher', id: def.id, name: def.name, description: def.desc || '', headquarters: '',
        homepage: '', origin_country: def.country || '', logo_path: null,
        parent: parent ? { kind: 'publisher', id: parent.id, name: parent.name } : null,
        credits,
    };
}

module.exports = { matchPublishers, getPublisher };
