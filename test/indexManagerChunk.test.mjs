import assert from 'node:assert/strict';
import test from 'node:test';

import { rebuildIndex } from '../functions/utils/indexManager.js';

class FakeStatement {
    constructor(database, sql) {
        this.database = database;
        this.sql = sql;
        this.params = [];
    }

    bind(...params) {
        this.params = params;
        return this;
    }

    run() {
        this.database.runs.push({ sql: this.sql, params: this.params });
        return Promise.resolve({ success: true });
    }

    first() {
        return Promise.resolve(null);
    }

    all() {
        if (this.sql.startsWith('SELECT id, metadata FROM files')) {
            return Promise.resolve({ results: this.database.fileRows });
        }
        return Promise.resolve({ results: [] });
    }
}

class FakeDatabase {
    constructor(fileRows = []) {
        this.fileRows = fileRows;
        this.runs = [];
    }

    prepare(sql) {
        return new FakeStatement(this, sql);
    }
}

test('rebuildIndex stores index chunks at or below the D1-safe size', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({
        id: `file-${String(index).padStart(4, '0')}`,
        metadata: JSON.stringify({ TimeStamp: index + 1 })
    }));
    const primary = new FakeDatabase(rows);
    const index = new FakeDatabase();
    const context = {
        env: { img_d1: primary, img_index: index },
        request: new Request('https://example.test/api/manage/list'),
        waitUntil() {}
    };

    const result = await rebuildIndex(context);

    assert.equal(result.success, true);
    const chunkWrites = index.runs.filter(({ params }) => /^manage@index_\d+$/.test(params[0]));
    assert.equal(chunkWrites.length, 2);
    assert.deepEqual(JSON.parse(chunkWrites[0].params[1]).length, 500);
    assert.deepEqual(JSON.parse(chunkWrites[1].params[1]).length, 1);
});
