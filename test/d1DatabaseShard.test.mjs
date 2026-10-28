import assert from 'node:assert/strict';
import test from 'node:test';

import { createDatabaseAdapter } from '../functions/utils/databaseAdapter.js';

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
        return Promise.resolve({ success: true });
    }

    first() {
        return Promise.resolve(null);
    }

    all() {
        return Promise.resolve({ results: [] });
    }
}

class FakeDatabase {
    constructor(name) {
        this.name = name;
        this.calls = [];
    }

    prepare(sql) {
        this.calls.push(sql);
        return new FakeStatement(this, sql);
    }
}

test('routes index keys to the optional index database', async () => {
    const primary = new FakeDatabase('primary');
    const index = new FakeDatabase('index');
    const database = createDatabaseAdapter({ img_d1: primary, img_index: index });

    await database.put('manage@index@meta', '{}');
    await database.put('manage@index_0', '[]');
    await database.put('manage@index@operation_1', JSON.stringify({
        type: 'add',
        timestamp: 1,
        data: {},
    }));
    await database.get('manage@index@meta');
    await database.list({ prefix: 'manage@index' });

    assert.equal(primary.calls.length, 0);
    assert.equal(index.calls.length, 5);
    assert.match(index.calls[0], /INSERT OR REPLACE INTO files/);
    assert.match(index.calls[2], /INSERT OR REPLACE INTO index_operations/);
});

test('keeps ordinary file keys on the primary database', async () => {
    const primary = new FakeDatabase('primary');
    const index = new FakeDatabase('index');
    const database = createDatabaseAdapter({ img_d1: primary, img_index: index });

    await database.put('regular-file', '', { metadata: { FileName: 'a.png' } });

    assert.equal(primary.calls.length, 1);
    assert.match(primary.calls[0], /INSERT OR REPLACE INTO files/);
    assert.equal(index.calls.length, 0);
});

test('falls back to the primary database when no index binding exists', async () => {
    const primary = new FakeDatabase('primary');
    const database = createDatabaseAdapter({ img_d1: primary });

    await database.put('manage@index@meta', '{}');

    assert.equal(primary.calls.length, 1);
});

test('keeps settings on primary and index reads and deletes on the index database', async () => {
    const primary = new FakeDatabase('primary');
    const index = new FakeDatabase('index');
    const database = createDatabaseAdapter({ img_d1: primary, img_index: index });

    await database.put('manage@sysConfig@others', '{}');
    await database.get('manage@sysConfig@others');
    await database.list({ prefix: 'manage@sysConfig@' });
    await database.delete('manage@sysConfig@others');
    await database.getWithMetadata('manage@index@meta');
    await database.delete('manage@index_0');
    await database.get('manage@index@operation_1');
    await database.list({ prefix: 'manage@index@operation_' });
    await database.delete('manage@index@operation_1');

    assert.equal(primary.calls.length, 4);
    assert.ok(primary.calls.every(sql => /\bsettings\b/.test(sql)));
    assert.equal(index.calls.length, 5);
    assert.ok(index.calls.every(sql => !/\bsettings\b/.test(sql)));
    assert.match(index.calls[0], /SELECT \* FROM files/);
    assert.match(index.calls[1], /DELETE FROM files/);
    assert.ok(index.calls.slice(2).every(sql => /\bindex_operations\b/.test(sql)));
});
