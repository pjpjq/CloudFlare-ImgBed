# Catalyst 上传计算（原存储与双 D1 不变）

图片字节：auto-trade → Catalyst Advanced I/O → **原 Telegram / R2 / S3 等渠道**。
元数据：Catalyst → CF `/api/uploadRelay/*` → 原 `img_d1`、`img_index`。
读图、索引、管理后台仍由 Cloudflare 提供。没有 Catalyst Storage 桶、存储迁移或对 CF `/upload` 的网络调用。
构建时只替换 Catalyst 内的配置、鉴权、索引与 S3 传输适配器；上游上传源文件不改。

## 1. 前置检查与额度门槛

**2026-10-29 状态：** 已发布既有 Pages 的生产元数据 API 与 Catalyst Development 函数，未启用 Catalyst Production。仅本机客户端及持久恢复进程已切流，远端交易主服务未重启。
当日实测 JPEG、17,743,926 字节 BMP 分片及整图 SHA256、幂等重放、索引队列登记和 3 条旧链接通过；JPEG 沿用 Telegram 默认压缩。以下为独立开发项目参考命令，真实 CPU 降幅与学生余额尚未验收。
使用已经登录的 Catalyst CLI 1.29+、受支持且已打补丁的 Node 24；本地隔离构建验证版本为 24.22.1。
本机默认 Node 26.8.1 会触发已安装 CLI 的安全警告；部署前先把打补丁的 Node 24 放到当前进程 PATH，不修改全局运行时、不忽略警告。
在现有组织的独立开发项目操作，不新开付费账号、不启用 Production。

```bash
command -v catalyst
command -v wrangler
command -v node
node --version
node -e 'const [major,minor,patch]=process.versions.node.split(".").map(Number); require("node:assert/strict")(major===24 && (minor>22 || (minor===22 && patch>=1)), "先切换到已修补的 Node 24")'
catalyst whoami
catalyst project:list --org "$CATALYST_ORG_ID" --non-interactive
wrangler whoami
```

必须先确认当前组织的学生额度/有效期与开发环境计费。CLI 登录成功不代表仍有学生余额；本次没有核验实时余额，不能承诺永久免费。
2026-10-28 核对的官方现行免费层为每账号每月 25,000 GB-seconds Functions（跨组织/项目共用）；512 MiB、每次 5 秒约 10,000 次/月，须计入状态、分片及重试调用。超免费限额可能触发每项目至少 $5/月，不能把旧文档里的“开发环境永久免费”当作计费保证。先确认现有学生余额与到期日，不绑卡、不新购套餐；当前新客 $250/六个月优惠要求绑卡，不等同于学生额度。
同名 `imgbed_upload` 函数若已存在，停止并核对归属，不覆盖其他应用。
R2 模式需要**原桶**的 S3 写入凭据；CF 原生 R2 binding 不会自动出现在 Catalyst。

官方文档入口（执行前再次核对账号对应的限制）：
```text
https://docs.catalyst.zoho.com/en/serverless/help/functions/advanced-io
https://docs.catalyst.zoho.com/en/cli/v1/cli-command-reference
https://catalyst.zoho.com/free-tier/
https://docs.catalyst.zoho.com/en/deployment-and-billing/billing/free-tier/
```

## 2. 构建与本地验证

以下命令与 `.github/workflows/catalyst-upload.yml` 使用同一隔离构建方式，额外导出三个部署文件。依赖只安装到一次性目录，不改锁文件、不全局安装；`IMGBED_REPO` 必须是无 `.env`、数据目录或 CLI 凭据的源码 checkout。

