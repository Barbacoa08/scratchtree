import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import release from '../../src-tauri/tauri.conf.json';
import { scripts } from '../../package.json';

it('ordinary development and packaged previews never inherit the release identity or override shared window policy', () => {
  for (const script of ['tauri:dev', 'tauri:preview'] as const) {
    const command = (scripts as Record<string, string>)[script] ?? '';
    const words = command.split(/\s+/);
    const index = words.indexOf('--config');
    expect(
      index,
      `${script} must explicitly select a Preview configuration`,
    ).toBeGreaterThan(-1);
    const preview = JSON.parse(readFileSync(resolve(words[index + 1]), 'utf8'));
    expect(preview.identifier).not.toBe(release.identifier);
    expect(preview.identifier).toBe('tech.barbajoe.scratchtree.preview');
    expect(preview.productName).toBe('Scratchtree Preview');
    expect(preview.app?.windows).toBeUndefined();
  }
  expect(scripts['tauri:build']).not.toContain('--config');
  expect(release.identifier).toBe('tech.barbajoe.scratchtree');
});
