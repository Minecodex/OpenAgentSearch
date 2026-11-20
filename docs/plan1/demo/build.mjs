import { copyFile, mkdir, mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const modules = resolve(process.env.OAS_DEMO_MODULES || join(root, 'node_modules'));
const requireFromInstall = createRequire(join(dirname(modules), 'package.json'));
const { build } = requireFromInstall('esbuild');
const assets = join(root, 'assets');
await mkdir(assets, { recursive: true });

// A classic bundle also runs when the user opens the HTML from the filesystem.
const parseYaml = requireFromInstall('yaml').parse;
const specs = {};
for (const group of ['business', 'management']) {
  const file = join(root, '../contracts', group + '.openapi.yaml');
  specs[group] = parseYaml(await readFile(file, 'utf8'));
}
function dereference(value, group) {
  if (!value?.$ref) return value || {};
  const [file, ptr] = value.$ref.split('#');
  const owner = file.includes('business.openapi') ? 'business' : group;
  return ptr
    .slice(1)
    .split('/')
    .reduce((node, k) => node[k], specs[owner]);
}
function typeName(shape) {
  if (shape.enum) return shape.enum.join(' | ');
  if (shape.type) return Array.isArray(shape.type) ? shape.type.join(' | ') : shape.type;
  if (shape.anyOf) return shape.anyOf.map((s) => s.type || 'object').join(' | ');
  return 'object';
}
const operations = [];
for (const [group, spec] of Object.entries(specs)) {
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const input = dereference(op.requestBody?.content?.['application/json']?.schema, group);
      const fields = Object.entries(input.properties || {}).map(([name, property]) => ({
        name,
        type: typeName(dereference(property, group)),
        required: (input.required || []).includes(name),
        location: 'body',
      }));
      for (const raw of op.parameters || []) {
        const param = dereference(raw, group);
        fields.push({
          name: param.name,
          type: typeName(dereference(param.schema, group)),
          required: param.required === true,
          location: param.in,
        });
      }
      operations.push({
        method: method.toUpperCase(),
        path,
        id: op.operationId,
        area: path.startsWith('/health/') ? 'health' : group,
        summary: op.summary,
        fields,
        statuses: Object.keys(op.responses),
        auth: (op.security || spec.security || []).flatMap(Object.keys),
      });
    }
  }
}
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/main.tsx'],
  outfile: join(assets, 'console.js'),
  bundle: true,
  treeShaking: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  metafile: true,
  plugins: [
    {
      name: 'local-openapi',
      setup(b) {
        b.onResolve({ filter: /^oas:contracts$/ }, () => ({ path: 'operations', namespace: 'oas' }));
        b.onLoad({ filter: /.*/, namespace: 'oas' }, () => ({
          loader: 'json',
          contents: JSON.stringify(operations),
        }));
      },
    },
  ],
  nodePaths: [modules],
  define: { 'process.env.NODE_ENV': '"production"' },
});
const scratch = await mkdtemp(join(dirname(modules), '.oas-demo-css-'));
const input = join(scratch, 'input.css');
try {
  await copyFile(join(root, 'styles/heroui-entry.css'), input);
  const cli = join(modules, '@tailwindcss/cli/dist/index.mjs');
  const run = spawnSync(process.execPath, [cli, '-i', input, '-o', join(assets, 'heroui.css'), '--minify'], {
    cwd: scratch,
    stdio: 'inherit',
  });
  if (run.status !== 0) throw Error('HeroUI style build failed.');
} finally {
  await unlink(input);
  await rmdir(scratch);
}
const fonts = [
  ['@fontsource-variable/geist', 'geist-latin-wght-normal.woff2', 'geist.woff2'],
  ['@fontsource/ibm-plex-mono', 'ibm-plex-mono-latin-400-normal.woff2', 'mono.woff2'],

];
for (const [pkg, src, dst] of fonts) await copyFile(join(modules, pkg, 'files', src), join(assets, dst));
const packages = new Set([...fonts.map((f) => f[0]), '@heroui/styles', 'tailwindcss', 'tw-animate-css']);
for (const inputPath of Object.keys(result.metafile.inputs)) {
  const names = inputPath.replaceAll('\\', '/').split('/node_modules/').at(-1);
  if (!names || (names === inputPath && !names.startsWith('node_modules/'))) continue;
  const path = names.replace(/^node_modules\//, '').split('/');
  packages.add(path[0].startsWith('@') ? path.slice(0, 2).join('/') : path[0]);
}
const notices = new Map();
for (const name of [...packages].sort()) {
  const folder = join(modules, name);
  const items = await readdir(folder).catch(() => []);
  const licenses = items.filter((n) => /^(license|licence|ofl|notice)(\..*)?$/i.test(n));
  for (const f of licenses) {
    const license = (await readFile(join(folder, f), 'utf8')).replaceAll('\r\n', '\n').trim();
    if (!notices.has(license)) notices.set(license, []);
    notices.get(license).push(name);
  }
}
await writeFile(
  join(assets, 'THIRD_PARTY_NOTICES.txt'),
  [...notices]
    .map(([license, names]) => names.join(', ') + '\n\n' + license)
    .join('\n\n' + '='.repeat(56) + '\n\n') + '\n',
);
console.log('Built the offline Atlas workspace.');