```bash
set -eu
export IMGBED_REPO=/absolute/path/to/CloudFlare-ImgBed
umask 077
BUILD_TOOLS="$(mktemp -d)"
export BUILD_OUTPUT="$(mktemp -d)"
NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
docker pull "$NODE_IMAGE"
mkdir -p "$BUILD_TOOLS/deploy"
cp "$IMGBED_REPO/package.json" "$IMGBED_REPO/package-lock.json" "$BUILD_TOOLS/"
cp -R "$IMGBED_REPO/deploy/profiles" "$BUILD_TOOLS/deploy/"
docker run --rm --read-only --user "$(id -u):$(id -g)" --cap-drop ALL --security-opt no-new-privileges \
  --memory 1024m --cpus 1 --pids-limit 96 --ulimit fsize=268435456 \
  --tmpfs /tmp:rw,noexec,nosuid,size=128m --volume "$BUILD_TOOLS:/scratch:rw" \
  --workdir /scratch --entrypoint /usr/bin/env "$NODE_IMAGE" -i \
  HOME=/tmp TMPDIR=/tmp PATH=/usr/local/bin:/usr/bin:/bin NPM_CONFIG_CACHE=/tmp/npm \
  /usr/bin/timeout --signal=KILL 240 npm ci --ignore-scripts --no-audit --no-fund
test "$(du -sm "$BUILD_TOOLS" | cut -f1)" -lt 900
for file in index.cjs package.json catalyst-config.json; do : > "$BUILD_OUTPUT/$file"; done
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 1024m --cpus 1 --pids-limit 96 --ulimit cpu=120:125 \
  --ulimit fsize=8388608 --ulimit nofile=256:256 \
  --tmpfs /scratch:rw,nosuid,size=800m --tmpfs /tmp:rw,noexec,nosuid,size=32m --tmpfs /output:rw,noexec,nosuid,size=1m \
  --volume "$IMGBED_REPO:/source:ro" --volume "$BUILD_TOOLS:/dependencies:ro" \
  --volume "$BUILD_OUTPUT/index.cjs:/output/index.cjs:rw" \
  --volume "$BUILD_OUTPUT/package.json:/output/package.json:rw" \
  --volume "$BUILD_OUTPUT/catalyst-config.json:/output/catalyst-config.json:rw" \
  --workdir /scratch --entrypoint /usr/bin/env "$NODE_IMAGE" -i \
  HOME=/tmp TMPDIR=/tmp PATH=/usr/local/bin:/usr/bin:/bin TZ=UTC LC_ALL=C.UTF-8 \
  /usr/bin/timeout --signal=KILL 180 /bin/sh -ec '
    mkdir /scratch/project
    cp -R /source/functions /source/database /source/deploy /source/test /scratch/project/
    cp /source/package.json /source/package-lock.json /scratch/project/
    cd /scratch/project
    ln -s /dependencies/node_modules node_modules
    CATALYST_BUILD_TESTS=1 node deploy/catalyst/build.mjs
    node --test --test-concurrency=1 deploy/catalyst/build/catalyst-tests.cjs
    node --test --test-concurrency=1 test/uploadRegistration.test.mjs test/d1DatabaseShard.test.mjs test/indexManagerChunk.test.mjs test/telemetryDisabled.test.mjs
    for file in index.cjs package.json catalyst-config.json; do
      cp "deploy/catalyst/build/functions/imgbed_upload/$file" "/output/$file"
    done
  '
```

产物在 `$BUILD_OUTPUT`：独立 `index.cjs`、`package.json`、`catalyst-config.json`，无运行时 npm 安装要求，原生 `(req, res)` 导出。构建过程仅这三个限长文件可写到宿主机，测试临时文件随容器删除；依赖和导出目录由本次调用独占，完成部署准备后按绝对路径核对清理，不删除其他任务目录。
本任务实际测试在空环境、无外网、有限 CPU/内存的 Docker 容器执行；测试只使用假凭据、内存 SQLite 和本地 HTTP。
Node 测试覆盖原上传代码、TG 分片、R2 同桶同 key、HMAC、登记失败恢复、双库索引、旧链接与原生入口；不代表已测真实云端 CPU。
另外覆盖私有 S3/WebDAV/HF 的审查恢复、Discord PNG/GIF/WebP 原字节读取、分阶段回执冲突及旧空元数据保护。CI 不需要账号 secret，也不执行部署。

## 3. 仅准备开发环境及私有密钥

以下示例使用 bash，先显式填写独立开发项目/数据库，不使用生产项目名：

