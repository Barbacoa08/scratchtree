const releaseId = () => {
  const id = document.querySelector<HTMLMetaElement>(
    'meta[name="scratchtree-release"]',
  )?.content;
  if (!id || !/^[a-f0-9]{64}$/.test(id))
    throw new Error('Could not identify this app release.');
  return id;
};

function send(
  worker: ServiceWorker,
  action: string,
  candidate?: string,
): Promise<string> {
  const page = releaseId();
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(
      () => finish(new Error('The offline worker did not respond.')),
      action === 'check' ? 65000 : 4000,
    );
    function finish(error?: Error, result?: string) {
      clearTimeout(timer);
      worker.removeEventListener('statechange', retired);
      channel.port1.close();
      if (error) reject(error);
      else resolve(result!);
    }
    function retired() {
      if (worker.state === 'redundant')
        finish(new Error('The offline worker has stopped.'));
    }
    channel.port1.onmessage = ({ data }) => {
      if (typeof data?.value === 'string') finish(undefined, data.value);
      else
        finish(
          new Error(data?.error ?? 'The offline app files are unavailable.'),
        );
    };
    channel.port1.onmessageerror = () =>
      finish(new Error('Could not read the offline worker response.'));
    worker.addEventListener('statechange', retired);
    try {
      worker.postMessage({ action, page, candidate }, [channel.port2]);
      retired();
    } catch (error) {
      finish(
        error instanceof Error
          ? error
          : new Error('Could not contact the offline worker.'),
      );
    }
  });
}

async function activated(
  registration: ServiceWorkerRegistration,
): Promise<ServiceWorker> {
  const worker =
    registration.active ?? registration.installing ?? registration.waiting;
  if (!worker) throw new Error('Offline preparation did not finish.');
  if (worker.state !== 'activated') {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.removeEventListener('statechange', changed);
        reject(new Error('Offline preparation did not finish.'));
      }, 65000);
      const changed = () => {
        if (worker.state === 'activated' || worker.state === 'redundant') {
          clearTimeout(timer);
          worker.removeEventListener('statechange', changed);
          if (worker.state === 'activated') resolve();
          else reject(new Error('Offline preparation did not finish.'));
        }
      };
      worker.addEventListener('statechange', changed);
      changed();
    });
  }
  return worker;
}

export async function verifyWebPageRelease(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  if (!registration?.active) return;
  const current = await send(await activated(registration), 'version');
  if (current !== releaseId()) {
    window.location.reload();
    throw new Error('Reopening the current app release.');
  }
}

export async function prepareOfflineShell(): Promise<void> {
  if (!('serviceWorker' in navigator) || !('caches' in window))
    throw new Error('Offline reopening is unavailable in this browser.');
  const container = navigator.serviceWorker;
  const existing = await container.getRegistration('/');
  const registration =
    existing ??
    (await container.register('/offline-worker.js?first=' + releaseId(), {
      scope: '/',
      updateViaCache: 'none',
    }));
  const worker = await activated(registration);
  await send(worker, 'ready');
  if (container.controller !== worker)
    throw new Error('Reopen this tab to finish offline preparation.');
  // Browser approval affects eviction protection, independently of offline readiness.
  if (!existing) void navigator.storage?.persist?.().catch(() => false);
}

function controller() {
  const worker = navigator.serviceWorker?.controller;
  if (!worker) throw new Error('Prepare the offline app files first.');
  return worker;
}

let candidate: string | undefined;
export async function checkForWebUpdate(): Promise<'current' | 'available'> {
  candidate = undefined;
  const checked = await send(controller(), 'check');
  if (checked === releaseId()) return 'current';
  candidate = checked;
  return 'available';
}

// The caller holds the writer lease and blocks further changes from flush through reload.
export async function applyWebUpdate(
  flush: () => Promise<boolean>,
): Promise<boolean> {
  const selected = candidate;
  if (!selected || !(await flush())) return false;
  const worker = controller();
  try {
    if ((await send(worker, 'apply', selected)) !== selected)
      throw new Error('The verified update is no longer available.');
  } catch (error) {
    // The commit may have succeeded before its reply was lost. Only a read
    // from that same worker after the local switch can unlock this old page.
    const current =
      navigator.serviceWorker.controller === worker
        ? await send(worker, 'version').catch(() => undefined)
        : undefined;
    if (current === releaseId()) throw error;
  }
  window.location.reload();
  return true;
}
