import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('built landing page', () => {
  it('offers the web editor and both current installers as download actions', () => {
    execFileSync('node', ['website/build.mjs']);
    const html = readFileSync('website/dist/index.html', 'utf8');
    const actions = /<div class="download-actions">([\s\S]*?)<\/div>/.exec(
      html,
    )?.[1];
    const links = actions?.match(/<a\b[^>]*>[\s\S]*?<\/a\s*>/g) ?? [];
    const release = JSON.parse(readFileSync('website/release.json', 'utf8'));

    expect(links).toHaveLength(3);
    const [web, mac, arch] = links;
    expect(web).toContain('href="https://app.scratchtree.barbajoe.tech/"');
    expect(web).toContain('Open web app');
    expect(mac).toContain(`href="${release.downloadUrl}"`);
    expect(mac).toContain('Download for Apple Silicon Mac');
    expect(arch).toContain(`href="${release.archDownloadUrl}"`);
    expect(arch).toContain('class="download"');
    expect(arch).toContain('aria-describedby="arch-preview-scope"');
    expect(arch).toContain('Download for Arch Linux x86_64 Preview');
  });
});
