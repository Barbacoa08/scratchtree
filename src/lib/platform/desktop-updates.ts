import { invoke } from '@tauri-apps/api/core';
import { copyMarkdown } from './actions';

export type DesktopUpdateOffer = {
  platform: 'mac' | 'arch';
  version: string;
  notes: string | null;
};

export type DesktopUpdatePort = {
  check(): Promise<DesktopUpdateOffer | null>;
  install(version: string): Promise<void>;
  copyCommand(command: string): Promise<void>;
};

export const desktopUpdatePort: DesktopUpdatePort = {
  check: () => invoke('desktop_update_check'),
  install: (version) => invoke('desktop_update_install', { version }),
  copyCommand: copyMarkdown,
};
