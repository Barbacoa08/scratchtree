import type { Repository } from '../../src/lib/platform/workspace';
import { MemoryRepository } from './memory';

/** Explicit DEV fixture bridge; the Node test owns durable synthetic state across reload. */
export interface ClientErrorHost {
  __clientErrorLoad: Repository['loadWorkspace'];
  __clientErrorCheckpoint: Repository['checkpointDraft'];
  __clientErrorCapture: Repository['captureItem'];
  __clientErrorSave: Repository['saveItemSource'];
}
const host = () => window as unknown as ClientErrorHost;
export class ClientErrorRepository extends MemoryRepository {
  override loadWorkspace() {
    return host().__clientErrorLoad();
  }
  override checkpointDraft(...args: Parameters<Repository['checkpointDraft']>) {
    return host().__clientErrorCheckpoint(...args);
  }
  override saveItemSource(...args: Parameters<Repository['saveItemSource']>) {
    return host().__clientErrorSave(...args);
  }
  override async captureItem(...args: Parameters<Repository['captureItem']>) {
    const saved = await host().__clientErrorCapture(...args);
    if (new URL(location.href).searchParams.has('renderFault')) {
      Date.prototype.toLocaleString = () => {
        throw new TypeError('PRIVATE_SYNTHETIC_NOTE_CONTENT');
      };
    }
    return saved;
  }
}
