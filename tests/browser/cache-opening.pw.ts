import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const fixture = ts
  .transpileModule(
    readFileSync(
      new URL('../fixtures/cache-opening.ts', import.meta.url),
      'utf8',
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ESNext,
      },
    },
  )
  .outputText.replaceAll('../../src/', '/src/');
for (const mode of [
  'retry',
  'dismiss',
  'startup',
  'abort',
  'abort-notice',
] as const) {
  test('blocked Dexie Cloud cache readiness: ' + mode, async ({ page }) => {
    let tokenRequests = 0;
    await page.route('https://**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === 'sdk-ready.invalid' && url.pathname === '/token') {
        tokenRequests++;
        await route.fulfill({
          json: { type: 'otp-sent', otp_id: 'synthetic' },
        });
      } else await route.fulfill({ status: 503, body: 'Offline' });
    });
    await page.route('**/tests/fixtures/cache-opening.ts', (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: fixture,
      }),
    );
    await page.goto('/?fixture');
    const result = await page.evaluate(async (mode) => {
      const path = '/tests/fixtures/cache-opening.ts';
      const { exercise } = await import(/* @vite-ignore */ path);
      return exercise(mode);
    }, mode);
    if (mode === 'retry') {
      expect(result).toEqual({
        phaseAtDeadline: 'email',
        openAtDeadline: true,
        phase: 'code',
        notices: [false],
        count: 1,
      });
      expect(tokenRequests).toBe(1);
    } else if (mode === 'dismiss') {
      expect(result).toEqual({
        phaseAtDeadline: 'email',
        openAtDeadline: true,
        phase: 'signed-out',
        open: false,
        count: 1,
      });
      expect(tokenRequests).toBe(0);
    } else if (mode === 'startup')
      expect(result).toEqual({
        pending: 'pending',
        outcome: 'opened',
        authenticated: true,
        notices: [true],
        count: 1,
      });
    else if (mode === 'abort')
      expect(result).toEqual({ outcome: 'rejected', open: false, count: 1 });
    else
      expect(result).toEqual({ outcome: 'rejected', notified: true, count: 0 });
  });
}
