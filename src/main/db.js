const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { app } = require('electron');

const DEFAULT_USER_ID = 1;

let db;

function getDbPath() {
    // userData = the correct per-OS location for app data
    // (~/Library/Application Support/... on macOS, %APPDATA% on Windows, etc.)
    const userDataDir = app.getPath('userData');
    return path.join(userDataDir, 'ivealready.sqlite3');
}

function init() {
    const dbPath = getDbPath();
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    runMigrations();

    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    db.exec(schema);

    console.log(`[db] ready at ${dbPath}`);
    return db;
}

// Databases created before the status/media_type CHECK constraints were
// widened still have the OLD constraint baked into the table definition —
// `CREATE TABLE IF NOT EXISTS` in schema.sql is a no-op on an existing
// table, so it never fixes this on its own. SQLite has no ALTER TABLE for
// CHECK constraints, so the only way to change one is: rename the old
// table, create a new one with the correct constraint, copy the data
// across (translating old status values), then drop the old table.
function runMigrations() {
    const getTableSql = (name) =>
        db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(name)?.sql;

    const entriesSql = getTableSql('entries');
    if (entriesSql && entriesSql.includes("'watching'")) {
        migrateEntriesStatus();
    }

    const mediaSql = getTableSql('media');
    if (mediaSql && !mediaSql.includes("'book'")) {
        migrateMediaTypes();
    }
}

function migrateEntriesStatus() {
    console.log('[db] migrating entries table to updated status values...');
    db.pragma('foreign_keys = OFF');
    const migrate = db.transaction(() => {
        db.exec(`ALTER TABLE entries RENAME TO entries_old`);
        db.exec(`
            CREATE TABLE entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id),
                media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
                status TEXT NOT NULL DEFAULT 'planned'
                    CHECK (status IN ('planned', 'in_progress', 'completed', 'dropped', 'rewatched')),
                rating INTEGER,
                review TEXT,
                is_favorite INTEGER NOT NULL DEFAULT 0,
                date_started TEXT,
                date_finished TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE (user_id, media_id)
            )
        `);
        db.exec(`
            INSERT INTO entries (id, user_id, media_id, status, rating, review, is_favorite, date_started, date_finished, created_at, updated_at)
            SELECT id, user_id, media_id,
                CASE status
                    WHEN 'watching' THEN 'in_progress'
                    WHEN 'watched' THEN 'completed'
                    ELSE status
                END,
                rating, review, is_favorite, date_started, date_finished, created_at, updated_at
            FROM entries_old
        `);
        db.exec(`DROP TABLE entries_old`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_user_status ON entries(user_id, status)`);
    });
    migrate();
    db.pragma('foreign_keys = ON');
    console.log('[db] entries migration complete');
}

function migrateMediaTypes() {
    console.log('[db] migrating media table to support book/game types...');
    db.pragma('foreign_keys = OFF');
    const migrate = db.transaction(() => {
        db.exec(`ALTER TABLE media RENAME TO media_old`);
        db.exec(`
            CREATE TABLE media (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tmdb_id INTEGER NOT NULL,
                media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv', 'book', 'game')),
                title TEXT NOT NULL,
                original_title TEXT,
                poster_path TEXT,
                backdrop_path TEXT,
                release_date TEXT,
                overview TEXT,
                runtime INTEGER,
                number_of_seasons INTEGER,
                number_of_episodes INTEGER,
                genres TEXT,
                tmdb_vote_average REAL,
                raw_json TEXT,
                cached_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE (tmdb_id, media_type)
            )
        `);
        db.exec(`
            INSERT INTO media (id, tmdb_id, media_type, title, original_title, poster_path, backdrop_path, release_date, overview, runtime, number_of_seasons, number_of_episodes, genres, tmdb_vote_average, raw_json, cached_at)
            SELECT id, tmdb_id, media_type, title, original_title, poster_path, backdrop_path, release_date, overview, runtime, number_of_seasons, number_of_episodes, genres, tmdb_vote_average, raw_json, cached_at
            FROM media_old
        `);
        db.exec(`DROP TABLE media_old`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_media_type ON media(media_type)`);
    });
    migrate();
    db.pragma('foreign_keys = ON');
    console.log('[db] media migration complete');
}

function getDb() {
    if (!db) throw new Error('Database not initialized — call init() first');
    return db;
}

// ---- media ----

function upsertMedia(media) {
    const stmt = getDb().prepare(`
        INSERT INTO media (
            tmdb_id, media_type, title, original_title, poster_path,
            backdrop_path, release_date, overview, runtime,
            number_of_seasons, number_of_episodes, genres,
            tmdb_vote_average, raw_json, cached_at
        ) VALUES (
            @tmdb_id, @media_type, @title, @original_title, @poster_path,
            @backdrop_path, @release_date, @overview, @runtime,
            @number_of_seasons, @number_of_episodes, @genres,
            @tmdb_vote_average, @raw_json, datetime('now')
        )
        ON CONFLICT (tmdb_id, media_type) DO UPDATE SET
            title = excluded.title,
            original_title = excluded.original_title,
            poster_path = excluded.poster_path,
            backdrop_path = excluded.backdrop_path,
            release_date = excluded.release_date,
            overview = excluded.overview,
            runtime = excluded.runtime,
            number_of_seasons = excluded.number_of_seasons,
            number_of_episodes = excluded.number_of_episodes,
            genres = excluded.genres,
            tmdb_vote_average = excluded.tmdb_vote_average,
            raw_json = excluded.raw_json,
            cached_at = datetime('now')
        RETURNING id
    `);
    const row = stmt.get(media);
    return row.id;
}

