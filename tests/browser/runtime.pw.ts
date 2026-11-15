import { test, expect } from '@playwright/test';
const composer = (page: import('@playwright/test').Page) =>
  page.getByRole('textbox', { name: 'New note Markdown' });

test('default entry opens a persistent local library with configured sign-in and no cloud request', async ({
  page,
}) => {
  const cloud: string[] = [];
  page.on('request', (request) => {
    if (/dexie\.cloud|scratchtree\.netlify\.app/.test(request.url()))
      cloud.push(request.url());
  });
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Sign in / sign up' }),
  ).toBeEnabled();
  await composer(page).fill('Synthetic local runtime **Markdown**');
  await composer(page).press('Enter');
  await expect(page.getByRole('article', { name: 'Saved note' })).toContainText(
    'Synthetic local runtime',
  );
  await page.reload();
  await expect(page.getByRole('article', { name: 'Saved note' })).toContainText(
    'Synthetic local runtime',
  );
  expect(cloud).toEqual([]);
});

for (const newerFocus of [false, true])
  test(`failed local opening announces pending retry, retains notes, and respects newer focus=${newerFocus}`, async ({
    page,
  }) => {
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: 'Sign in / sign up' }),
    ).toBeEnabled();
    await composer(page).fill('Retained before synthetic open failure');
    await composer(page).press('Enter');
    await expect(
      page.getByRole('article', { name: 'Saved note' }),
    ).toBeVisible();
    await page.addInitScript(() => {
      const open = IDBFactory.prototype.open;
      (window as any).__runtimeOpenMode = 'fail';
      // Intercept the factory so every database opened by the runtime is covered.
      IDBFactory.prototype.open = function (
        ...args: Parameters<IDBFactory['open']>
      ) {
        if ((window as any).__runtimeOpenMode === 'allow')
          return open.apply(this, args);
        const error = new DOMException(
          'Synthetic open failure',
          'NotReadableError',
        );
        if ((window as any).__runtimeOpenMode === 'fail') throw error;
        const request = {
          error,
          onerror: null as ((event: unknown) => void) | null,
        };
        (window as any).__rejectRuntimeOpen = () =>
          request.onerror?.({
            target: request,
            preventDefault() {},
            stopPropagation() {},
          });
        return request as unknown as IDBOpenDBRequest;
      };
    });
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Could not open your notes' }),
    ).toBeVisible();
    const retry = page.getByRole('button', { name: 'Retry opening notes' });
    await page.evaluate(() => {
      (window as any).__runtimeOpenMode = 'pending';
    });
    await retry.focus();
    await retry.press('Enter');
    const pending = page.getByRole('status');
    await expect(pending).toHaveText('Opening your notes…');
    await expect(retry).toBeDisabled();
    if (newerFocus) {
      await page.evaluate(() => {
        const button = document.createElement('button');
        button.textContent = 'Newer interaction';
        document.body.append(button);
        button.focus();
      });
    }
    await expect
      .poll(() =>
        page.evaluate(() => typeof (window as any).__rejectRuntimeOpen),
      )
      .toBe('function');
    await page.evaluate(() => (window as any).__rejectRuntimeOpen());
    await expect(retry).toBeEnabled();
    if (newerFocus)
      await expect(
        page.getByRole('button', { name: 'Newer interaction' }),
      ).toBeFocused();
    else await expect(retry).toBeFocused();
    await page.evaluate(() => {
      (window as any).__runtimeOpenMode = 'allow';
    });
    await retry.click();
    await expect(
      page.getByRole('article', { name: 'Saved note' }),
    ).toContainText('Retained before synthetic open failure');
  });

