import pg from 'pg';

const { Client, types } = pg;
const d1Types = {
    getTypeParser(oid, format) {
        if (format !== 'binary') {
            if (oid === types.builtins.INT8) {
                return text => Number.isSafeInteger(Number(text)) ? Number(text) : text;
            }
            if (oid === types.builtins.BOOL) return text => text === 't' ? 1 : 0;
            if (oid === types.builtins.TIMESTAMP) return text => text;
        }
        return types.getTypeParser(oid, format);
    },
};

// SQLite REPLACE also restores defaults for fields omitted from these writes.
const replaceDefaults = {
    files: ['tags', 'created_at', 'updated_at'],
    settings: ['description', 'created_at', 'updated_at'],
    index_operations: ['processed', 'created_at'],
};

function translateSql(sql) {
    // shortcut: only translate SQL forms used here, not arbitrary SQLite syntax.
    const replacement = /^INSERT OR REPLACE INTO (files|settings|index_operations) \(([\w, ]+)\) (VALUES \([?, ]+\))$/.exec(sql);
    if (replacement) {
        const [, table, columns, values] = replacement;
        const [key, ...fields] = columns.split(', ');
        const updates = [...fields, ...replaceDefaults[table]].map(field => `${field} = EXCLUDED.${field}`);
        sql = `INSERT INTO ${table} (${columns}) ${values} ON CONFLICT (${key}) DO UPDATE SET ${updates.join(', ')}`;
    } else if (sql.startsWith('INSERT OR IGNORE INTO ')) {
        sql = sql.replace('INSERT OR IGNORE INTO ', 'INSERT INTO ');
        if (!sql.includes(' ON CONFLICT')) sql += ' ON CONFLICT DO NOTHING';
    }
    sql = sql.replace(/\b(id|key) LIKE \?/g, "$1 ILIKE ? ESCAPE ''")
        .replace("json_insert(parts, '$[#]', json(?))", '(parts::jsonb || jsonb_build_array(?::jsonb))::text')
        .replace('json_array_length(parts)', 'jsonb_array_length(parts::jsonb)');

    let parameter = 0;
    return sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|\?/g,
        token => token === '?' ? `$${++parameter}` : token);
}

export class PostgresD1 {
    constructor(connectionString, client) {
        this.connectionString = connectionString;
        this.client = client;
    }

    prepare(sql) {
        return new PostgresD1Statement(this, translateSql(sql));
    }

    async withClient(callback) {
        if (this.client) return callback(this.client);
        const client = new Client({ connectionString: this.connectionString, types: d1Types, connectionTimeoutMillis: 10_000 });
        // pg emits idle disconnects on the client; active queries reject normally.
        client.on('error', () => {});
        try {
            await client.connect();
            return await callback(client);
        } finally {
            await client.end();
        }
    }

    query(sql, params) {
        return this.withClient(client => client.query(sql, params));
    }

    transaction(callback) {
        if (this.client) throw new Error('Nested PostgresD1 transactions are not supported');
        return this.withClient(async client => {
            await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
            try {
                const result = await callback(new PostgresD1(this.connectionString, client));
                await client.query('COMMIT');
                return result;
            } catch (error) {
                await client.query('ROLLBACK').catch(() => {});
                throw error;
            }
        });
    }
}

class PostgresD1Statement {
    constructor(database, sql) {
        this.database = database;
        this.sql = sql;
        this.params = [];
    }

    bind(...params) {
        this.params = params;
        return this;
    }

    async first(column) {
        const { rows: [row] } = await this.database.query(this.sql, this.params);
        if (!row) return null;
        return column ? row[column] : row;
    }

    async all() {
        const { rows } = await this.database.query(this.sql, this.params);
        return { results: rows };
    }

    async run() {
        const { rowCount } = await this.database.query(this.sql, this.params);
        return { success: true, meta: { changes: rowCount ?? 0, last_row_id: 0 } };
    }
}