```bash
export IMGBED_REPO=/absolute/path/to/CloudFlare-ImgBed
export CATALYST_ORG_ID=YOUR_ORG_ID
export CATALYST_DEV_PROJECT_ID=YOUR_DEV_PROJECT_ID
export CF_DEV_PROJECT=YOUR_DEDICATED_DEV_PAGES_PROJECT
export CLOUDFLARE_ACCOUNT_ID=YOUR_EXISTING_CF_ACCOUNT_ID
export CF_DEV_PRIMARY=YOUR_DEV_PRIMARY_D1_NAME
export CF_IMGBED_URL=https://YOUR-DEV-IMGBED.pages.dev
umask 077
PRIVATE="$(mktemp -d)"
STAGING="$(mktemp -d)"
export PRIVATE STAGING
node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const client = randomBytes(32).toString('hex');
const service = randomBytes(32).toString('hex');
writeFileSync(`${process.env.PRIVATE}/catalyst.env`,
  `IMGBED_UPLOAD_TOKEN=${client}\nIMGBED_RELAY_SECRET=${service}\nCF_IMGBED_URL=${process.env.CF_IMGBED_URL}\n`, { mode: 0o600, flag: 'wx' });
writeFileSync(`${process.env.PRIVATE}/auto-trade.env`,
  `CATALYST_UPLOAD_TOKEN=${client}\nCF_IMGBED_URL=${process.env.CF_IMGBED_URL}\n`, { mode: 0o600, flag: 'wx' });
JS
set -a
source "$PRIVATE/catalyst.env"
set +a

cd "$IMGBED_REPO"
# 先另行备份开发双库。仅 PRIMARY 增加四张小表；不改 files/settings/索引表。
wrangler d1 execute "$CF_DEV_PRIMARY" --remote --file database/upload-relay.sql
# 密钥通过 stdin，禁止 set -x、echo、提交 env 或 catalyst-debug.log。
node -e 'process.stdout.write(process.env.IMGBED_RELAY_SECRET)' |
  wrangler pages secret put CATALYST_RELAY_SECRET --project-name "$CF_DEV_PROJECT"
# 独立开发 Pages 项目须已绑定原有 schema 的 img_d1 和 img_index。
wrangler pages deploy frontend-dist --project-name "$CF_DEV_PROJECT"

cd "$STAGING"
npm_config_ignore_scripts=true catalyst init --org "$CATALYST_ORG_ID" -p "$CATALYST_DEV_PROJECT_ID" -ni
npm_config_ignore_scripts=true catalyst functions:add --name imgbed_upload --type aio --stack node24 -ni
# 使用第 2 节隔离构建产物替换 STAGING 中 functions/imgbed_upload 的三个文件。
for file in index.cjs package.json catalyst-config.json; do
  test -s "$BUILD_OUTPUT/$file"
  cp "$BUILD_OUTPUT/$file" "$STAGING/functions/imgbed_upload/$file"
done
# 此时再注入下面的私有配置；不要对已注入密钥的目录运行仓库构建/测试代码。
node --input-type=module - "$STAGING/functions/imgbed_upload/catalyst-config.json" <<'JS'
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
const file = process.argv[2];
const config = JSON.parse(readFileSync(file, 'utf8'));
const names = ['IMGBED_UPLOAD_TOKEN','IMGBED_RELAY_SECRET','CF_IMGBED_URL',
  'R2_ENDPOINT','R2_BUCKET','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY',
  'IMGBED_UPLOAD_CHANNEL','IMGBED_UPLOAD_CHANNEL_NAME'];
config.deployment.env_variables = Object.fromEntries(names.filter(name => process.env[name]).map(name => [name, process.env[name]]));
writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
chmodSync(file, 0o600);
JS
catalyst serve --only functions:imgbed_upload
```

