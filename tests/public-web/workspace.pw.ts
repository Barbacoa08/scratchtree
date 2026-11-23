import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('opens a real local workspace without sign-in and retains saved notes', async ({
  page,
}) => {
  const outside: string[] = [];
  page.context().on('request', (request) => {
    if (new URL(request.url()).hostname !== '127.0.0.1')
      outside.push(request.url());
  });
  await page.goto('/?fixture&authFixture');
  const composer = page.getByRole('textbox', { name: 'New note Markdown' });
  await expect(composer).toBeVisible();
  await expect(page.getByRole('button', { name: /Sign in/ })).toHaveCount(0);
  await composer.fill('**Local Markdown**');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Note stream' })
      .getByRole('article', { name: 'Saved note' })
      .getByText('Local Markdown', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByRole('region', { name: 'Note stream' })
      .getByRole('article', { name: 'Saved note' })
      .getByText('Local Markdown', { exact: true }),
  ).toBeVisible();
  expect(outside).toEqual([]);
  expect(
    await page.evaluate(async () =>
      (await indexedDB.databases()).map(({ name }) => name),
    ),
  ).toEqual(['scratchtree-local-v8']);
});

test('a second tab cannot edit until the first closes', async ({
  context,
  page,
}) => {
  await page.goto('/');
  await expect(
    page.getByRole('textbox', { name: 'New note Markdown' }),
  ).toBeVisible();
  const other = await context.newPage();
  await other.goto('/');
  await expect(
    other.getByText('Scratchtree is open in another tab', { exact: true }),
  ).toBeVisible();
  await expect(
    other.getByRole('textbox', { name: 'New note Markdown' }),
  ).toHaveCount(0);
  await page
    .getByRole('textbox', { name: 'New note Markdown' })
    .fill('Handoff note');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Note stream' })
      .getByRole('article', { name: 'Saved note' })
      .getByText('Handoff note', { exact: true }),
  ).toBeVisible();
  await page.close();
  await other.getByRole('button', { name: 'Try again' }).click();
  await expect(
    other
      .getByRole('region', { name: 'Note stream' })
      .getByRole('article', { name: 'Saved note' })
      .getByText('Handoff note', { exact: true }),
  ).toBeVisible();
});

test('an attached activation is left intact without contacting cloud services', async ({
  page,
}) => {
  const outside: string[] = [];
  page.context().on('request', (request) => {
    if (new URL(request.url()).hostname !== '127.0.0.1')
      outside.push(request.url());
  });
  await page.goto('/');
  await expect(
    page.getByRole('textbox', { name: 'New note Markdown' }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('scratchtree-local-v8');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction('deviceState', 'readwrite');
        tx.objectStore('deviceState').put({
          key: 'session-activation',
          value: {
            version: 1,
            mode: 'attached',
            cleanupNeeded: false,
            account: 'a'.repeat(64),
            baseline: null,
          },
        });
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      database.close();
    }
  });
  await page.reload();
  await expect(
    page.getByRole('heading', {
      name: /This version cannot open the existing notes/,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'New note Markdown' }),
  ).toHaveCount(0);
  expect(outside).toEqual([]);
  expect(
    await page.evaluate(async () =>
      (await indexedDB.databases()).map(({ name }) => name),
    ),
  ).toEqual(['scratchtree-local-v8']);
});

test('the deployed public artifact has no Scratchtree cloud endpoints', () => {
  const root = process.env.SCRATCHTREE_WEB_TEST_BUILD ?? 'public-web-dist';
  const manifest = JSON.parse(
    readFileSync(join(root, 'app-release.json'), 'utf8'),
  ) as {
    files: { path: string }[];
  };
  for (const { path } of manifest.files.filter(({ path }) =>
    path.endsWith('.js'),
  )) {
    const script = readFileSync(join(root, path), 'utf8');
    expect(script).not.toMatch(
      /dexie\.cloud|api\/account-exists|dexie-cloud-addon/,
    );
  }
});

test('a parked history entry cannot resume a stale editable workspace', async ({
  context,
  page,
}) => {
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'New note Markdown' });
  await composer.fill('Checkpoint on page hide');
  await page.evaluate(() =>
    dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
  );
  await expect(composer).toHaveCount(0);

  const newer = await context.newPage();
  await newer.goto('/');
  const reopened = newer.getByRole('textbox', { name: 'New note Markdown' });
  await expect(reopened).toHaveText('Checkpoint on page hide');
  await reopened.fill('Newer copy owns the editor');
  await expect(newer.getByText('Draft saved', { exact: true })).toBeAttached();

  await page.evaluate(() =>
    dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
  );
  await expect(
    page.getByText('Scratchtree is open in another tab', { exact: true }),
  ).toBeVisible();
  await expect(composer).toHaveCount(0);
});
