# PostgreSQL 主库迁移

只替换 Pages 的 `img_d1` 主库（D1 名 `img_url`）。不迁 `img_index`、Telegram/R2、域名或调用端队列；现有文件 ID 和元数据原样保留。不配置 `IMG_PRIMARY_PG` 时仍走原来的 D1/KV 路径。

1. 在 Northflank 准备独立的 UTF-8 PostgreSQL 数据库 `imgbed_<后缀>`，不要复用其他业务库。用 TLS 或私网 Tunnel 连接；迁移账号可建表，应用账号只授予主库业务表读写。回填走直连或私有转发，不经 Hyperdrive。
2. 测试用 Pages 预览环境启用 `nodejs_compat`（兼容日期不早于 `2024-09-23`），配置关闭查询缓存的 Hyperdrive 绑定 `IMG_PRIMARY_PG`。预览使用独立测试库和测试索引，不能写生产 `img_index` 或对真实媒体做修改。
3. 用环境变量传入 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_D1_DATABASE_ID`（只接受 `img_url`）和 D1 Read 的 `CLOUDFLARE_API_TOKEN`。先运行 `node deploy/postgres/backfill.mjs --dry-run`，只抽样源库。最终回填另需 `MIGRATION_DATABASE_URL`、`MIGRATION_EXPECTED_DATABASE`（与 URL 及连接后库名一致），再运行 `node deploy/postgres/backfill.mjs --apply`。它只向隔离 PG 写入，断点和数据在同一事务内提交；最后对账九张表的行数和 SHA-256。`--verify` 可复核，`MIGRATION_PAGE_SIZE` 默认 100、上限 500。若对账不一致，不切流、不自动删记录，使用干净的隔离目标重跑。不要在生产调用会阻塞查询的 D1 全量导出。
4. 分页读取不是一致性快照。最终回填、对账和切换期间，须经批准把所有主库写入（上传、登记和后台写操作）隔离在 D1 之外，但保留旧链接读流量；不要删、停或清空调用端队列。生产切换保留原 `img_index` 和媒体绑定，只增加 `IMG_PRIMARY_PG`。切换前验证旧链接、双并发租约、重复回执和索引可见性，切换后观察自然重试是否收敛。若 PG 已收到新写入，直接撤下绑定会遗失这些写入的可见性；须先对账和制定回迁方案。

本地集成测试：对临时数据库提供 `IMGBED_TEST_POSTGRES_URL`，运行 `node --test test/postgresD1.test.mjs test/postgresRelayLease.test.mjs`。测试会创建并删除临时 schema，不要使用业务库。