`catalyst-config.json` 的私有 env overlay 仅在本次 staging 中，禁止复制到仓库或发布日志。
覆盖构建会清空 overlay，故必须先构建再注入密钥。auto-trade **只读客户端 token，不接触 service HMAC key**。
客户端 token 使用 `X-Upload-Token` 请求头；`Authorization` 被 Catalyst 平台保留用于 OAuth，不能复用。
Catalyst 函数环境使用 `IMGBED_*`，由原生入口映射到内部配置；CF HMAC 及客户端环境变量名称不变，避免平台更新时拒绝 `CATALYST_*` 保留前缀。
如走 R2，注入 `R2_ENDPOINT/R2_BUCKET/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY`，限制到原桶；不使用临时本地文件系统当存储。
可通过 `IMGBED_UPLOAD_CHANNEL` 明确选择 `telegram/cfr2/s3/discord/huggingface/webdav`，以及可选 `IMGBED_UPLOAD_CHANNEL_NAME`；未设置时选第一个有启用渠道的类型。
配置由 CF 当前渠道读取，保留现有容量过滤、IP 查询/审查设置，不自动启用遥测或新审查。

## 4. 开发部署与客户端接入

开发环境本地验收后，才执行；不要添加 Production 参数：

```bash
cd "$STAGING"
catalyst deploy --only functions:imgbed_upload
catalyst functions:config imgbed_upload --memory 512
```

从 CLI 输出确认 Advanced I/O **完整调用 URL**。当前官方开发格式是 `https://<domain>.development.zohocatalyst.com/server/imgbed_upload/`，不是 Basic I/O 的 `/execute`；以该账号 CLI 实际输出为准，不盲目追加后缀。
将 `CATALYST_UPLOAD_URL=<实际完整 URL>` 加入私有 `auto-trade.env`，再按 auto-trade 文档启用和安装恢复进程。
切流前用真实图片在开发项目验证：小图、GIF/WebP、>16 MiB 图、中文名；重放同一请求；模拟登记失败并恢复；在原后台检索、读取/删除新图，并检查旧图。
生产切流另需显式授权，以及生产 D1 备份、回滚点和真实 CF CPU 指标；本说明不是生产部署授权。

## 5. 限制、恢复与回滚

Advanced I/O 官方上限 **30 秒**，应用在 25 秒中止请求；客户端默认下载 30 秒、网关调用 35 秒。
CF 签名窗口 300 秒、metadata body 32 KiB；全局最多 2 个上传租约、每分钟 20 次启动尝试，租约 45 秒；重试遵循 Retry-After。
同内容、文件名和类型产生同一 file ID；已完成任务返回原链接，登记失败持久保存小回执，只重试索引登记。
完整图片及失败意图保留在客户端私有 SQLite，未完成任务不按重试次数删除；需监控该盘空间并保持恢复服务运行。
auto-trade 的 >16 MiB Telegram 图片走 `prepare → part → part-receipt`：每次调用只上传一片，CF 只保存 provider file ID、SHA256 状态字和顺序，不保存图片字节。每片落盘后可跨 AIO 调用/进程重启继续；最终才登记索引，仍由原 `/file/` 重建完整图片。
已开启审查的私有 S3/WebDAV/HF 会先登记不可索引的临时元数据，让原 `/file/` 可读；回执丢失后只继续审查和最终登记，不重新上传。此过程不更改现有审查开关或全局遥测配置。
返回原 URL 是既有接口兼容行为，后台完成后结果可在队列查询；不会追改已经发出的历史消息。

**验收边界：** 已有“总传输耗时超过单次限额、每片在限额内”的跨调用 TG 恢复测试；不代表任意慢链路都能完成。每个 16 MiB 分片仍须在一次调用内完成，其他渠道仍使用上游单次请求逻辑；超过 25 秒会保留任务重试。若开发实测持续超时，必须再适配该渠道的持久分片/长任务，不能过滤图片或自动回退 CF。
非幂等存储（尤其 Telegram）在“存储已接收、回执尚未落盘”时发生进程硬终止，存在物理重复窗口；逻辑文件 ID 与登记可去重，但不承诺远端物理 exactly-once。
其他渠道复用上游代码；本次没有真实 Discord/HuggingFace/WebDAV 云端验收，也未核验学生余额或线上 CPU 降幅。

回滚只切 `IMGBED_UPLOAD_BACKEND=cloudflare` 并重启调用进程；不删 D1 表、图床记录、R2 对象或 TG 消息。
保留 Catalyst URL/token 与恢复进程直到旧队列排空，避免已上传未登记的图片丢失。没有失败后自动向旧 `/upload` 再传一次。
