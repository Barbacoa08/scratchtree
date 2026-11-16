import { PersistentSession } from '../../src/lib/sync/session';
import {
  ScratchtreeDatabase,
  type DatabaseOptions,
} from '../../src/lib/sync/database';
import { digest } from '../../src/lib/sync/intents';
import type { SyncState } from '../../src/lib/sync/service-types';
/** Explicit manual exercise; the server and user are pinned by its private runner.
 * Only the test replaces OTP/preflight with the existing disposable demo flow. */
export async function run(config: { databaseUrl: string; demoEmail: string }) {
  if (
    config.databaseUrl !== 'https://zjf0aymuw.dexie.cloud' ||
    !config.demoEmail.endsWith('@demo.local') ||
    location.origin !== 'http://127.0.0.1:4672'
  )
    throw Error('Disposable configuration required.');
  const prefix = 'task4-managed-' + crypto.randomUUID(),
    id = crypto.randomUUID(),
    name = 'Synthetic ' + prefix;
  const files = {
    chooseRead: async () => null,
    chooseWrite: async () => null,
    writeSafety: async () => {},
  };
  let a: PersistentSession | undefined, b: PersistentSession | undefined;
  const dbs = new Map<string, ScratchtreeDatabase>();
  let epoch = '',
    libraryId = '',
    clean = false,
    signIns = 0;
  const stage = (s: string) => console.log('task4-managed: ' + s);
  const open = async (mac: string) =>
    PersistentSession.open({
      databaseUrl: config.databaseUrl,
      accountCheckUrl: 'https://example.invalid/preflight',
      files,
      localName: prefix + mac + 'plain',
      cloudName: prefix + mac + 'cloud',
      fetch: async (input, init) =>
        String(input) === 'https://example.invalid/preflight'
          ? Response.json({ exists: true })
          : fetch(input, init),
      createDatabase: (opts: DatabaseOptions) => {
        const db = new ScratchtreeDatabase(opts);
        dbs.set(opts.name, db);
        if (opts.databaseUrl) {
          const login = db.cloud.login.bind(db.cloud);
          db.cloud.login = async (hints) => {
            if (
              hints?.grant_type !== 'otp' ||
              hints.intent !== 'login' ||
              hints.email !== config.demoEmail
            )
              throw Error('Unexpected test authentication request.');
            await login({ grant_type: 'demo', email: config.demoEmail });
            signIns++;
            const k = await digest([
              'scratchtree-library',
              db.cloud.currentUser.getValue().userId,
            ]);
            libraryId = k;
            // Refuse the very first join before Session can write anything if an existing run
            // already owns the product library ID for this synthetic account.
            if (signIns === 1) {
              await db.cloud.sync({ purpose: 'pull', wait: true });
              if (await db.libraries.get(k))
                throw Error(
                  'Existing disposable session library: refusing to touch it.',
                );
            }
          };
        }
        return db;
      },
    });
  const signin = async (s: PersistentSession) => {
    s.auth.showSignIn();
    await s.auth.submitEmail(config.demoEmail);
    if (s.auth.state.phase !== 'signed-in')
      throw Error(
        'Integration sign-in failed: ' +
          s.auth.state.phase +
          ' ' +
          s.auth.state.error,
      );
  };
  async function confirmed(s: PersistentSession) {
    let state!: SyncState;
    const off = s.sync.subscribe((x) => (state = x));
    try {
      const until = Date.now() + 24000;
      while (state.state !== 'up-to-date' && Date.now() < until) {
        await s.sync.retry();
        await new Promise((r) => setTimeout(r, 250));
      }
      if (state.state !== 'up-to-date')
        throw Error('Integrated server evidence timed out: ' + state.state);
    } finally {
      off();
    }
  }
  const edit = (s: PersistentSession, text: string) =>
    s.repository.saveItemSource(id, text, { key: id, revision: 0 });
  try {
    stage('fresh local synthetic note');
    a = await open('A');
    await a.repository.loadWorkspace();
    await a.repository.captureItem({
      id,
      location: { scope: 'live', itemId: null },
      markdown: name,
      draft: { key: 'compose', revision: 0 },
    });
    const plain = dbs.get(prefix + 'Aplain')!;
    epoch = (await plain.libraries.get('local'))!.epoch;
    stage('existing demo authentication and first seed');
    await signin(a);
    stage('wait for independently confirmed first seed');
    await confirmed(a);
    stage('second Mac adopts initial cloud notes');
    b = await open('B');
    await b.repository.loadWorkspace();
    await signin(b);
    if (
      (await b.repository.loadWorkspace()).items.find((i) => i.id === id)
        ?.markdown !== name
    )
      throw Error('Second client did not receive seed.');
    stage('first Mac reloads attached cache');
    a.close();
    a = await open('A');
    await a.repository.loadWorkspace();
    if (!a.auth.state.authenticated)
      throw Error('Attached cold session lost credential.');
    stage('public logout after protected detach');
    await a.auth.signOut();
    if (a.auth.state.authenticated)
      throw Error('Sign-out barrier did not finish: ' + a.auth.state.error);
    a.close();
    a = await open('A');
    await a.repository.loadWorkspace();
    await a.repository.setItemDone(id, true);
    await edit(a, 'Local detached ' + name);
    stage('second Mac makes competing source edit');
    await edit(b, 'Remote ' + name);
    await confirmed(b);
    stage('first Mac reconciles without replacing competing source');
    await signin(a);
    const merged = (await a.repository.loadWorkspace()).items.find(
      (i) => i.id === id,
    )!;
    if (merged.markdown !== 'Remote ' + name || !merged.done)
      throw Error('Unsafe integrated rejoin.');
    await confirmed(a);
    await b.sync.retry();
    const seen = (await b.repository.loadWorkspace()).items.find(
      (i) => i.id === id,
    )!;
    if (!seen.done || seen.markdown !== merged.markdown)
      throw Error('Second client did not receive rejoin result.');
    stage('verified two clients, logout, restart, and conservative rejoin');
  } finally {
    a?.close();
    b?.close();
    if (libraryId && epoch && signIns > 0) {
      const db = new ScratchtreeDatabase({
        name: prefix + 'Acloud',
        databaseUrl: config.databaseUrl,
        automaticSync: false,
      });
      try {
        await db.open();
        if (db.cloud.currentUser.getValue().isLoggedIn) {
          await db.cloud.sync({ purpose: 'pull', wait: true });
          const pointer = await db.libraries.get(libraryId);
          const items = await db.notes.where('epoch').equals(epoch).toArray();
          if (pointer?.epoch === epoch && items.every((row) => row.id === id)) {
            await db.transaction(
              'rw',
              [db.libraries, db.notes, db.orders, db.witnesses, db.purges],
              async () => {
                await db.libraries.delete(libraryId);
                await db.notes.delete([epoch, id]);
                await db.purges.delete([epoch, id]);
                await db.orders.where('epoch').equals(epoch).delete();
                await db.witnesses.where('epoch').equals(epoch).delete();
              },
            );
            await db.cloud.sync({ purpose: 'push', wait: true });
            clean = true;
            stage('removed only the owned synthetic epoch');
          }
        }
      } finally {
        db.close();
      }
    }
    for (const db of dbs.values()) {
      db.close();
      await db.delete();
    }
  }
  if (!clean) throw Error('Disposable cleanup not established.');
  return {
    twoClients: true,
    detachedRecovery: true,
    publicLogout: true,
    persistentReopen: true,
    itemsRemoved: true,
  };
}
