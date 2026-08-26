-- CloudFlare ImgBed index-only D1 database.
-- The application stores manage@index* keys through the same key/value
-- compatibility layer as the primary database, so the files table keeps
-- the complete value/metadata shape used by D1Database.

CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    value TEXT,
    metadata TEXT NOT NULL,
    file_name TEXT,
    file_type TEXT,
    file_size TEXT,
    upload_ip TEXT,
    upload_address TEXT,
    list_type TEXT,
    timestamp INTEGER,
    label TEXT,
    directory TEXT,
    channel TEXT,
    channel_name TEXT,
    tg_file_id TEXT,
    tg_chat_id TEXT,
    tg_bot_token TEXT,
    is_chunked BOOLEAN DEFAULT FALSE,
    tags TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS index_operations (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    data TEXT NOT NULL,
    processed BOOLEAN DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_index_files_timestamp ON files(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_index_operations_timestamp ON index_operations(timestamp);
CREATE INDEX IF NOT EXISTS idx_index_operations_processed ON index_operations(processed);
