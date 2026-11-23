import {
  chromium,
  expect,
  firefox,
  test,
  webkit,
  type Page,
} from '@playwright/test';

async function save(page: Page, source: string) {
  await page.getByRole('textbox', { name: 'New note Markdown' }).fill(source);
  await page.getByRole('button', { name: 'Save note' }).click();
}

test('the published editor reopens offline after a browser restart', async ({
  baseURL,
  browserName,
  request,
}, info) => {
  await request.post('/__test_release/a');
  const profile = info.outputPath('profile');
  const engine = { chromium, firefox, webkit }[browserName];
  const channel =
    process.env.SCRATCHTREE_WEB_BROWSER === 'chrome' ? 'chrome' : undefined;
  let context = await engine.launchPersistentContext(profile, {
    baseURL,
    channel,
  });
  try {
    let page = context.pages()[0];
    await page.goto('/');
    await expect(
      page.getByText('Ready to reopen offline', { exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await save(page, 'Offline **note**');
    await expect(
      page
        .getByRole('region', { name: 'Note stream' })
        .getByRole('article', { name: 'Saved note' })
        .getByText('Offline note', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('textbox', { name: 'New note Markdown' })
      .fill('Offline draft');
    await expect(page.getByText('Draft saved', { exact: true })).toBeAttached();
    await context.close();

    context = await engine.launchPersistentContext(profile, {
      baseURL,
      channel,
      offline: true,
    });
    page = context.pages()[0];
    await page.goto('/');
    await expect(
      page
        .getByRole('region', { name: 'Note stream' })
        .getByRole('article', { name: 'Saved note' })
        .getByText('Offline note', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('textbox', { name: 'New note Markdown' }),
    ).toHaveText('Offline draft');
    await page.getByRole('button', { name: 'Export backup' }).click();
    await expect(
      page.getByRole('link', { name: 'Download backup' }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test('ordinary use after preparation makes no app requests to the server', async ({
  page,
  request,
}) => {
  await request.post('/__test_release/a');
  const external: string[] = [];
  page.context().on('request', (entry) => {
    if (new URL(entry.url()).hostname !== '127.0.0.1')
      external.push(entry.url());
  });
  await page.goto('/');
  await expect(
    page.getByText('Ready to reopen offline', { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await request.post('/__test_requests');
  await page.reload();
  await save(page, '![external](https://example.invalid/private.png)');
  await expect(
    page
      .getByRole('article', { name: 'Saved note' })
      .getByText('[Image: external]', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Export backup' }).click();
  await expect(
    page.getByRole('link', { name: 'Download backup' }),
  ).toBeVisible();
  const log = (await (
    await request.get('/__test_requests')
  ).json()) as string[];
  expect(log.filter((path) => !path.startsWith('/offline-worker.js'))).toEqual(
    [],
  );
  expect(external).toEqual([]);
});

test('an incomplete initial asset cache leaves editing available', async ({
  page,
  request,
}) => {
  await request.post('/__test_release/broken');
  try {
    await page.goto('/');
    await expect(
      page.getByText(/Offline reopening is unavailable/),
    ).toBeVisible({ timeout: 15000 });
    await save(page, 'Keep this local note');
    await expect(
      page
        .getByRole('region', { name: 'Note stream' })
        .getByRole('article', { name: 'Saved note' })
        .getByText('Keep this local note', { exact: true }),
    ).toBeVisible();
  } finally {
    await request.post('/__test_release/a');
  }
});

test('a release is adopted only after an explicit check and apply', async ({
  page,
  request,
}) => {
  await request.post('/__test_release/a');
  await page.goto('/');
  await expect(
    page.getByText('Ready to reopen offline', { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  const release = page.locator('meta[name="scratchtree-release"]');
  const initial = await release.getAttribute('content');
  await save(page, 'Survives update');
  await expect(
    page
      .getByRole('region', { name: 'Note stream' })
      .getByRole('article', { name: 'Saved note' })
      .getByText('Survives update', { exact: true }),
  ).toBeVisible();
  try {
    await request.post('/__test_release/broken');
    await page.getByRole('button', { name: 'Check for updates' }).click();
    await expect(
      page.getByText('Could not check for updates. Try again.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('region', { name: 'Note stream' })
        .getByRole('article', { name: 'Saved note' })
        .getByText('Survives update', { exact: true }),
    ).toBeVisible();
    await request.post('/__test_release/b');
    await page.reload();
    await expect(release).toHaveAttribute('content', initial!);
    await page
      .getByRole('textbox', { name: 'New note Markdown' })
      .fill('Keep the draft');
    await page.getByRole('button', { name: 'Check for updates' }).click();
    await expect(
      page.getByText('Update available', { exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await expect(release).toHaveAttribute('content', initial!);
    await page.evaluate(() => {
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'deviceDrafts')
          throw new DOMException('Synthetic quota error', 'QuotaExceededError');
        return originalPut.apply(this, args);
      };
      window.addEventListener(
        'scratchtree-test-restore-writes',
        () => {
          IDBObjectStore.prototype.put = originalPut;
        },
        { once: true },
      );
    });
    await page
      .getByRole('textbox', { name: 'New note Markdown' })
      .fill('Newer draft with a failed save');
    await page.getByRole('button', { name: 'Apply update' }).click();
    await expect(
      page.getByText('Save your changes before applying the update.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(release).toHaveAttribute('content', initial!);
    await expect(
      page.getByRole('textbox', { name: 'New note Markdown' }),
    ).toHaveText('Newer draft with a failed save');
    await page.evaluate(() =>
      window.dispatchEvent(new Event('scratchtree-test-restore-writes')),
    );
    await page.getByRole('button', { name: 'Apply update' }).click();
    await expect(release).not.toHaveAttribute('content', initial!);
    await expect(page.locator('html')).toHaveAttribute(
      'data-scratchtree-fixture-release',
      'b',
    );
    await expect(
      page
        .getByRole('region', { name: 'Note stream' })
        .getByRole('article', { name: 'Saved note' })
        .getByText('Survives update', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('textbox', { name: 'New note Markdown' }),
    ).toHaveText('Newer draft with a failed save');
  } finally {
    await request.post('/__test_release/a');
  }
});
