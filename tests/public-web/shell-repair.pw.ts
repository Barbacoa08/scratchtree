import { expect, test, type Page } from '@playwright/test';

async function discardAppFile(page: Page, shell: boolean) {
  return page.evaluate(async (shell) => {
    const release = document.querySelector<HTMLMetaElement>(
      'meta[name="scratchtree-release"]',
    )!.content;
    const cache = await caches.open('scratchtree-shell-release-1-' + release);
    const key = (await cache.keys()).find(({ url }) =>
      shell
        ? new URL(url).pathname === '/index.html'
        : url.includes('/immutable/') && url.endsWith('.js'),
    );
    if (!key || !(await cache.delete(key))) throw Error('Test file missing');
    return key.url;
  }, shell);
}

test.beforeEach(async ({ request, page }) => {
  await request.post('/__test_release/a');
  await page.goto('/');
  await expect(
    page.getByText('Ready to reopen offline', { exact: true }),
  ).toBeVisible();
});

test('a malformed manifest claiming the active release fails the explicit check', async ({
  page,
  request,
}) => {
  await request.post('/__test_release/broken');
  try {
    await page.getByRole('button', { name: 'Check for updates' }).click();
    await expect(
      page.getByText('Could not check for updates. Try again.', {
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await request.post('/__test_release/a');
  }
});

test('Check for updates repairs a missing file of the current release', async ({
  page,
}) => {
  const missing = await discardAppFile(page, false);
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await expect(page.getByText('Up to date', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      async (url) => Boolean(await caches.match(url)),
      missing,
    ),
  ).toBe(true);
});

test('a missing shell has an explicit repair action and preserves local notes', async ({
  page,
  request,
}) => {
  const source = 'Kept through shell repair';
  await page.getByRole('textbox', { name: 'New note Markdown' }).fill(source);
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Note stream' })
      .getByRole('article', { name: 'Saved note' })
      .getByText(source, { exact: true }),
  ).toBeVisible();
  await discardAppFile(page, true);
  await request.post('/__test_requests');
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Repair app files' }),
  ).toBeVisible();
  const log = (await (
    await request.get('/__test_requests')
  ).json()) as string[];
  expect(log.filter((path) => !path.startsWith('/offline-worker.js'))).toEqual(
    [],
  );
  await request.post('/__test_release/broken');
  try {
    await page.getByRole('button', { name: 'Repair app files' }).click();
    await expect(
      page.getByText(
        'Could not repair the app files. Check your connection and try again.',
      ),
    ).toBeVisible();
    await request.post('/__test_release/a');
    await page.getByRole('button', { name: 'Repair app files' }).click();
    await expect(
      page
        .getByRole('region', { name: 'Note stream' })
        .getByRole('article', { name: 'Saved note' })
        .getByText(source, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Ready to reopen offline', { exact: true }),
    ).toBeVisible();
  } finally {
    await request.post('/__test_release/a');
  }
});

test('a form on another origin cannot trigger a repair download', async ({
  page,
  request,
  baseURL,
}) => {
  const foreign = new URL('/form', baseURL);
  foreign.hostname = 'localhost';
  const repair = new URL('/__scratchtree_repair', baseURL).href;
  await page.route(foreign.href, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<form action="${repair}" method="post"><button>Submit</button></form>`,
    }),
  );
  await page.goto(foreign.href);
  await request.post('/__test_requests');
  await page.getByRole('button', { name: 'Submit' }).click();
  await page.waitForURL(repair);
  const log = (await (
    await request.get('/__test_requests')
  ).json()) as string[];
  expect(log).not.toContain('/app-release.json');
});

test('a lost apply acknowledgment reopens the committed release after saving the draft', async ({
  page,
  request,
}) => {
  const meta = page.locator('meta[name="scratchtree-release"]');
  const old = await meta.getAttribute('content');
  await request.post('/__test_release/b');
  try {
    await page.getByRole('button', { name: 'Check for updates' }).click();
    await expect(
      page.getByText('Update available', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('textbox', { name: 'New note Markdown' })
      .fill('Draft across a lost update reply');
    await page.evaluate(() => {
      const worker = navigator.serviceWorker.controller!;
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (
        message: { action: string },
        transfer?: Transferable[] | StructuredSerializeOptions,
      ) => {
        if (message.action === 'apply') {
          const dropped = new MessageChannel();
          dropped.port1.onmessage = ({ data }) => {
            if (typeof data?.value === 'string')
              sessionStorage.setItem('test-apply-committed', data.value);
            dropped.port1.close();
          };
          return post(message, [dropped.port2]);
        }
        return Array.isArray(transfer)
          ? post(message, transfer)
          : post(message, transfer);
      };
    });
    await page.getByRole('button', { name: 'Apply update' }).click();
    await expect
      .poll(() =>
        page.evaluate(() => sessionStorage.getItem('test-apply-committed')),
      )
      .toBeTruthy();
    await expect(meta).not.toHaveAttribute('content', old!, { timeout: 10000 });
    await expect(
      page.getByRole('textbox', { name: 'New note Markdown' }),
    ).toHaveText('Draft across a lost update reply');
  } finally {
    await request.post('/__test_release/a');
  }
});

test('a departed tab checking online cannot block the next local editor', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'Chromium exposes service-worker requests for interception.',
  );
  let observed!: () => void;
  const started = new Promise<void>((resolve) => {
    observed = resolve;
  });
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  await context.route('**/app-release.json', async (route) => {
    observed();
    await gate;
    await route.continue().catch(() => {});
  });
  try {
    await page.getByRole('button', { name: 'Check for updates' }).click();
    await started;
    await page.close();
    const next = await context.newPage();
    await next.goto('/');
    await expect(
      next.getByRole('textbox', { name: 'New note Markdown' }),
    ).toBeVisible();
    await expect(
      next.getByText('Ready to reopen offline', { exact: true }),
    ).toBeVisible();
  } finally {
    resume();
  }
});
