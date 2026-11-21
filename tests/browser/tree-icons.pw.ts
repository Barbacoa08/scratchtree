import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';

// Pin the original small-tree artwork approved in option C, independently of Root.
const approvedTreePathSha256 =
  '6cc519a5035288a829f02fb74bc67148a0b128404bd24bfaf959a8b9e426c6a7';

for (const theme of ['light', 'dark'] as const) {
  for (const scale of [1, 1.5]) {
    test(`tree silhouette, saved color, and control geometry at ${scale * 100}% in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({
        width: scale === 1 ? 1100 : 1440,
        height: 800,
      });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto('/?fixture');
      await page.getByRole('textbox', { name: 'New note Markdown' }).waitFor();
      await page.evaluate(async () => {
        const t = (window as any).__test;
        t.seed({
          items: [
            {
              id: crypto.randomUUID(),
              markdown: 'Project notes\nA second row',
              kind: 'tree',
              color: 'blue',
            },
            { id: crypto.randomUUID(), markdown: 'A plain Markdown note' },
          ],
          drafts: [],
          undoDeleteIds: [],
        });
        await t.controller.start();
      });
      if (scale !== 1)
        await page.addStyleTag({
          content: ':root { font-size: 24px !important }',
        });
      await page.mouse.move(0, 0);
      const root = page.locator('.root-link svg');
      const rootPath = await root.locator('path').first().getAttribute('d');
      await expect(root).toHaveCSS('width', `${18 * scale}px`);
      await expect(root).toHaveCSS('height', `${18 * scale}px`);
      const card = page.locator('.note-card[data-kind="tree"]');
      const select = card.getByRole('button', {
        name: 'Select tree',
        exact: true,
      });
      await expect(select).toHaveCSS('width', `${24 * scale}px`);
      await expect(select).toHaveCSS('height', `${24 * scale}px`);
      const sidebarIcon = page.locator('.tree-link svg');
      const cardIcon = select.locator('svg');
      for (const icon of [sidebarIcon, cardIcon]) {
        await expect(icon.locator('path')).toHaveCount(1);
        // Containers retain the approved tree; Root has its own navigation mark.
        const path = await icon.locator('path').getAttribute('d');
        expect(createHash('sha256').update(path!).digest('hex')).toBe(
          approvedTreePathSha256,
        );
        expect(path).not.toBe(rootPath);
        await expect(icon).toHaveAttribute('viewBox', '0 0 16 16');
        await expect(icon).toHaveAttribute('aria-hidden', 'true');
        await expect(icon).toHaveAttribute('focusable', 'false');
        await expect(icon).toHaveCSS('stroke', 'none');
        const box = await icon.boundingBox();
        expect(box!.width).toBeCloseTo(13.258 * scale, 1);
        expect(box!.height).toBeCloseTo(13.258 * scale, 1);
      }
      await expect(sidebarIcon).toHaveCSS('fill', 'rgb(120, 172, 224)');
      const line = card.locator('.note-color');
      await expect(line).toBeVisible();
      const accent = await line.evaluate(
        (node) => getComputedStyle(node).backgroundColor,
      );
      await expect(cardIcon).toHaveCSS('fill', accent);
      const centers = await page.locator('.sidebar').evaluate((el) =>
        ['.root-link svg', '.tree-link svg'].map((selector) => {
          const r = el.querySelector(selector)!.getBoundingClientRect();
          return r.x + r.width / 2;
        }),
      );
      expect(Math.abs(centers[0] - centers[1])).toBeLessThanOrEqual(0.1);
      const icon = await cardIcon.boundingBox();
      const slot = await select.boundingBox();
      const rail = await line.boundingBox();
      expect(
        Math.abs(icon!.x + icon!.width / 2 - rail!.x - rail!.width / 2),
      ).toBeLessThanOrEqual(0.1);
      expect(
        Math.abs(icon!.y + icon!.height / 2 - slot!.y - slot!.height / 2),
      ).toBeLessThanOrEqual(0.1);
      await expect(select).toHaveAccessibleName('Select tree');
      await page.screenshot({
        path: testInfo.outputPath(`tree-icons-${theme}-${scale}.png`),
      });
      await card.locator('.note-body').hover();
      const handle = card.getByRole('button', { name: 'Reorder note' });
      await expect(handle).toHaveCSS('color', accent);
      expect(
        await handle.locator('path').evaluate((path: SVGPathElement) => {
          const dot = path
            .getPointAtLength(0)
            .matrixTransform(path.getScreenCTM()!);
          return (
            document.elementFromPoint(dot.x, dot.y)?.closest('.drag-handle') ===
            path.closest('.drag-handle')
          );
        }),
      ).toBe(true);
    });
  }
}
