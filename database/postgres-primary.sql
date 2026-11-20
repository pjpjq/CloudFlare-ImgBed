-- PostgreSQL schema for the primary database only. img_index stays on D1.
-- Keep JSON documents as text and preserve SQLite's bytewise key order.
CREATE TABLE IF NOT EXISTS files (
    id TEXT COLLATE "C" PRIMARY KEY,
    value TEXT,
    metadata TEXT NOT NULL,
    file_name TEXT,
    file_type TEXT,
    file_size TEXT,
    upload_ip TEXT,
    upload_address TEXT,
    list_type TEXT,
    timestamp BIGINT,
    label TEXT,
    directory TEXT,
    channel TEXT,
    channel_name TEXT,
    tg_file_id TEXT,
    tg_chat_id TEXT,
    tg_bot_token TEXT,
    is_chunked BOOLEAN DEFAULT FALSE,
    tags TEXT,
    created_at TIMESTAMP DEFAULT date_trunc('second', CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP DEFAULT date_trunc('second', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT COLLATE "C" PRIMARY KEY,
    value TEXT NOT NULL,
    category TEXT,
    description TEXT,
    created_at TIMESTAMP DEFAULT date_trunc('second', CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP DEFAULT date_trunc('second', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
);

CREATE TABLE IF NOT EXISTS index_operations (
    id TEXT COLLATE "C" PRIMARY KEY,
    type TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    data TEXT NOT NULL,
    processed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT date_trunc('second', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
);

CREATE TABLE IF NOT EXISTS index_metadata (
    key TEXT COLLATE "C" PRIMARY KEY,
    last_updated BIGINT,
    total_count BIGINT DEFAULT 0,
    last_operation_id TEXT,
    chunk_count BIGINT DEFAULT 0,
    chunk_size BIGINT DEFAULT 0,
    created_at TIMESTAMP DEFAULT date_trunc('second', CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP DEFAULT date_trunc('second', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
);

CREATE TABLE IF NOT EXISTS other_data (
    key TEXT COLLATE "C" PRIMARY KEY,
    value TEXT NOT NULL,
    type TEXT,
    description TEXT,
    created_at TIMESTAMP DEFAULT date_trunc('second', CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    updated_at TIMESTAMP DEFAULT date_trunc('second', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
);

CREATE INDEX IF NOT EXISTS idx_files_timestamp ON files(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_files_directory ON files(directory);
CREATE INDEX IF NOT EXISTS idx_files_channel ON files(channel);
CREATE INDEX IF NOT EXISTS idx_files_file_type ON files(file_type);
CREATE INDEX IF NOT EXISTS idx_files_upload_ip ON files(upload_ip);
CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_tags ON files(tags);
CREATE INDEX IF NOT EXISTS idx_settings_category ON settings(category);
CREATE INDEX IF NOT EXISTS idx_index_operations_timestamp ON index_operations(timestamp);
CREATE INDEX IF NOT EXISTS idx_index_operations_processed ON index_operations(processed);
CREATE INDEX IF NOT EXISTS idx_index_operations_type ON index_operations(type);
CREATE INDEX IF NOT EXISTS idx_other_data_type ON other_data(type);

-- Upload receipts and relay state only; never store image bytes here.
CREATE TABLE IF NOT EXISTS upload_relay_registrations (
    upload_id TEXT COLLATE "C" PRIMARY KEY,
    file_id TEXT COLLATE "C" NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL,
    receipt TEXT NOT NULL,
    lease_owner TEXT,
    lease_until BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS upload_relay_jobs (
    upload_id TEXT COLLATE "C" PRIMARY KEY,
    lease_owner TEXT NOT NULL,
    lease_until BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS upload_relay_rate (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    window_start BIGINT NOT NULL,
    starts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS upload_relay_transfers (
    upload_id TEXT COLLATE "C" PRIMARY KEY,
    file_id TEXT COLLATE "C" NOT NULL UNIQUE,
    manifest TEXT NOT NULL,
    parts TEXT NOT NULL DEFAULT '[]',
    created_at BIGINT NOT NULL
);
