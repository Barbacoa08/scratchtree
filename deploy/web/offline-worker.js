// This worker owns public application files only. Its installation URL pins the first
// page's release; subsequent browser-managed script checks never download a release.
const stateCache = 'scratchtree-shell-state-1';
const releasePrefix = 'scratchtree-shell-release-1-';
const stateKey = '/__scratchtree_shell_state__';
const inventoryKey = '/__scratchtree_shell_inventory__';
const releasePattern = /^[a-f0-9]{64}$/;
const immutablePath = /^\/_app\/immutable\/(?:[\w-]+\/)*[\w.-]+\.(js|css)$/;
const origin = self.location.origin;
const invalid = () => new Error('Could not verify the public app files.');
const stale = () => new Error('Reopen this tab to use the current release.');

async function readState() {
  const response = await (await caches.open(stateCache)).match(stateKey);
  return response
    ? response.json()
    : { active: null, staged: null, retained: [] };
}
async function saveState(state) {
  await (await caches.open(stateCache)).put(stateKey, Response.json(state));
}
async function hash(bytes) {
  const result = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(result, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}
function typeMatches(response, path) {
  const mime = response.headers
    .get('content-type')
    ?.split(';')[0]
    .trim()
    .toLowerCase();
  if (path.endsWith('.js'))
    return mime === 'text/javascript' || mime === 'application/javascript';
  if (path.endsWith('.css')) return mime === 'text/css';
  if (path.endsWith('.json')) return mime === 'application/json';
  return mime === 'text/html';
}
async function download(path, signal) {
  const response = await fetch(new URL(path, origin), {
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    mode: 'same-origin',
    referrerPolicy: 'no-referrer',
    signal,
  });
  if (response.status !== 200 || !typeMatches(response, path)) throw invalid();
  return response;
}
async function fetchInventory(signal) {
  const manifest = await (await download('/app-release.json', signal)).json();
  if (
    manifest?.storage !== 8 ||
    manifest.protocol !== 1 ||
    !releasePattern.test(manifest.release) ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length
  )
    throw invalid();
  const files = manifest.files;
  for (const [index, file] of files.entries()) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      !releasePattern.test(file.sha256) ||
      !(
        file.path === '/index.html' ||
        file.path === '/_app/version.json' ||
        immutablePath.test(file.path)
      ) ||
      (index && file.path <= files[index - 1].path)
    )
      throw invalid();
  }
  if (
    !files.some((file) => file.path === '/index.html') ||
    !files.some((file) => file.path === '/_app/version.json')
  )
    throw invalid();
  return manifest;
}

// The inventory is written last. A failed or interrupted download cannot select this cache.
async function stage(manifest, name, signal) {
  const cache = await caches.open(name);
  const canonical = [];
  for (const { path, sha256 } of manifest.files) {
    const response = await download(path, signal);
    const bytes = await response.clone().arrayBuffer();
    if ((await hash(bytes)) !== sha256) throw invalid();
    let canonicalHash = sha256;
    if (path === '/index.html') {
      const html = new TextDecoder().decode(bytes);
      const marker =
        '<meta name="scratchtree-release" content="' + manifest.release + '">';
      if (!html.includes(marker)) throw invalid();
      canonicalHash = await hash(
        new TextEncoder().encode(
          html.replace(marker, '<meta name="scratchtree-release" content="">'),
        ),
      );
    }
    canonical.push({ path, sha256: canonicalHash });
    await cache.put(path, response);
  }
  if (
    (await hash(new TextEncoder().encode(JSON.stringify(canonical)))) !==
    manifest.release
  )
    throw invalid();
  await cache.put(inventoryKey, Response.json(manifest));
}

async function complete(release, expected) {
  if (!release || !(await caches.has(releasePrefix + release))) return false;
  const cache = await caches.open(releasePrefix + release);
  const inventory = await cache.match(inventoryKey);
  if (!inventory) return false;
  const manifest = await inventory.json();
  if (
    expected &&
    (manifest.files.length !== expected.files.length ||
      manifest.files.some(
        (file, i) =>
          file.path !== expected.files[i].path ||
          file.sha256 !== expected.files[i].sha256,
      ))
  )
    return false;
  const paths = new Set(
    (await cache.keys()).map((request) => new URL(request.url).pathname),
  );
  return (
    manifest.release === release &&
    manifest.files.every(({ path }) => paths.has(path))
  );
}

// Repair an in-use cache only with bytes verified against the same complete release.
async function ensureRelease(manifest, state, signal) {
  const id = manifest.release;
  if (await complete(id, manifest)) return;
  const name = releasePrefix + id;
  const inUse = id === state.active || state.retained.includes(id);
  const target = inUse ? name + '-repair' : name;
  await caches.delete(target);
  try {
    await stage(manifest, target, signal);
    if (inUse) {
      const from = await caches.open(target);
      const into = await caches.open(name);
      for (const { path } of manifest.files)
        await into.put(path, await from.match(path));
      await into.put(inventoryKey, Response.json(manifest));
    }
  } catch (error) {
    if (!inUse) await caches.delete(target);
    throw error;
  } finally {
    if (inUse) await caches.delete(target);
  }
}

function adopted(state, id) {
  const retained = [state.active, ...state.retained].filter(
    (old) => old && old !== id,
  );
  return { active: id, staged: null, retained };
}