for (const malformed of [false, true])
  test(
    malformed
      ? 'cold malformed shared row stays exportable without deletion'
      : 'cold overflow exports all raw notes, removes the selected note, and reopens',
    async ({ page }) => {
      // Use the production route, Session, repository, and UI, with only the
      // authenticated transport and native file destination replaced on loopback.
      await page.route('**/src/lib/sync/session.ts*', async (route) => {
        const response = await route.fetch();
        const body = await response.text();
        await route.fulfill({
          response,
          body:
            body +
            `
      const originalOpen=PersistentSession.open.bind(PersistentSession);
      PersistentSession.open=opts=>originalOpen({...opts,
        createDatabase: ({name,databaseUrl})=>{
          const db=new ScratchtreeDatabase({name});
          if(databaseUrl){
            const idle={subscribe:()=>({unsubscribe(){}})};
            Object.defineProperty(db,'cloudEnabled',{value:true});
            Object.defineProperty(db,'cloud',{value:{
              currentUser:{getValue:()=>({isLoggedIn:true,userId:'synthetic-cold'})},
              events:{syncComplete:idle},syncState:idle,webSocketStatus:idle,
              sync:async()=>{},
            }});
          }
          return db;
        }
      });`,
        });
      });
      await page.goto('/');
      await expect(composer(page)).toBeVisible();
      await page.evaluate(async (invalid) => {
        const dbPath = '/src/lib/sync/database.ts',
          digestPath = '/src/lib/sync/intents.ts';
        const { ScratchtreeDatabase } = await import(/* @vite-ignore */ dbPath);
        const { digest } = await import(/* @vite-ignore */ digestPath);
        const account = await digest(['scratchtree-library', 'synthetic-cold']);
        const plain = new ScratchtreeDatabase({ name: 'scratchtree-local-v8' });
        const cloud = new ScratchtreeDatabase({ name: 'scratchtree-cloud-v8' });
        const epoch = crypto.randomUUID();
        const row = {
          epoch,
          kind: 'note',
          done: false,
          color: null,
          createdAt: 1,
          updatedAt: 1,
          placement: {
            parentId: null,
            deletedAt: null,
            restoreParentId: null,
            restoreIndex: null,
          },
        };
        await cloud.libraries.put({ id: account, epoch });
        await cloud.notes.bulkAdd([
          { ...row, id: crypto.randomUUID(), markdown: 'keep this note' },
          {
            ...row,
            id: crypto.randomUUID(),
            markdown: invalid
              ? 'malformed row exact source'
              : 'remove this row'.padEnd(1024 * 1024 + 1, 'x'),
            color: invalid ? 'invalid-color' : null,
          },
        ]);
        await plain.device.put({
          key: 'session-activation',
          value: {
            version: 1,
            mode: 'attached',
            account,
            baseline: null,
            cleanupNeeded: false,
          },
        });
        cloud.close();
        plain.close();
      }, malformed);
      await page.reload();
      const loading = page.getByRole('region', { name: 'Library loading' });
      await loading.getByRole('button', { name: 'Needs sync' }).click();
      await page.evaluate(() => {
        let content = '';
        (window as any).__TAURI_INTERNALS__ = {
          invoke: async (cmd: string, args: { chunk: string }) => {
            if (cmd === 'recovery_begin') return 'synthetic';
            if (cmd === 'recovery_append') content += args.chunk;
            if (cmd === 'recovery_finish')
              (window as any).__rawRows = JSON.parse(content).notes;
          },
        };
      });
      await loading
        .getByRole('button', { name: 'Export full raw library' })
        .click();
      await expect
        .poll(() => page.evaluate(() => (window as any).__rawRows?.length))
        .toBe(2);
      if (malformed) {
        await expect(
          loading.getByRole('button', { name: 'Review raw notes' }),
        ).toHaveCount(0);
        const preserved = await page.evaluate(async () => {
          const path = '/src/lib/sync/database.ts',
            repoPath = '/src/lib/sync/repository.ts',
            enginePath = '/src/lib/sync/engine.ts';
          const { ScratchtreeDatabase } = await import(/* @vite-ignore */ path);
          const { DexieRepository } = await import(/* @vite-ignore */ repoPath);
          const { SyncEngine } = await import(/* @vite-ignore */ enginePath);
          const db = new ScratchtreeDatabase({ name: 'scratchtree-cloud-v8' });
          const pointer = (await db.libraries.toArray())[0];
          const repo = new DexieRepository(db, {}, pointer.id);
          const engine = new SyncEngine({
            db,
            repository: repo,
            serialize: (work: () => Promise<unknown>) => work(),
          });
          try {
            const raw = (window as any).__rawRows.find(
              (row: { color: string }) => row.color === 'invalid-color',
            );
            let rejected = false;
            try {
              await engine.purgeOverflow({
                epoch: pointer.epoch,
                ids: [raw.id],
              });
            } catch {
              rejected = true;
            }
            const stored = await db.notes.get([pointer.epoch, raw.id]);
            return (
              rejected &&
              raw.markdown === 'malformed row exact source' &&
              stored?.markdown === raw.markdown &&
              stored.color === raw.color &&
              (await db.purges.count()) === 0 &&
              (await db.pending.count()) === 0
            );
          } finally {
            engine.close();
            repo.close();
          }
        });
        expect(preserved).toBe(true);
        return;
      }
      await loading.getByRole('button', { name: 'Review raw notes' }).click();
      const dialog = page.getByRole('dialog', { name: 'Recover merged notes' });
      await dialog.getByRole('checkbox', { name: /^remove this row/ }).check();
      await dialog
        .getByRole('button', { name: 'Permanently remove selected' })
        .click();
      await expect(dialog.getByText(/within its limits/)).toContainText(
        /Retry loading library.*drafts.*recovery/i,
      );
      await dialog.getByRole('button', { name: 'Close' }).click();
      await loading
        .getByRole('button', { name: 'Retry loading library' })
        .click();
      await expect(composer(page)).toBeVisible();
      await page.reload();
      await expect(
        page.getByRole('article', { name: 'Saved note' }),
      ).toHaveCount(1);
      await expect(
        page.getByText('keep this note', { exact: true }).first(),
      ).toBeVisible();
    },
  );

