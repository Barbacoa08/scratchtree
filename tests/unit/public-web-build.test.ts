import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function artifact(
  appearance: string,
  headers = readFileSync('deploy/web/_headers', 'utf8'),
) {
  const fixture = mkdtempSync(join(tmpdir(), 'scratchtree-public-build-'));
  directories.push(fixture);
  const dir = join(fixture, 'output');
  const script = join(fixture, 'scripts', 'build-public-web.mjs');
  mkdirSync(join(fixture, 'scripts'));
  mkdirSync(join(fixture, 'deploy/web'), { recursive: true });
  copyFileSync('scripts/build-public-web.mjs', script);
  copyFileSync(
    'deploy/web/offline-worker.js',
    join(fixture, 'deploy/web/offline-worker.js'),
  );
  writeFileSync(join(fixture, 'deploy/web/_headers'), headers);
  mkdirSync(join(dir, '_app/immutable'), { recursive: true });
  writeFileSync(join(dir, '_app/version.json'), '{"version":"public-web"}');
  writeFileSync(join(dir, '_app/immutable/entry.hash.js'), 'export default 1;');
  writeFileSync(join(dir, 'appearance.js'), appearance);
  writeFileSync(
    join(dir, 'index.html'),
    '<html><head><script src="/appearance.js"></script></head><body><script>import("/_app/immutable/entry.hash.js")</script></body></html>',
  );
  execFileSync(process.execPath, [script, dir]);
  return {
    dir,
    manifest: JSON.parse(readFileSync(join(dir, 'app-release.json'), 'utf8')),
  };
}

test('binds the shell to a content-derived release and inventories every executable asset', () => {
  const { dir, manifest } = artifact('self.appearance = 1');
  expect(artifact('self.appearance = 1').manifest).toEqual(manifest);
  expect(artifact('self.appearance = 2').manifest.release).not.toBe(
    manifest.release,
  );
  expect(manifest).toMatchObject({ storage: 8, protocol: 1 });
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  expect(html).toContain(
    `name="scratchtree-release" content="${manifest.release}"`,
  );
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('src="/appearance.js"');
  for (const attr of html.matchAll(/src="([^"]+)"/g)) {
    expect(attr[1]).toMatch(/^\/_app\/immutable\/.+\.js$/);
    expect(manifest.files.map((f: { path: string }) => f.path)).toContain(
      attr[1],
    );
  }
  for (const entry of manifest.files) {
    expect(
      createHash('sha256')
        .update(readFileSync(join(dir, entry.path)))
        .digest('hex'),
    ).toBe(entry.sha256);
  }
  const headers = readFileSync(join(dir, '_headers'), 'utf8');
  expect(headers).toContain("script-src 'self'");
  expect(headers).toContain("connect-src 'self'");
  expect(headers).toContain('/_app/immutable/*');
  expect(manifest.files.map((f: { path: string }) => f.path)).toEqual(
    expect.arrayContaining([
      '/index.html',
      '/_app/immutable/entry.hash.js',
      '/_app/version.json',
    ]),
  );
  expect(readFileSync(join(dir, 'offline-worker.js'), 'utf8')).toBe(
    readFileSync('deploy/web/offline-worker.js', 'utf8'),
  );
});

test('a header policy change produces a distinct release with identical scripts', () => {
  const headers = readFileSync('deploy/web/_headers', 'utf8');
  const source = 'self.appearance = 1';
  const before = artifact(source, headers);
  const after = artifact(
    source,
    headers.replace("img-src 'self' data:", "img-src 'self'"),
  );
  expect(after.manifest.release).not.toEqual(before.manifest.release);
});
