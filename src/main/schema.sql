-- I've Already — SQLite schema
-- Design note: `users` exists as a local profile table so the schema doesn't
-- need to change when real auth/sync is added later. For now the app runs
-- with a single default local user (id = 1), no passwords, no server.

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO users (id, username, display_name)
VALUES (1, 'local', 'You');

-- One row per title, cached from TMDB. Never duplicated across users.
CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_id INTEGER NOT NULL,
    media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv', 'book', 'game')),
    title TEXT NOT NULL,
    original_title TEXT,
    poster_path TEXT,
    backdrop_path TEXT,
    release_date TEXT,
    overview TEXT,
    runtime INTEGER,               -- minutes, movies only
    number_of_seasons INTEGER,     -- tv only
    number_of_episodes INTEGER,    -- tv only
    genres TEXT,                   -- JSON array of strings
    tmdb_vote_average REAL,
    raw_json TEXT,                 -- full TMDB response, for anything we didn't model
    cached_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (tmdb_id, media_type)
);

-- A user's relationship to a title: status, rating, review, dates.
CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'planned'
        CHECK (status IN ('planned', 'in_progress', 'completed', 'dropped', 'rewatched')),
    rating INTEGER,                -- 0-10, null if unrated
    review TEXT,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    date_started TEXT,
    date_finished TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, media_id)
);

-- Per-episode watch tracking for TV. Episode metadata is cached from TMDB
-- lazily (only fetched once the user opens a show), not pre-populated.
CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    season_number INTEGER NOT NULL,
    episode_number INTEGER NOT NULL,
    name TEXT,
    air_date TEXT,
    UNIQUE (media_id, season_number, episode_number)
);

CREATE TABLE IF NOT EXISTS watched_episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    watched_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (entry_id, episode_id)
);

CREATE TABLE IF NOT EXISTS lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS list_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (list_id, media_id)
);

CREATE INDEX IF NOT EXISTS idx_entries_user_status ON entries(user_id, status);
CREATE INDEX IF NOT EXISTS idx_media_type ON media(media_type);
CREATE INDEX IF NOT EXISTS idx_episodes_media ON episodes(media_id, season_number);
