import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const adapterRoot = resolve(root, 'deploy/catalyst/adapters');
const aliases = new Map([
    ['functions/utils/sysConfig.js', 'config.js'],
    ['functions/utils/auth/userAuth.js', 'auth.js'],
    ['functions/utils/indexManager.js', 'index.js'],
    ['functions/utils/storage/s3Client.js', 's3Client.js'],
].map(([source, target]) => [resolve(root, source), resolve(adapterRoot, target)]));
const aliasPlugin = { name: 'catalyst-only-adapters', setup(builder) {
    builder.onResolve({ filter: /^\./ }, args => {
        let source = resolve(args.resolveDir, args.path);
        if (!source.endsWith('.js')) source += '.js';
        if (args.importer === resolve(adapterRoot, 's3Client.js')) return;
        const isUpload = args.importer.startsWith(resolve(root, 'functions/upload') + '/');
        const isFile = args.importer.startsWith(resolve(root, 'functions/file') + '/');
        if (!isUpload && !(isFile && source.endsWith('/storage/s3Client.js')) && args.importer !== resolve(root, 'functions/utils/purgeCache.js')) return;
        const target = aliases.get(source);
        if (target) return { path: target };
    });
} };

export async function buildGateway(output = resolve(root, 'deploy/catalyst/build')) {
    const destination = resolve(output, 'functions/imgbed_upload');
    await mkdir(destination, { recursive: true });
    const common = { absWorkingDir: root, bundle: true, platform: 'node', format: 'cjs', target: 'node24',
        plugins: [aliasPlugin], drop: ['console'], logLevel: 'warning' };
    await build({ ...common, entryPoints: ['deploy/catalyst/entry.cjs'], outfile: resolve(destination, 'index.cjs') });
    await writeFile(resolve(destination, 'package.json'), JSON.stringify({ name: 'imgbed-upload', private: true,
        type: 'commonjs', main: 'index.cjs' }, null, 2) + '\n');
    await writeFile(resolve(destination, 'catalyst-config.json'), JSON.stringify({
        deployment: { name: 'imgbed_upload', stack: 'node24', type: 'advancedio', env_variables: {} },
        execution: { main: 'index.cjs' },
    }, null, 2) + '\n');
    if (process.env.CATALYST_BUILD_TESTS === '1') {
        await build({ ...common, entryPoints: ['test/catalyst/upload.test.mjs'], outfile: resolve(output, 'catalyst-tests.cjs') });
    }
    return destination;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    await buildGateway(process.argv[2]);
}
