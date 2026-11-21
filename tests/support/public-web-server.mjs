import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const directory = resolve(
  process.env.SCRATCHTREE_WEB_TEST_BUILD ?? 'public-web-dist',
);
let current = 'a';
/** @type {string[]} */
let requests = [];
/** @param {string | Buffer} bytes */
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** @type {Record<string, string>} */
const types = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

async function alternateAppearance() {
  const manifest = await readRelease();
  const file = manifest.files.find((entry) =>
    entry.path.startsWith('/_app/immutable/appearance.'),
  );
  if (!file) throw Error('Missing appearance script');
  const bytes =
    (await readFile(resolve(directory, '.' + file.path), 'utf8')) +
    '\ndocument.documentElement.dataset.scratchtreeFixtureRelease = "b";\n';
  const sha256 = digest(bytes);
  return {
    before: file.path,
    path: '/_app/immutable/appearance.' + sha256 + '.js',
    sha256,
    bytes,
  };
}

async function readRelease() {
  return /** @type {{ release: string, files: { path: string, sha256: string }[] }} */ (
    JSON.parse(await readFile(resolve(directory, 'app-release.json'), 'utf8'))
  );
}

createServer(async (request, response) => {
  try {
    const url = request.url ?? '/';
    const { pathname } = new URL(url, 'http://127.0.0.1');
    if (
      request.method === 'POST' &&
      /^\/__test_release\/(a|b|broken)$/.test(pathname)
    ) {
      current = pathname.slice('/__test_release/'.length);
      response.writeHead(204).end();
      return;
    }
    if (pathname === '/__test_requests') {
      if (request.method === 'POST') requests = [];
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(requests));
      return;
    }
    requests.push(url);
    const name = pathname === '/' ? '/index.html' : pathname;
    const file = resolve(directory, '.' + name);
    if (!file.startsWith(directory + sep)) throw Error('Outside build');
    /** @type {Buffer | string} */
    let bytes;
    if (current === 'b' && name.startsWith('/_app/immutable/appearance.')) {
      const appearance = await alternateAppearance();
      if (appearance.path !== name)
        throw Error('Appearance belongs to another release');
      bytes = appearance.bytes;
    } else bytes = await readFile(file);
    if (
      current !== 'a' &&
      (name === '/index.html' || name === '/app-release.json')
    ) {
      const manifest = await readRelease();
      let html = await readFile(resolve(directory, 'index.html'), 'utf8');
      if (current === 'b') {
        const marker = 'name="scratchtree-release" content="';
        html = html.replace(marker + manifest.release, marker);
        const appearance = await alternateAppearance();
        html = html.replace(appearance.before, appearance.path);
        manifest.files = manifest.files
          .map((entry) =>
            entry.path === appearance.before
              ? { path: appearance.path, sha256: appearance.sha256 }
              : entry,
          )
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        const shell = manifest.files.find(
          (entry) => entry.path === '/index.html',
        );
        if (!shell) throw Error('Missing shell');
        shell.sha256 = digest(html);
        manifest.release = digest(JSON.stringify(manifest.files));
        html = html.replace(marker, marker + manifest.release);
        shell.sha256 = digest(html);
      } else {
        const inventory = manifest.files.find((entry) =>
          entry.path.startsWith('/_app/immutable/'),
        );
        if (!inventory) throw Error('Missing asset');
        inventory.sha256 = '0'.repeat(64);
      }
      bytes = name === '/index.html' ? html : JSON.stringify(manifest);
    }
    const headers = process.env.SCRATCHTREE_WEB_TEST_BUILD
      ? ''
      : await readFile(resolve(directory, '_headers'), 'utf8');
    const contentSecurityPolicy = /^\s*Content-Security-Policy:\s*(.+)$/m.exec(
      headers,
    )?.[1];
    response
      .writeHead(200, {
        'Content-Type': types[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
        ...(contentSecurityPolicy
          ? { 'Content-Security-Policy': contentSecurityPolicy }
          : {}),
      })
      .end(bytes);
  } catch {
    response.writeHead(404).end();
  }
}).listen(Number(process.env.SCRATCHTREE_WEB_TEST_PORT ?? '4612'), '127.0.0.1');
