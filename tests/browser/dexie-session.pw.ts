import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const code = ts.transpileModule(
  readFileSync(
    new URL('../fixtures/dexie-session.ts', import.meta.url),
    'utf8',
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
    },
  },
).outputText;
for (const scenario of [
  'cold',
  'local-recovery-profile',
  'local-recovery-preference-failure',
  'transport-replacement',
  'local-journal-cap',
  'expired-overflow',
  'expired-token-overflow',
  'ordinary-export',
  'queued-retry-complete',
  'queued-retry-interrupted',
  'switch-preservation',
  'rejoin-switch-preservation',
  'ordinary-refresh',
  'ordinary-refresh-capacity',
  'detach',
  'rejoin',
  'barrier',
  'join',
  'changed-join',
  'epoch',
  'account',
  'restart-cleanup',
  'archives',
  'offline-restore',
  'head',
  'sequence',
  'attached-cold',
  'pending-transport-signout',
  'pending-adoption-signout',
  'empty-pointer',
  'transport-retry',
  'creation',
  'expired-cold',
  'purge-times',
  'stale-purge',
  'late-buffer',
]) {
  test('persistent session: ' + scenario, async ({ page }) => {
    await page.goto('/?fixture');
    await expect(async () => {
      await page.evaluate(async () => {
        const path = '/src/lib/sync/session.ts';
        await import(/* @vite-ignore */ path);
      });
    }).toPass();
    const result = await page.evaluate(
      async ({ code, scenario }) => {
        const url = URL.createObjectURL(
          new Blob([code.replaceAll('../../src/', location.origin + '/src/')], {
            type: 'text/javascript',
          }),
        );
        try {
          return await (await import(/* @vite-ignore */ url)).run(scenario);
        } finally {
          URL.revokeObjectURL(url);
        }
      },
      { code, scenario },
    );
    expect(result).toBe('ok');
  });
}

test('managed disposable persistent Session lifecycle', async ({
  page,
  browserName,
}) => {
  test.skip(
    !process.env.SCRATCHTREE_SESSION_CONFIG || browserName !== 'chromium',
    'Explicit disposable session gate',
  );
  test.setTimeout(180000);
  const config = JSON.parse(
    readFileSync(process.env.SCRATCHTREE_SESSION_CONFIG!, 'utf8'),
  );
  const { databaseUrl, demoEmail } = config;
  if (
    databaseUrl !== 'https://zjf0aymuw.dexie.cloud' ||
    typeof demoEmail !== 'string' ||
    !demoEmail.endsWith('@demo.local')
  )
    throw Error('Disposable configuration required.');
  page.on('console', (msg) => {
    if (msg.text().startsWith('task4-managed:')) console.log(msg.text());
  });
  await page.goto('/?fixture');
  const src = ts.transpileModule(
    readFileSync(
      new URL('../fixtures/hosted-session.ts', import.meta.url),
      'utf8',
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ESNext,
      },
    },
  ).outputText;
  await expect(async () => {
    await page.evaluate(async () => {
      const path = '/src/lib/sync/session.ts';
      await import(/* @vite-ignore */ path);
    });
  }).toPass();
  const result = await page.evaluate(
    async ({ src, databaseUrl, demoEmail }) => {
      const url = URL.createObjectURL(
        new Blob([src.replaceAll('../../src/', location.origin + '/src/')], {
          type: 'text/javascript',
        }),
      );
      try {
        return await (
          await import(/* @vite-ignore */ url)
        ).run({ databaseUrl, demoEmail });
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    { src, databaseUrl, demoEmail },
  );
  expect(result.twoClients && result.itemsRemoved).toBe(true);
});