function getMediaById(mediaId) {
    return getDb().prepare('SELECT * FROM media WHERE id = ?').get(mediaId);
}

function getMediaByTmdbId(tmdbId, mediaType) {
    return getDb()
        .prepare('SELECT * FROM media WHERE tmdb_id = ? AND media_type = ?')
        .get(tmdbId, mediaType);
}

// ---- entries (catalog / progress) ----

function upsertEntry(mediaId, fields, userId = DEFAULT_USER_ID) {
    const existing = getDb()
        .prepare('SELECT id FROM entries WHERE user_id = ? AND media_id = ?')
        .get(userId, mediaId);

    if (existing) {
        const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
        getDb()
            .prepare(`UPDATE entries SET ${sets}, updated_at = datetime('now') WHERE id = @id`)
            .run({ ...fields, id: existing.id });
        return existing.id;
    }

    const stmt = getDb().prepare(`
        INSERT INTO entries (user_id, media_id, status, rating, review, is_favorite, date_started, date_finished)
        VALUES (@user_id, @media_id, @status, @rating, @review, @is_favorite, @date_started, @date_finished)
        RETURNING id
    `);
    const row = stmt.get({
        user_id: userId,
        media_id: mediaId,
        status: fields.status ?? 'planned',
        rating: fields.rating ?? null,
        review: fields.review ?? null,
        is_favorite: fields.is_favorite ?? 0,
        date_started: fields.date_started ?? null,
        date_finished: fields.date_finished ?? null,
    });
    return row.id;
}

function getEntryForMedia(mediaId, userId = DEFAULT_USER_ID) {
    return getDb()
        .prepare(
            `SELECT e.*, m.title, m.poster_path, m.media_type, m.release_date
             FROM entries e JOIN media m ON m.id = e.media_id
             WHERE e.user_id = ? AND e.media_id = ?`
        )
        .get(userId, mediaId);
}

function listEntries({ status = null, mediaType = null, userId = DEFAULT_USER_ID } = {}) {
    let query = `
        SELECT e.*, m.tmdb_id, m.title, m.poster_path, m.media_type, m.release_date, m.tmdb_vote_average
        FROM entries e JOIN media m ON m.id = e.media_id
        WHERE e.user_id = @userId
    `;
    const params = { userId };
    if (status) {
        query += ' AND e.status = @status';
        params.status = status;
    }
    if (mediaType) {
        if (Array.isArray(mediaType)) {
            const placeholders = mediaType.map((_, i) => `@mt${i}`).join(', ');
            query += ` AND m.media_type IN (${placeholders})`;
            mediaType.forEach((t, i) => { params[`mt${i}`] = t; });
        } else {
            query += ' AND m.media_type = @mediaType';
            params.mediaType = mediaType;
        }
    }
    query += ' ORDER BY e.updated_at DESC';
    return getDb().prepare(query).all(params);
}

function deleteEntry(entryId) {
    getDb().prepare('DELETE FROM entries WHERE id = ?').run(entryId);
}

// ---- episodes ----

function upsertEpisodes(mediaId, episodes) {
    const insert = getDb().prepare(`
        INSERT INTO episodes (media_id, season_number, episode_number, name, air_date)
        VALUES (@media_id, @season_number, @episode_number, @name, @air_date)
        ON CONFLICT (media_id, season_number, episode_number) DO UPDATE SET
            name = excluded.name, air_date = excluded.air_date
        RETURNING id
    `);
    const insertMany = getDb().transaction((eps) => {
        return eps.map((ep) =>
            insert.get({
                media_id: mediaId,
                season_number: ep.season_number,
                episode_number: ep.episode_number,
                name: ep.name ?? null,
                air_date: ep.air_date ?? null,
            }).id
        );
    });
    return insertMany(episodes);
}

function getEpisodes(mediaId, seasonNumber = null) {
    if (seasonNumber != null) {
        return getDb()
            .prepare(
                'SELECT * FROM episodes WHERE media_id = ? AND season_number = ? ORDER BY episode_number'
            )
            .all(mediaId, seasonNumber);
    }
    return getDb()
        .prepare('SELECT * FROM episodes WHERE media_id = ? ORDER BY season_number, episode_number')
        .all(mediaId);
}

function toggleWatchedEpisode(entryId, episodeId, watched) {
    if (watched) {
        getDb()
            .prepare(
                `INSERT OR IGNORE INTO watched_episodes (entry_id, episode_id) VALUES (?, ?)`
            )
            .run(entryId, episodeId);
    } else {
        getDb()
            .prepare('DELETE FROM watched_episodes WHERE entry_id = ? AND episode_id = ?')
            .run(entryId, episodeId);
    }
}

function getWatchedEpisodeIds(entryId) {
    return getDb()
        .prepare('SELECT episode_id FROM watched_episodes WHERE entry_id = ?')
        .all(entryId)
        .map((r) => r.episode_id);
}

module.exports = {
    DEFAULT_USER_ID,
    init,
    getDb,
    upsertMedia,
    getMediaById,
    getMediaByTmdbId,
    upsertEntry,
    getEntryForMedia,
    listEntries,
    deleteEntry,
    upsertEpisodes,
    getEpisodes,
    toggleWatchedEpisode,
    getWatchedEpisodeIds,
};
