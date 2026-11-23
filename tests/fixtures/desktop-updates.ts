import type { DesktopUpdatePort } from '../../src/lib/platform/desktop-updates';
import type { MemoryRepository } from './memory';

export function fixtureDesktopUpdates(
  platform: string | null,
  repository: MemoryRepository,
): DesktopUpdatePort {
  const evidence = {
    installed: [] as string[],
    copied: [] as string[],
    draftsAtInstall: [] as string[],
  };
  let settleInstall: ((error?: unknown) => void) | undefined;
  const test = Object.assign(evidence, {
    holdInstall: false,
    failCopy: false,
    finishInstall(outcome: boolean | 'manual-recovery' | 'bundle-changed') {
      settleInstall?.(
        outcome === 'manual-recovery'
          ? {
              code: 'update_manual_recovery',
              message:
                'The prior app is in a recovery folder. Use the manual DMG to reinstall if needed.',
            }
          : outcome === 'bundle-changed'
            ? { code: 'update_bundle_changed' }
            : outcome
              ? new Error('Synthetic installer failure')
              : undefined,
      );
    },
  });
  Object.assign(window, { __desktopUpdateTest: test });
  return {
    async check() {
      if (platform !== 'mac' && platform !== 'arch') return null;
      return { version: '0.2.9', platform, notes: 'Synthetic release notes.' };
    },
    async install(version) {
      evidence.installed.push(version);
      evidence.draftsAtInstall = repository.snapshot.drafts.map(
        (draft) => draft.markdown,
      );
      if (test.holdInstall)
        await new Promise<void>((resolve, reject) => {
          settleInstall = (error) => {
            settleInstall = undefined;
            if (error) reject(error);
            else resolve();
          };
        });
    },
    async copyCommand(command) {
      if (test.failCopy) throw new Error('Synthetic clipboard failure');
      evidence.copied.push(command);
    },
  };
}
