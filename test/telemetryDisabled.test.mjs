import assert from 'node:assert/strict';
import test from 'node:test';

import { getOthersConfig } from '../functions/api/manage/sysConfig/others.js';

test('honors the upstream telemetry disable flag without changing unrelated settings', async () => {
    const stored = { telemetry: { enabled: false }, randomImageAPI: { enabled: true } };
    const db = { async get() { return JSON.stringify(stored); } };

    const config = await getOthersConfig(db, { disable_telemetry: 'true' });

    assert.equal(config.telemetry.enabled, false);
    assert.equal(config.randomImageAPI.enabled, true);
    assert.equal(stored.telemetry.enabled, false);
});

test('disables telemetry by default when no telemetry preference has been stored', async () => {
    const config = await getOthersConfig({ async get() { return null; } }, { disable_telemetry: 'true' });

    assert.equal(config.telemetry.enabled, false);
});
