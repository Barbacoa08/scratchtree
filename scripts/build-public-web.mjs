import { createHash } from 'node:crypto';
import {
  copyFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const output = resolve(process.argv[2] ?? 'public-web-dist');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const immutable = '_app/immutable';
const shell = join(output, 'index.html');
let html = readFileSync(shell, 'utf8');

// Both classic scripts must retain their original position and execution order.
function script(name, bytes) {
  const path = `/${immutable}/${name}.${digest(bytes)}.js`;
  writeFileSync(join(output, path), bytes);
  return `<script src="${path}"></script>`;
}
if (
  !html.includes('<script src="/appearance.js"></script>') ||
  !/<script>[\s\S]*?<\/script>/.test(html)
) {
  throw new Error(
    'Expected the public appearance and SvelteKit startup scripts.',
  );
}
html = html
  .replace(
    '<script src="/appearance.js"></script>',
    script('appearance', readFileSync(join(output, 'appearance.js'))),
  )
  .replace(/<script>([\s\S]*?)<\/script>/g, (_, contents) =>
    script('start', contents),
  );
unlinkSync(join(output, 'appearance.js'));

// The blank release field avoids a circular hash of the HTML containing its own ID.
const headers = readFileSync(
  new URL('../deploy/web/_headers', import.meta.url),
);
const policy =
  '<meta name="scratchtree-headers" content="' + digest(headers) + '">';
const marker = '<meta name="scratchtree-release" content="">';
html = html.replace('</head>', policy + marker + '</head>');
writeFileSync(shell, html);
const paths = readdirSync(output, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name).slice(output.length))
  .sort();
const files = paths.map((path) => {
  if (!(
    path === '/index.html' ||
    path === '/_app/version.json' ||
    /^\/_app\/immutable\/[A-Za-z0-9_./-]+\.(js|css)$/.test(path)
  )) {
    throw new Error(`Unexpected public file: ${path}`);
  }
  return { path, sha256: digest(readFileSync(join(output, path))) };
});
const release = digest(JSON.stringify(files));
html = html.replace(
  marker,
  `<meta name="scratchtree-release" content="${release}">`,
);
writeFileSync(shell, html);
files.find(({ path }) => path === '/index.html').sha256 = digest(html);
writeFileSync(
  join(output, 'app-release.json'),
  JSON.stringify({ release, storage: 8, protocol: 1, files }),
);
writeFileSync(join(output, '_headers'), headers);
copyFileSync(
  new URL('../deploy/web/offline-worker.js', import.meta.url),
  join(output, 'offline-worker.js'),
);
