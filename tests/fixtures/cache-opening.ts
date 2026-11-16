import { PersistentSession } from '../../src/lib/sync/session';
import {
  ScratchtreeDatabase,
  type DatabaseOptions,
} from '../../src/lib/sync/database';
import { setActivation } from '../../src/lib/sync/detached';
import { digest } from '../../src/lib/sync/intents';

export async function exercise(
  mode: 'retry' | 'dismiss' | 'startup' | 'abort' | 'abort-notice',
) {
  const prefix = 'sdk-ready-' + crypto.randomUUID();
  const localName = prefix + '-local',
    cloudName = prefix + '-cloud';
  const databaseUrl = 'https://sdk-ready.invalid';
  const account = await digest(['scratchtree-library', 'synthetic']);
  const cold =
    mode === 'startup' || mode === 'abort' || mode === 'abort-notice';
  if (cold) {
    const seed = new ScratchtreeDatabase({ name: localName });
    await setActivation(seed, {
      version: 1,
      mode: 'attached',
      account,
      baseline: null,
      cleanupNeeded: false,
    });
    seed.close();
  }
  const instances: ScratchtreeDatabase[] = [];
  const tail = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<void>();
  const notice = Promise.withResolvers<void>();
  let notified = false;
  const notices: boolean[] = [];
  // Hold a real dependency of the pinned cloud addon's public ready hook.
  // All active database objects must pass through this same held platform call.
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      getRegistrations: async () => {
        entered.resolve();
        await tail.promise;
        return [];
      },
    },
  });
  const abort = new AbortController();
  const timeoutMs = 250;
  let session: PersistentSession | undefined;
  try {
    const opts = {
      files: {
        chooseRead: async () => null,
        chooseWrite: async () => null,
        writeSafety: async () => {},
      },
      localName,
      cloudName,
      databaseUrl,
      accountCheckUrl: databaseUrl + '/preflight',
      fetch: async () => Response.json({ exists: true }),
      timeoutMs,
      signal: abort.signal,
      beforeOpenCloudCache: async () => {
        notified = true;
        notice.resolve();
        if (mode === 'abort-notice') await tail.promise;
      },
      createDatabase: (options: DatabaseOptions) => {
        if (options.automaticSync)
          throw Error('Automatic transport is unavailable in this fixture.');
        const db = new ScratchtreeDatabase(options);
        if (options.databaseUrl) {
          notices.push(notified);
          instances.push(db);
          db.on('ready', async () => {
            // Use a synthetic authenticated account only after actual addon initialization.
            if (cold) {
              const anonymous = db.cloud.currentUser.getValue();
              db.cloud.currentUser.getValue = () => ({
                ...anonymous,
                userId: 'synthetic',
                isLoggedIn: true,
              });
            }
            complete.resolve();
          });
        }
        return db;
      },
    };
    if (cold) {
      const opening = PersistentSession.open(opts).then(
        (s) => {
          session = s;
          return 'opened';
        },
        () => 'rejected',
      );
      if (mode === 'abort-notice') {
        await Promise.race([notice.promise, entered.promise]);
        abort.abort();
        const outcome = await Promise.race([
          opening,
          new Promise((resolve) =>
            setTimeout(() => resolve('still waiting'), timeoutMs / 2),
          ),
        ]);
        tail.resolve();
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { outcome, notified, count: instances.length };
      }
      await entered.promise;
      if (mode === 'abort') {
        abort.abort();
        const outcome = await Promise.race([
          opening,
          new Promise((resolve) =>
            setTimeout(() => resolve('still waiting'), timeoutMs / 2),
          ),
        ]);
        tail.resolve();
        return {
          outcome,
          open: instances[0].isOpen(),
          count: instances.length,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, timeoutMs * 2));
      const pending = await Promise.race([opening, Promise.resolve('pending')]);
      tail.resolve();
      const outcome = await opening;
      return {
        pending,
        outcome,
        authenticated: session?.auth.state.authenticated ?? false,
        notices,
        count: instances.length,
      };
    }
    session = await PersistentSession.open(opts);
    const auth = session.auth;
    auth.showSignIn();
    const send = auth.submitEmail('reader@example.invalid');
    await entered.promise;
    await send;
    const phaseAtDeadline = auth.state.phase;
    const openAtDeadline = instances[0].isOpen();
    if (mode === 'dismiss') {
      auth.dismiss();
      tail.resolve();
      await complete.promise;
      const until = performance.now() + timeoutMs * 5;
      while (instances.some((db) => db.isOpen()) && performance.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        phaseAtDeadline,
        openAtDeadline,
        phase: auth.state.phase,
        open: instances.some((db) => db.isOpen()),
        count: instances.length,
      };
    }
    const second = auth.submitEmail('reader@example.invalid');
    tail.resolve();
    await second;
    return {
      phaseAtDeadline,
      openAtDeadline,
      phase: auth.state.phase,
      notices,
      count: instances.length,
    };
  } finally {
    tail.resolve();
    session?.close();
    for (const db of instances) db.close();
    // Each Playwright test owns its disposable browser context and its IndexedDB.
    Reflect.deleteProperty(navigator, 'serviceWorker');
  }
}
