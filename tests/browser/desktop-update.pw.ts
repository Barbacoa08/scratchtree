import { expect, test } from '@playwright/test';

test('the footer is hidden when the native update check has no offer', async ({
  page,
}) => {
  await page.goto('/?fixture&desktopUpdate=none');
  await expect(
    page.getByRole('textbox', { name: 'New note Markdown' }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Scratchtree update' }),
  ).toHaveCount(0);
});

test('the version and full-width button sit above the account and cancel returns focus', async ({
  page,
}) => {
  await page.goto('/?fixture&desktopUpdate=mac');
  const footer = page.getByRole('region', { name: 'Scratchtree update' });
  const button = footer.getByRole('button', { name: 'Update now' });
  await expect(footer).toContainText('Version 0.2.9');
  const gutters = await button.evaluate((element) => {
    const footer = element.closest('section')!.getBoundingClientRect();
    const button = element.getBoundingClientRect();
    return [
      button.left - footer.left,
      footer.right - button.right,
      button.width,
    ];
  });
  expect(gutters[0]).toBeGreaterThan(12);
  expect(Math.abs(gutters[0] - gutters[1])).toBeLessThan(1);
  expect(gutters[2]).toBeGreaterThan(100);
  await button.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', {
    name: 'Update to Scratchtree 0.2.9',
  });
  await expect(dialog.getByRole('button', { name: 'Later' })).toBeFocused();
  await dialog.getByText('What’s new', { exact: true }).click();
  await expect(dialog.getByText('Synthetic release notes.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(button).toBeFocused();
  expect(
    await page.evaluate(() => (window as any).__desktopUpdateTest.installed),
  ).toEqual([]);
});

test('failed draft save refuses installation, then Retry installs the captured version after saving', async ({
  page,
}) => {
  await page.goto('/?fixture&desktopUpdate=mac');
  const editor = page.getByRole('textbox', { name: 'New note Markdown' });
  await editor.focus();
  await page.evaluate(() => {
    (window as any).__test.repo.fail = 'checkpoint';
  });
  await page.keyboard.insertText('Keep this unsent update-test draft.');
  await page.getByRole('button', { name: 'Update now' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Update and restart' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Could not save');
  expect(
    await page.evaluate(() => (window as any).__desktopUpdateTest.installed),
  ).toEqual([]);
  await page.evaluate(() => {
    (window as any).__test.repo.fail = null;
  });
  await dialog.getByRole('button', { name: 'Retry update' }).click();
  await expect(dialog.getByRole('status')).toContainText(
    'Restarting Scratchtree',
  );
  const evidence = await page.evaluate(
    () => (window as any).__desktopUpdateTest,
  );
  expect(evidence.installed).toEqual(['0.2.9']);
  expect(evidence.draftsAtInstall).toContain(
    'Keep this unsent update-test draft.',
  );
});

test('Arch offers a package-manager handoff instead of installing from the app', async ({
  page,
}) => {
  await page.goto('/?fixture&desktopUpdate=arch');
  await page.getByRole('button', { name: 'View update' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('sudo pacman -Syu scratchtree-preview');
  await dialog.getByRole('button', { name: 'Copy update command' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Update command copied.');
  const evidence = await page.evaluate(
    () => (window as any).__desktopUpdateTest,
  );
  expect(evidence.copied).toEqual(['sudo pacman -Syu scratchtree-preview']);
  expect(evidence.installed).toEqual([]);
  await page.evaluate(() => {
    (window as any).__desktopUpdateTest.failCopy = true;
  });
  await dialog.getByRole('button', { name: 'Copy update command' }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    'Could not copy the command',
  );
  await expect(dialog.getByRole('status')).toBeEmpty();
});

test('a running update cannot be submitted twice or dismissed, and failure releases the editor', async ({
  page,
}) => {
  await page.goto('/?fixture&desktopUpdate=mac&lifecycle');
  await page.getByRole('button', { name: 'Update now' }).click();
  await page.evaluate(() => {
    (window as any).__desktopUpdateTest.holdInstall = true;
  });
  const dialog = page.getByRole('dialog');
  const confirm = dialog.getByRole('button', { name: 'Update and restart' });
  await confirm.click();
  await expect(dialog.getByRole('status')).toContainText(
    'Downloading and installing',
  );
  await expect(confirm).toBeDisabled();
  await confirm.press('Enter');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  const closeState = await page.evaluate(async () => {
    const fixture = (window as any).__test;
    await fixture.requestClose();
    return fixture.windowState;
  });
  expect(closeState.prevented).toBe(1);
  expect(closeState.hideAttempts).toBe(0);
  await page.evaluate(() =>
    (window as any).__desktopUpdateTest.finishInstall(true),
  );
  await expect(dialog.getByRole('alert')).toContainText(
    'Could not install the update',
  );
  const versions = await page.evaluate(
    () => (window as any).__desktopUpdateTest.installed,
  );
  expect(versions).toEqual(['0.2.9']);
  await dialog.getByRole('button', { name: 'Later' }).click();
  await expect(page.getByRole('button', { name: 'Update now' })).toBeFocused();
  await expect(
    page.getByRole('textbox', { name: 'New note Markdown' }),
  ).toBeEditable();
});

test('the footer stays inside the narrow sidebar in light appearance', async ({
  page,
}) => {
  await page.setViewportSize({ width: 620, height: 500 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/?fixture&desktopUpdate=mac');
  const footer = page.getByRole('region', { name: 'Scratchtree update' });
  const button = footer.getByRole('button', { name: 'Update now' });
  await expect(button).toBeVisible();
  const fits = await button.evaluate((element) => {
    const sidebar = element.closest('aside')!;
    const edge = element.getBoundingClientRect();
    const rail = sidebar.getBoundingClientRect();
    return edge.left > rail.left && edge.right < rail.right;
  });
  expect(fits).toBe(true);
  expect(
    await footer.evaluate((element) => {
      const account = element.closest('aside')!.querySelector('.auth-footer')!;
      return Boolean(
        element.compareDocumentPosition(account) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }),
  ).toBe(true);
});

test('a close already waiting on its save keeps the update button unavailable', async ({
  page,
}) => {
  await page.goto('/?fixture&desktopUpdate=mac&lifecycle');
  const trigger = page.getByRole('button', { name: 'Update now' });
  await expect(trigger).toBeEnabled();
  const editor = page.getByRole('textbox', { name: 'New note Markdown' });
  await editor.focus();
  await page.evaluate(() => (window as any).__test.delayCheckpoint());
  await page.keyboard.insertText('Pending close draft.');
  await page.evaluate(() => {
    void (window as any).__test.requestClose();
  });
  await expect(trigger).toBeDisabled();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => (window as any).__test.releaseCheckpoint());
  await expect
    .poll(() => page.evaluate(() => (window as any).__test.windowState.hidden))
    .toBe(1);
  await expect(trigger).toBeEnabled();
});

test('a recovery blocker raised while saving stops the pending Mac update', async ({
  page,
}) => {
  await page.goto('/?fixture&desktopUpdate=mac&authFixture');
  const editor = page.getByRole('textbox', { name: 'New note Markdown' });
  await editor.focus();
  await page.evaluate(() => (window as any).__test.delayCheckpoint());
  await page.keyboard.insertText('Keep this draft for recovery.');
  await page.getByRole('button', { name: 'Update now' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Update and restart' }).click();
  await expect(dialog.getByRole('status')).toContainText(
    'Saving notes and drafts',
  );
  await page.evaluate(() => {
    (window as any).authUiFixture.setSync({ readOnlyRecovery: true });
    (window as any).__test.releaseCheckpoint();
  });
  await expect(dialog.getByRole('alert')).toContainText(
    'Finish the current operation or recovery',
  );
  expect(
    await page.evaluate(() => (window as any).__desktopUpdateTest.installed),
  ).toEqual([]);
});

test('failed restoration shows manual recovery without offering an unsafe retry', async ({
  page,
}) => {
  await page.goto('/?fixture&desktopUpdate=mac');
  await page.getByRole('button', { name: 'Update now' }).click();
  await page.evaluate(() => {
    (window as any).__desktopUpdateTest.holdInstall = true;
  });
  const confirm = page.getByRole('button', { name: 'Update and restart' });
  await confirm.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog').getByRole('status')).toContainText(
    'Downloading and installing',
  );
  await page.evaluate(() =>
    (window as any).__desktopUpdateTest.finishInstall('manual-recovery'),
  );
  const recovery = page.getByRole('dialog', {
    name: 'Scratchtree update recovery',
  });
  await expect(recovery.getByRole('alert')).toContainText('Use the manual DMG');
  await expect(
    recovery.getByRole('button', { name: /retry|restart/i }),
  ).toHaveCount(0);
  const closeButton = recovery.getByRole('button', { name: 'Close' });
  await expect(closeButton).toBeFocused();
  await closeButton.click();
  const reopen = page.getByRole('button', { name: 'Recovery instructions' });
  await expect(reopen).toBeFocused();
  await reopen.click();
  await expect(recovery.getByRole('alert')).toContainText('Use the manual DMG');
});

test('an externally replaced app offers reopen guidance instead of a retry', async ({
  page,
}) => {
  await page.goto('/?fixture&desktopUpdate=mac');
  await page.getByRole('button', { name: 'Update now' }).click();
  await page.evaluate(() => {
    (window as any).__desktopUpdateTest.holdInstall = true;
  });
  await page.getByRole('button', { name: 'Update and restart' }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText(
    'Downloading and installing',
  );
  await page.evaluate(() =>
    (window as any).__desktopUpdateTest.finishInstall('bundle-changed'),
  );
  const dialog = page.getByRole('dialog', { name: 'Reopen Scratchtree' });
  await expect(dialog.getByRole('alert')).toHaveText(
    'Reopen Scratchtree before checking for updates.',
  );
  await expect(
    dialog.getByRole('button', { name: /retry|restart/i }),
  ).toHaveCount(0);
});