// Keep the preceding published release for rollback. Retain older immutable resources
// while another tab could still be rendering them. No notes or device data live here.
async function prune(state, clientId) {
  const clients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  if (clients.some((client) => client.id !== clientId)) return;
  state.retained = state.retained.slice(0, 1);
  await saveState(state);
  const keep = new Set(
    [state.active, state.staged, ...state.retained].map(
      (id) => releasePrefix + id,
    ),
  );
  for (const name of await caches.keys()) {
    if (name.startsWith(releasePrefix) && !keep.has(name))
      await caches.delete(name);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const state = await readState();
      if (self.registration.active || state.active) return;
      const expected = new URL(self.location.href).searchParams.get('first');
      const signal = AbortSignal.timeout(60000);
      const manifest = await fetchInventory(signal);
      if (manifest.release !== expected) throw stale();
      try {
        await ensureRelease(manifest, state, signal);
        await saveState({ ...state, active: expected });
      } catch (error) {
        await caches.delete(releasePrefix + expected);
        throw error;
      }
    })(),
  );
});
self.addEventListener('activate', (event) =>
  event.waitUntil(self.clients.claim()),
);

async function command({ action, page, candidate }, clientId) {
  const state = await readState();
  if (action === 'version') return state.active;
  if (!state.active || page !== state.active) throw stale();
  if (action === 'ready') {
    if (!(await complete(page))) throw invalid();
    return page;
  }
  if (action === 'check') {
    await prune(state, clientId);
    const signal = AbortSignal.timeout(60000);
    const manifest = await fetchInventory(signal);
    await ensureRelease(manifest, state, signal);
    const staged = manifest.release === state.active ? null : manifest.release;
    await saveState({ ...state, staged });
    if (
      state.staged &&
      state.staged !== staged &&
      state.staged !== state.active &&
      !state.retained.includes(state.staged)
    )
      await caches.delete(releasePrefix + state.staged);
    return manifest.release;
  }
  if (
    action === 'apply' &&
    candidate &&
    candidate === state.staged &&
    (await complete(candidate))
  ) {
    await saveState(adopted(state, candidate));
    return candidate;
  }
  throw invalid();
}
// Readers need only wait for an acknowledged local pointer switch. A tab can
// take the writer lease while the previous tab's network check is finishing.
let mutation;
let activation;
function change(work, switchesRelease = false) {
  if (mutation)
    return Promise.reject(
      new Error('Another app file operation is in progress.'),
    );
  mutation = work().finally(() => {
    mutation = undefined;
    if (switchesRelease) activation = undefined;
  });
  if (switchesRelease) activation = mutation;
  return mutation;
}

self.addEventListener('message', (event) => {
  const port = event.ports[0];
  if (!port || event.origin !== origin || event.source?.type !== 'window')
    return;
  const action = event.data.action;
  const run = () => command(event.data, event.source.id);
  event.waitUntil(
    (async () => {
      try {
        let value;
        if (action === 'version' || action === 'ready') {
          await activation?.catch(() => {});
          value = await run();
        } else {
          value = await change(run, action === 'apply');
        }
        port.postMessage({ value });
      } catch (error) {
        port.postMessage({
          error:
            error instanceof Error ? error.message : 'App files unavailable.',
        });
      } finally {
        port.close();
      }
    })(),
  );
});

const unavailable = () =>
  new Response('These app files are unavailable in this browser.', {
    status: 503,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
const repairPath = '/__scratchtree_repair';
function recoveryPage(
  message = 'App files are missing from this browser. Connect to repair them and reopen your notes.',
) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Repair Scratchtree</title></head>
    <body><main><h1>Repair Scratchtree</h1><p>${message}</p>
    <form action="${repairPath}" method="post"><button>Repair app files</button></form></main></body></html>`,
    {
      status: 503,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'same-origin',
        'Content-Security-Policy':
          "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      },
    },
  );
}

async function repair() {
  // If the server has moved on, changing the selected release requires the same
  // exclusive lease as the editor. An open writer must use its own save barrier.
  return self.navigator.locks.request(
    'scratchtree-local-editor',
    { ifAvailable: true },
    async (lock) => {
      if (!lock)
        return recoveryPage('Close the other editor tab, then try again.');
      const state = await readState();
      const signal = AbortSignal.timeout(60000);
      const manifest = await fetchInventory(signal);
      await ensureRelease(manifest, state, signal);
      if (manifest.release !== state.active)
        await saveState(adopted(state, manifest.release));
      return Response.redirect(origin + '/', 303);
    },
  );
}

async function serve(request) {
  const url = new URL(request.url);
  if (url.origin !== origin) return unavailable();
  if (
    request.method === 'POST' &&
    request.mode === 'navigate' &&
    url.pathname === repairPath &&
    // WebKit and Firefox can omit Origin on a navigation fetch in the worker.
    // The recovery page sets a same-origin referrer policy for its form.
    (request.headers.get('origin') === origin ||
      (!request.headers.has('origin') &&
        request.referrer.startsWith(origin + '/')))
  ) {
    return change(repair).catch(() =>
      recoveryPage(
        'Could not repair the app files. Check your connection and try again.',
      ),
    );
  }
  if (request.method !== 'GET') return unavailable();
  const navigation =
    request.mode === 'navigate' &&
    (url.pathname === '/' || url.pathname === '/index.html');
  if (
    !navigation &&
    (url.search ||
      !(
        immutablePath.test(url.pathname) ||
        url.pathname === '/_app/version.json'
      ))
  )
    return unavailable();
  const state = await readState();
  if (navigation && !(await complete(state.active))) return recoveryPage();
  if (!state.active) return unavailable();
  const key = navigation ? '/index.html' : url.pathname;
  const releases = immutablePath.test(key)
    ? [state.active, ...state.retained]
    : [state.active];
  for (const release of releases) {
    const response = await caches.match(key, {
      cacheName: releasePrefix + release,
    });
    if (response) return response;
  }
  return unavailable();
}
self.addEventListener('fetch', (event) =>
  event.respondWith(serve(event.request).catch(unavailable)),
);
