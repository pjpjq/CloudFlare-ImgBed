-- Upload receipts only; never store image bytes in this ledger.
-- Apply to the PRIMARY D1 database, not img_index. Existing tables remain unchanged.
CREATE TABLE IF NOT EXISTS upload_relay_registrations (
    upload_id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL,
    receipt TEXT NOT NULL,
    lease_owner TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

-- Short-lived upload leases and a bounded global rate counter; no file contents.
CREATE TABLE IF NOT EXISTS upload_relay_jobs (
    upload_id TEXT PRIMARY KEY,
    lease_owner TEXT NOT NULL,
    lease_until INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS upload_relay_rate (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    window_start INTEGER NOT NULL,
    starts INTEGER NOT NULL
);

-- Unfinished transfers only: provider file IDs and block-aligned hash state, never image bytes.
CREATE TABLE IF NOT EXISTS upload_relay_transfers (
    upload_id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL UNIQUE,
    manifest TEXT NOT NULL,
    parts TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
);