test('slow native startup explains system permission without taking newer focus', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).isTauri = true;
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      invoke: async () => {},
      transformCallback: () => 0,
    };
  });
  await page.route('**/src/lib/sync/session.ts*', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body:
        (await response.text()) +
        `
      const originalOpen = PersistentSession.open.bind(PersistentSession);
      PersistentSession.open = async options => {
        await options.beforeOpenCloudCache?.();
        window.__noticeBeforeOpen = Array.from(document.querySelectorAll('p')).some(node => node.textContent.includes('Scratchtree uses a protected key'));
        await new Promise(resolve => { window.__releaseStartup = resolve; });
        return originalOpen(options);
      };
    `,
    });
  });
  await page.goto('/');
  const opening = page.getByRole('region', { name: 'Opening notes' });
  await expect(opening.getByRole('status')).toHaveText('Opening your notes…');
  await expect(
    opening.getByText(/Scratchtree uses a protected key/),
  ).toBeVisible();
  expect(await page.evaluate(() => (window as any).__noticeBeforeOpen)).toBe(
    true,
  );
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.textContent = 'Newer startup focus';
    document.body.append(button);
    button.focus();
    (window as any).__releaseStartup();
  });
  await expect(composer(page)).toBeVisible();
  await expect(opening).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Newer startup focus' }),
  ).toBeFocused();
});

test('startup Retry reuses a slow opening and late success opens notes without restarting', async ({
  page,
}) => {
  await page.clock.install();
  await page.route('**/src/lib/sync/session.ts*', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body:
        (await response.text()) +
        `
      const originalOpen = PersistentSession.open.bind(PersistentSession);
      window.__startupAttempts = 0;
      PersistentSession.open = async options => {
        window.__startupAttempts++;
        await new Promise(resolve => { window.__releaseStartup = resolve; });
        return originalOpen(options);
      };
    `,
    });
  });
  await page.goto('/');
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).__releaseStartup))
    .toBe('function');
  await page.clock.fastForward(11000);
  await expect(
    page.getByRole('heading', { name: 'Notes are still opening' }),
  ).toBeVisible();
  const retry = page.getByRole('button', { name: 'Retry opening notes' });
  await retry.click();
  await expect(retry).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__startupAttempts)).toBe(1);
  await page.clock.fastForward(11000);
  await expect(retry).toBeEnabled();
  await page.evaluate(() => (window as any).__releaseStartup());
  await expect(composer(page)).toBeVisible();
  expect(await page.evaluate(() => (window as any).__startupAttempts)).toBe(1);
  await expect(retry).toHaveCount(0);
});

test('five-second startup recovery opens separate persistent local notes and fences late startup', async ({
  page,
}) => {
  await page.clock.install();
  const requests: string[] = [];
  page.on('request', (request) => {
    if (/dexie\.cloud|scratchtree\.netlify\.app/.test(request.url()))
      requests.push(request.url());
  });
  await page.route('**/src/lib/sync/session.ts*', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body:
        (await response.text()) +
        `
      const originalOpen = PersistentSession.open.bind(PersistentSession);
      window.__startupLateClosed = false;
      PersistentSession.open = async options => {
        if (options.useLocalRecovery || sessionStorage.getItem('synthetic-recovery-started')) { sessionStorage.setItem('synthetic-recovery-started', '1'); return originalOpen(options); }
        await new Promise(resolve => { window.__releasePreviousStartup = resolve; });
        return { close() { window.__startupLateClosed = true; } };
      };
    `,
    });
  });
  await page.goto('/');
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as any).__releasePreviousStartup),
    )
    .toBe('function');
  const local = page.getByRole('button', { name: 'Use separate local notes' });
  await page.clock.fastForward(5000);
  await expect(local).toBeEnabled();
  await expect(
    page.getByText(/Synced notes stay in\s+their existing cache/),
  ).toBeVisible();
  await local.click();
  await expect(composer(page)).toBeVisible();
  await composer(page).fill('Recovery library stays local');
  await composer(page).press('Enter');
  await expect(page.getByRole('article', { name: 'Saved note' })).toContainText(
    'Recovery library stays local',
  );
  await page.evaluate(() => (window as any).__releasePreviousStartup());
  await expect
    .poll(() => page.evaluate(() => (window as any).__startupLateClosed))
    .toBe(true);
  await expect(page.getByRole('article', { name: 'Saved note' })).toContainText(
    'Recovery library stays local',
  );
  await page.reload();
  await expect(page.getByRole('article', { name: 'Saved note' })).toContainText(
    'Recovery library stays local',
  );
  expect(requests).toEqual([]);
});

test('unavailable browser preferences do not block a healthy local notes library', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key: string) {
      if (key === 'scratchtree.startup-local-recovery')
        throw new DOMException('Synthetic denied preference', 'SecurityError');
      return getItem.call(this, key);
    };
  });
  await page.goto('/');
  await expect(composer(page)).toBeVisible();
  await composer(page).fill('IndexedDB works without browser preferences');
  await composer(page).press('Enter');
  await expect(page.getByRole('article', { name: 'Saved note' })).toContainText(
    'IndexedDB works without browser preferences',
  );
  await page.reload();
  await expect(page.getByRole('article', { name: 'Saved note' })).toContainText(
    'IndexedDB works without browser preferences',
  );
});
