import { test, expect, type Page } from '@playwright/test';
import { MemoryRepository } from '../fixtures/memory';
import type { Repository } from '../../src/lib/platform/workspace';

async function repositoryMock(
  page: Page,
  fault: 'none' | 'save' | 'render',
  deniedStorage = false,
) {
  const repo = new MemoryRepository();
  if (fault === 'save') repo.fail = 'save';
  let saves = 0;
  // This bridge implements current typed Repository calls, not retired native IPC.
  await page.exposeFunction('__clientErrorLoad', () => repo.loadWorkspace());
  await page.exposeFunction(
    '__clientErrorCheckpoint',
    (...args: Parameters<Repository['checkpointDraft']>) =>
      repo.checkpointDraft(...args),
  );
  await page.exposeFunction(
    '__clientErrorCapture',
    (...args: Parameters<Repository['captureItem']>) => {
      saves++;
      return repo.captureItem(...args);
    },
  );
  await page.exposeFunction(
    '__clientErrorSave',
    (...args: Parameters<Repository['saveItemSource']>) => {
      saves++;
      return repo.saveItemSource(...args);
    },
  );
  if (deniedStorage)
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new Error('PRIVATE_STORAGE_ERROR');
        },
      });
    });
  return {
    repo,
    saveCalls: () => saves,
    url: '/?fixture&clientErrors' + (fault === 'render' ? '&renderFault' : ''),
  };
}
const capture = (page: Page) =>
  page.getByRole('textbox', { name: 'New note Markdown' });
async function typeCapture(page: Page, source: string) {
  await page.getByRole('region', { name: 'Note stream' }).focus();
  await page.keyboard.press('Space');
  await expect(capture(page)).toBeFocused();
  await page.keyboard.type(source);
  await page.keyboard.press('Enter');
}

test('ordinary shortcut submission retains the workspace and a usable second capture', async ({
  page,
}) => {
  const { repo, saveCalls, url } = await repositoryMock(page, 'none');
  await page.goto(url);
  await expect(capture(page)).toBeVisible();
  await typeCapture(page, 'First synthetic plain capture');
  await expect(capture(page)).toHaveText('');
  await expect(capture(page)).toBeFocused();
  await typeCapture(page, 'Second synthetic plain capture');
  await expect(page.getByRole('article', { name: 'Saved note' })).toHaveCount(
    2,
  );
  await expect(capture(page)).toBeFocused();
  expect(saveCalls()).toBe(2);
  expect(
    repo.snapshot.items
      .filter((x: any) => x.kind === 'note')
      .map((note) => note.markdown),
  ).toEqual([
    'First synthetic plain capture',
    'Second synthetic plain capture',
  ]);
  await expect(page.getByRole('button', { name: 'Reload view' })).toHaveCount(
    0,
  );
});

test('ordinary repository save rejection keeps input in the workspace without fatal fallback or retry', async ({
  page,
}) => {
  const { repo, saveCalls, url } = await repositoryMock(page, 'save');
  await page.goto(url);
  await expect(capture(page)).toBeVisible();
  await typeCapture(page, 'Retained synthetic capture');
  await expect(capture(page)).toHaveText('Retained synthetic capture');
  await expect(page.getByRole('button', { name: 'Reload view' })).toHaveCount(
    0,
  );
  expect(
    repo.snapshot.items.filter((x: any) => x.kind === 'note'),
  ).toHaveLength(0);
  expect(saveCalls()).toBe(1);
});

for (const deniedStorage of [false, true])
  test(`render fault shows safe explicit fallback without resubmission; storage denied=${deniedStorage}`, async ({
    page,
  }) => {
    const { repo, saveCalls, url } = await repositoryMock(
      page,
      'render',
      deniedStorage,
    );
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(url);
    await expect(capture(page)).toBeVisible();
    await typeCapture(page, 'Saved synthetic capture');
    const reload = page.getByRole('button', {
      name: 'Reload view',
      exact: true,
    });
    await expect(reload).toBeVisible();
    // Appearance outlives the failed page, including when preferences cannot
    // be stored. Changing the OS theme must keep recovery controls readable.
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('.error-page')).toHaveCSS(
      'background-color',
      'rgb(255, 255, 255)',
    );
    await expect(
      page.getByRole('heading', {
        name: 'The notes view encountered an error',
      }),
    ).toBeVisible();
    await expect(
      page.getByText(/Submitted notes may already be saved/),
    ).toBeVisible();
    const diagnostic = page.getByRole('textbox', {
      name: 'Diagnostic details',
    });
    await expect(diagnostic).toHaveValue(/ST-/);
    await expect(diagnostic).toHaveValue(/TypeError/);
    const safeDetails = await diagnostic.inputValue();
    expect(safeDetails).not.toContain('PRIVATE_');
    expect(JSON.parse(safeDetails).locations.length).toBeGreaterThan(0);
    expect(await page.locator('body').innerText()).not.toContain('PRIVATE_');
    expect(
      repo.snapshot.items.filter((x: any) => x.kind === 'note'),
    ).toHaveLength(1);
    expect(saveCalls()).toBe(1);
    await page.waitForTimeout(350);
    expect(saveCalls()).toBe(1);
    await reload.click();
    await expect(capture(page)).toBeVisible();
    await expect(page.getByRole('article', { name: 'Saved note' })).toHaveCount(
      1,
    );
    expect(
      repo.snapshot.items.filter((x: any) => x.kind === 'note')[0].markdown,
    ).toBe('Saved synthetic capture');
    expect(saveCalls()).toBe(1);
  });
