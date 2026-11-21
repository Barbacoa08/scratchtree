import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('built landing page', () => {
  it('offers the web editor alongside the Mac download', () => {
    execFileSync('node', ['website/build.mjs']);
    const html = readFileSync('website/dist/index.html', 'utf8');

    expect(html).toMatch(
      /<a\b[^>]*href="https:\/\/app\.scratchtree\.barbajoe\.tech\/"[^>]*>\s*Open web app\s*<\/a\s*>/,
    );
    const release = JSON.parse(readFileSync('website/release.json', 'utf8'));
    expect(html).toContain(release.downloadUrl);
    if (release.archDownloadUrl)
      expect(html).toContain(release.archDownloadUrl);
  });
});
