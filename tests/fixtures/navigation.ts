import { expect, type Page } from '@playwright/test';

/** Build nested synthetic locations without depending on a capture shortcut. */
export async function createTreeFixture(page: Page) {
  await page.evaluate(async () => {
    const controller = (window as any).__test.controller;
    const selected = document
      .querySelector('.note-card.selected')
      ?.getAttribute('data-entry-id');
    await controller.createTree(selected ?? undefined);
  });
  const capture = page.getByRole('textbox', { name: 'New note Markdown' });
  await expect(capture).toBeVisible();
  await capture.focus();
}
