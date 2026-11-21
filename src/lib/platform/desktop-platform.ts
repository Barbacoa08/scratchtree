import { isTauri } from '@tauri-apps/api/core';

export function isLinuxDesktop(): boolean {
  return isTauri() && navigator.platform.startsWith('Linux');
}
