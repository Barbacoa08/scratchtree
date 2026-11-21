import { hide } from '@tauri-apps/api/app';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { CloseAdapter } from './lifecycle';

export function createNativeCloseAdapter(linux: boolean): CloseAdapter {
  return {
    onCloseRequested: (handler) => getCurrentWindow().onCloseRequested(handler),
    // App hide is a macOS-only command. Destroy bypasses the close request
    // listener after the save barrier has acknowledged the user's request.
    finishClose: linux ? () => getCurrentWindow().destroy() : hide,
  };
}
