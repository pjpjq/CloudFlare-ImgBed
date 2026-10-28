import { D1Database } from './d1Database.js';

export class ShardedD1Database extends D1Database {
    constructor(db, indexDb) {
        super(db);
        // 索引数据可选地放到独立 D1，未配置时回退到主库，兼容旧部署。
        this.indexDatabase = new D1Database(indexDb || db);
    }

    putSetting(key, value, category) {
        if (key.startsWith('manage@index')) {
            return this.indexDatabase.putFile(key, value);
        }
        return super.putSetting(key, value, category);
    }

    async getSetting(key) {
        if (key.startsWith('manage@index')) {
            const file = await this.indexDatabase.getFile(key);
            return file ? file.value : null;
        }
        return super.getSetting(key);
    }

    deleteSetting(key) {
        if (key.startsWith('manage@index')) {
            return this.indexDatabase.deleteFile(key);
        }
        return super.deleteSetting(key);
    }

    listSettings(options = {}) {
        if ((options.prefix || '').startsWith('manage@index')) {
            return this.indexDatabase.listFiles(options);
        }
        return super.listSettings(options);
    }

    putIndexOperation(operationId, operation) {
        return this.indexDatabase.putIndexOperation(operationId, operation);
    }

    getIndexOperation(operationId) {
        return this.indexDatabase.getIndexOperation(operationId);
    }

    deleteIndexOperation(operationId) {
        return this.indexDatabase.deleteIndexOperation(operationId);
    }

    listIndexOperations(options) {
        return this.indexDatabase.listIndexOperations(options);
    }
}
