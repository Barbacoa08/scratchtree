import { WorkspaceController } from '../../src/lib/workspace/controller';
import { PersistentSession } from '../../src/lib/sync/session';
import { ScratchtreeDatabase } from '../../src/lib/sync/database';
import { resolveIntent } from '../../src/lib/sync/recovery';
import { readJournalMetadata, digest } from '../../src/lib/sync/intents';
import type { AuthState } from '../../src/lib/sync/service-types';
import type { UserLogin, DXCUserInteraction } from 'dexie-cloud-addon';
const assert = (x: unknown, m: string) => {
  if (!x) throw Error(m);
};
function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
export async function run(which: string) {
  const name = 'task4-' + crypto.randomUUID(),
    localName = name + '-plain',
    cloudName = name + '-cloud';
  const id = crypto.randomUUID(),
    other = crypto.randomUUID();
  let constructs = 0,
    fetches = 0,
    logouts = 0,
    hang = false,
    holding = false,
    who = 'synthetic',
    failBarrier = false,
    pulls = 0,
    failAuto = false;
  let released!: () => void,
    started!: () => void,
    hook: Promise<void> | undefined;
  let prompt: ((p: DXCUserInteraction) => void) | undefined;
  const user: UserLogin = {
    isLoggedIn: false,
    claims: {},
    lastLogin: new Date(),
    userId: 'synthetic',
  };
  const staleRetry = which.startsWith('queued-retry-');
  let atLogout:
    { constructs: number; pulls: number; fetches: number } | undefined;
  let blockConfirmation: (() => Promise<void>) | undefined;
  let controlled: ScratchtreeDatabase | undefined;
  let onReopen:
    | ((previous: ScratchtreeDatabase, next: ScratchtreeDatabase) => void)
    | undefined;
  let ready: () => void = () => {};
  const files = {
    chooseRead: async () => null,
    chooseWrite: async () => null,
    writeSafety: async () => {},
  };
  const local = new ScratchtreeDatabase({ name: localName }),
    remote = new ScratchtreeDatabase({ name: cloudName });
  let exported = '',
    input: string | null = null;
  const factory = (opts: {
    name: string;
    databaseUrl?: string;
    automaticSync?: boolean;
  }) => {
    const db = new ScratchtreeDatabase({ name: opts.name });
    if (opts.name === cloudName) {
      constructs++;
      if (failAuto && opts.automaticSync)
        throw Error('Synthetic transport reopen failure');
      if (!opts.automaticSync) controlled = db;
      else if (controlled) onReopen?.(controlled, db);
      const api = {
        currentUser: { getValue: () => user },
        userInteraction: {
          subscribe: (fn: typeof prompt) => {
            prompt = fn;
            return { unsubscribe() {} };
          },
        },
        login: async () => {
          await new Promise<void>((resolve) => {
            ready = resolve;
            prompt!({
              type: 'otp',
              title: 'Code',
              fields: { otp: { type: 'text', label: 'OTP' } },
              alerts: [
                {
                  messageCode: 'OTP_SENT',
                  message: 'OTP sent',
                  type: 'info',
                  messageParams: {},
                },
              ],
              submitLabel: 'Submit',
              cancelLabel: 'Cancel',
              onSubmit: () => {
                user.isLoggedIn = true;
                user.userId = who;
                ready();
              },
              onCancel: () => {
                ready();
              },
            });
          });
        },
        logout: async () => {
          logouts++;
          atLogout = { constructs, pulls, fetches };
          if (holding) {
            started();
            await hook;
          }
          if (hang) await new Promise(() => {});
          user.isLoggedIn = false;
          for (const t of db.tables) await t.clear();
        },
        sync: async () => {
          pulls++;
        },
        options: { databaseUrl: 'https://example.invalid' },
      };
      if (staleRetry) {
        const idle = { subscribe: () => ({ unsubscribe() {} }) };
        Object.assign(api, {
          events: { syncComplete: idle },
          syncState: idle,
          webSocketStatus: idle,
        });
        Object.defineProperty(db, 'cloudEnabled', { value: true });
        Object.assign(user, {
          accessToken: 'synthetic-token',
          accessTokenExpiration: new Date(Date.now() + 60000),
        });
      }
      Object.defineProperty(db, 'cloud', { value: api });
    } else {
      db.device.hook('updating', (changes) => {
        if (failBarrier && JSON.stringify(changes).includes('detached'))
          throw Error('Simulated disk full');
      });
    }
    return db;
  };
  const open = () =>
    PersistentSession.open({
      localName,
      cloudName,
      files: {
        ...files,
        chooseRead: async () => input,
        chooseWrite: async (text) => {
          exported = text;
          return 'saved';
        },
      },
      databaseUrl: 'https://example.invalid',
      accountCheckUrl: 'https://example.invalid/account',
      createDatabase: factory,
      fetch: async (url) => {
        fetches++;
        if (String(url).includes('/my/')) {
          const wait = blockConfirmation;
          blockConfirmation = undefined;
          if (wait) await wait();
          return new Response(null, { status: 404 });
        }
        return Response.json({ exists: true });
      },
      timeoutMs: 300,
    });
  let s = await open(),
    state!: AuthState;
  const observe = () =>
    s.auth.subscribe((x) => {
      state = x;
    });
  observe();
  const load = () => s.repository.loadWorkspace();
  const capture = (note: string, key = id) =>
    s.repository.captureItem({
      id: key,
      markdown: note,
      draft: { key: 'compose', revision: 0 },
      location: { scope: 'live', itemId: null },
    });
  const sign = async () => {
    s.auth.showSignIn();
    await s.auth.submitEmail('dev@example.invalid');
    await s.auth.submitCode('1234');
  };
  const edit = (note: string) =>
    s.repository.saveItemSource(id, note, { key: id, revision: 0 });
  const libraryId = await digest(['scratchtree-library', who]);
  const seedRemote = async (text: string, epoch: string) => {
    await remote.libraries.put({ id: libraryId, epoch });
    await remote.notes.put({
      id,
      epoch,
      markdown: text,
      kind: 'note',
      color: null,
      done: false,
      createdAt: 1,
      updatedAt: 2,
      placement: {
        parentId: null,
        deletedAt: null,
        restoreParentId: null,
        restoreIndex: null,
      },
    });
  };
  try {
    await load();
    await capture('local');
    if (which === 'cold') {
      s.close();
      s = await open();
      await load();
      assert(
        (await edit('kept')).items[0].markdown === 'kept' &&
          constructs === 0 &&
          fetches === 0,
        'signed-out cold start must be local-only',
      );
      return 'ok';
    }
    if (which === 'join' || which === 'changed-join') {
      await seedRemote('remote', 'new');
      await sign();
      assert(
        state.join?.cloudNotes === 1 && state.join.localNotes === 1,
        'explicit join required',
      );
      assert(
        (await load()).items[0].markdown === 'local',
        'preview cannot adopt',
      );
      s.auth.dismiss();
      let retryVisible = false;
      const unsub = s.sync.subscribe((v) => {
        retryVisible = v.state === 'needs-sync';
      });
      unsub();
      assert(retryVisible, 'pending join must expose usable Retry sync');
      await s.sync.retry();
      assert(state.open, 'retry reopens preview');
      if (which === 'changed-join') {
        const row = (await remote.notes.get(['new', id]))!;
        await remote.notes.add({ ...row, id: other, markdown: 'new remote' });
        await s.auth.acceptCloud!();
        assert(
          state.open &&
            state.join?.cloudNotes === 2 &&
            state.join.localNotes === 1,
          'changed join must present current counts for a new decision',
        );
      }
      await s.auth.acceptCloud!();
      assert(
        (await load()).items.some((i) => i.markdown === 'remote'),
        'approved join adopts',
      );
      await s.repository.exportBackup();
      assert(exported.includes('local'), 'local recovery survives join');
      return 'ok';
    }
    if (which === 'empty-pointer') {
      await remote.libraries.put({ id: libraryId, epoch: 'empty-server' });
      await sign();
      assert(
        state.phase === 'signed-in' &&
          (await load()).items[0]?.markdown === 'local',
        'existing empty shared library receives exact local notes',
      );
      return 'ok';
    }
    if (which === 'transport-retry') {
      failAuto = true;
      await sign();
      assert(
        state.phase === 'syncing' && state.error,
        'failed reopen is retryable',
      );
      failAuto = false;
      await s.auth.retrySync();
      assert(
        state.phase === 'signed-in' &&
          (await load()).items[0]?.markdown === 'local',
        'retry completes existing adoption',
      );
      return 'ok';
    }
    await sign();
    assert(state.phase === 'signed-in', 'sign in: ' + state.error);
    const epoch = (await remote.libraries.get(libraryId))!.epoch;
    if (staleRetry) {
      const entered = new Promise<void>((r) => {
        started = r;
      });
      const gate = new Promise<void>((r) => {
        released = r;
      });
      blockConfirmation = async () => {
        started();
        await gate;
      };
      const earlier = s.sync.retry();
      await entered;
      hang = which === 'queued-retry-interrupted';
      const closing = s.auth.signOut();
      // Allow the asynchronous controller flush to enqueue the sign-out lifecycle turn.
      await new Promise((r) => setTimeout(r, 0));
      const stale = s.sync.retry().catch(() => {});

      released();
      await Promise.all([closing, stale, earlier]);
      assert(
        !state.authenticated && logouts === 1 && user.isLoggedIn === hang,
        'public cleanup outcome',
      );
      assert(
        atLogout &&
          constructs === atLogout.constructs &&
          pulls === atLogout.pulls &&
          fetches === atLogout.fetches,
        'queued retry must never reopen cloud or access network after sign-out ' +
          JSON.stringify({ atLogout, constructs, pulls, fetches }),
      );
      await edit('only in protected notes');
      assert(
        (await local.notes.get([epoch, id]))?.markdown ===
          'only in protected notes' &&
          (await remote.notes.get([epoch, id]))?.markdown !==
            'only in protected notes',
        'queued retry retained plain binding',
      );
      return 'ok';
    }
    if (
      which === 'switch-preservation' ||
      which === 'rejoin-switch-preservation'
    ) {
      const rejoin = which === 'rejoin-switch-preservation';
      if (rejoin) {
        await s.auth.signOut();
        await edit('different detached source');
        await seedRemote('chosen shared source', epoch);
      }
      const controller = new WorkspaceController(s.repository);
      s.attachController(controller);
      try {
        await controller.start();
        await controller.refreshFromRepository();
        await controller.selectNote(id);
        const original = s.repository.refreshFromRemote!;
        const firstResult = latch(),
          publishView = latch(),
          transportBound = latch();
        if (rejoin) {
          // The old controlled connection closes only after Session binds the automatic one.
          onReopen = (previous, next) => {
            next.on('ready', () => firstResult.wait);
            previous.on('close', transportBound.release);
          };
        }
        let observed = false;
        s.repository.refreshFromRemote = async (buffers) => {
          const result = await original(buffers);
          if (result.replaced && !observed) {
            observed = true;
            firstResult.release();
            await publishView.wait;
          }
          return result;
        };
        const switching = rejoin ? sign() : s.auth.signOut();
        await firstResult.wait;
        if (rejoin) await transportBound.wait;
        const lateSource = 'typed before replacement was displayed';
        controller.editSource(lateSource);
        publishView.release();
        await switching;
        await controller.refreshFromRepository();
        const active = rejoin ? remote : local;
        assert(
          (await active.recovery.toArray()).some(
            (r) =>
              r.kind === 'draft' &&
              r.draftKey === id &&
              r.originEpoch === epoch &&
              r.markdown === lateSource,
          ),
          'second preservation pass archives late same-epoch input',
        );
        assert(
          controller.state.activeKey === 'compose' &&
            (await active.notes.get([epoch, id]))?.markdown ===
              (rejoin ? 'chosen shared source' : 'local'),
          'same-epoch adoption discards the retired editor only after preserving input',
        );
        if (rejoin) {
          await controller.selectNote(id);
          assert(
            controller.state.source === 'chosen shared source',
            'adopted editor source',
          );
          const ordinary = latch(),
            resume = latch();
          s.repository.refreshFromRemote = async (buffers) => {
            const result = await original(buffers);
            if (buffers.some((b) => b.key === id && !b.originEpoch)) {
              ordinary.release();
              await resume.wait;
            }
            return result;
          };
          controller.editSource('current editor');
          const refreshing = controller.refreshFromRepository();
          await ordinary.wait;
          controller.editSource('latest current edit');
          resume.release();
          assert(await refreshing, 'ordinary refresh after replacement');
          assert(
            controller.state.source === 'latest current edit' &&
              !(await active.recovery.toArray()).some(
                (r) =>
                  r.kind === 'draft' && r.markdown === 'latest current edit',
              ),
            'published generation keeps ordinary typing in the editor',
          );
        }
      } finally {
        controller.dispose();
      }
      return 'ok';
    }
    if (which === 'ordinary-refresh' || which === 'ordinary-refresh-capacity') {
      const near = which === 'ordinary-refresh-capacity';
      const prefix = near ? 'N'.repeat(512 * 1024) : 'dirty';
      if (near) {
        await edit(prefix + '0');
        await remote.recovery.bulkAdd(
          Array.from({ length: 9 }, () => ({
            kind: 'source' as const,
            reason: 'rejected' as const,
            id: crypto.randomUUID(),
            itemId: crypto.randomUUID(),
            markdown: 'f'.repeat(992 * 1024),
            originEpoch: epoch,
            recordedAt: 1,
          })),
        );
      }
      const controller = new WorkspaceController(s.repository);
      s.attachController(controller);
      try {
        await controller.start();
        await controller.refreshFromRepository();
        await controller.selectNote(id);
        const original = s.repository.refreshFromRemote!,
          passes: string[] = [];
        const entered = new Promise<void>((r) => {
          started = r;
        });
        const gate = new Promise<void>((r) => {
          released = r;
        });
        s.repository.refreshFromRemote = async (buffers) => {
          const result = await original(buffers);
          if (buffers.some((b) => b.key === id)) {
            passes.push(buffers[0].originEpoch ?? 'initial');
            if (passes.length === 1) {
              started();
              await gate;
            }
          }
          return result;
        };
        controller.editSource(prefix + '1');
        const ordinary = controller.refreshFromRepository();
        await entered;
        controller.editSource(prefix + '2');
        released();
        assert(
          await ordinary,
          'ordinary refresh must fit the complete envelope without an extra rejected draft',
        );
        assert(
          passes.includes(epoch) &&
            controller.state.activeKey === id &&
            controller.state.source === prefix + '2',
          'preservation loop keeps current editor and latest input',
        );
        assert(
          !(await remote.recovery.toArray()).some(
            (r) =>
              r.kind === 'draft' &&
              r.reason === 'rejected' &&
              r.draftKey === id,
          ),
          'ordinary current input cannot produce rejected recovery',
        );
        assert(
          (await controller.flush()) &&
            (await remote.notes.get([epoch, id]))?.markdown === prefix + '2',
          'latest revision saves normally',
        );
      } finally {
        controller.dispose();
      }
      return 'ok';
    }
    if (which === 'expired-cold') {
      s.close();
      user.isLoggedIn = false;
      const before = pulls;
      s = await open();
      observe();
      const ws = await load();
      assert(
        !state.authenticated &&
          ws.items[0].markdown === 'local' &&
          pulls === before,
        'expired session opens protected current cache without reusing stale credentials',
      );
      return 'ok';
    }
    if (which === 'attached-cold') {
      const before = pulls;
      s.close();
      s = await open();
      observe();
      assert(
        state.authenticated &&
          (await load()).items[0].markdown === 'local' &&
          pulls === before,
        'cached attached reopen does not await sync or OTP',
      );
      return 'ok';
    }
    if (which === 'purge-times') {
      const key = crypto.randomUUID();
      await capture('purge', key);
      await s.repository.deleteItem(key);
      await s.repository.purgeItem({
        id: key,
        location: { scope: 'trash', itemId: null },
        expectedSubtreeIds: [key],
      });
      const before = await remote.purges.get([epoch, key]);
      await s.auth.signOut();
      const after = await local.purges.get([epoch, key]);
      assert(
        before && after?.purgedAt === before.purgedAt,
        'detach preserves original tombstone timestamp',
      );
      return 'ok';
    }
    if (which === 'head' || which === 'sequence') {
      const capture = (await remote.pending.toArray())[0];
      await edit('second');
      const saved = (await remote.pending.toArray()).find(
        (p) => p.id !== capture.id,
      )!;
      await resolveIntent(remote, saved, 'matching');
      if (which === 'sequence')
        await resolveIntent(remote, capture, 'matching');
      await s.auth.signOut();
      s.close();
      s = await open();
      observe();
      await load();
      const meta = await readJournalMetadata(local);
      assert(
        meta.sequence === saved.sequence,
        'empty-pending high-water persists',
      );
      if (which === 'head')
        assert(
          meta.sources[0].intentId === saved.id,
          'resolved latest source head retained for older unresolved command',
        );
      await seedRemote('second', epoch);
      await sign();
      const next = await readJournalMetadata(remote);
      assert(next.sequence === saved.sequence, 'rejoin ordering retained');
      if (which === 'head')
        assert(
          (await remote.pending.get(capture.id))?.sequence ===
            capture.sequence &&
            !(await remote.witnesses.get(capture.id)) &&
            next.sources[0].intentId === saved.id,
          'old unknown receipt retained without replay or a fabricated witness',
        );
      await s.repository.setItemDone(id, true);
      assert(
        (await readJournalMetadata(remote)).sequence > saved.sequence,
        'next monotonic sequence',
      );
      return 'ok';
    }
    if (which === 'barrier') {
      failBarrier = true;
      await s.auth.signOut();
      assert(state.authenticated && logouts === 0, 'barrier must veto logout');
      failBarrier = false;
      assert(
        (await edit('still on cloud')).items[0].markdown === 'still on cloud',
        'old cloud binding survives',
      );
      return 'ok';
    }
    if (which === 'detach') {
      holding = true;
      hook = new Promise((r) => {
        released = r;
      });
      const entered = new Promise<void>((r) => {
        started = r;
      });
      const out = s.auth.signOut();
      await entered;
      await edit('during logout');
      assert(
        (await local.notes.get([epoch, id]))?.markdown === 'during logout',
        'cloud network cannot hold local write',
      );
      released();
      await out;
      s.close();
      const count = constructs;
      s = await open();
      assert(
        (await load()).items[0].markdown === 'during logout' &&
          constructs === count,
        'cold detach persisted',
      );
      return 'ok';
    }
    hang = which === 'restart-cleanup';
    await s.auth.signOut();
    assert(!state.authenticated && logouts === 1, 'true logout');
    s.close();
    const count = constructs;
    s = await open();
    observe();
    await load();
    assert(constructs === count, 'detached open never constructs cloud');
    if (which === 'restart-cleanup') {
      hang = false;
      await sign();
      assert(
        logouts === 2 && state.authenticated,
        'fresh sign-in cleaned previous credentials',
      );
      return 'ok';
    }
    if (which === 'stale-purge') {
      const pointer = { id: libraryId, epoch };
      const original = await local.notes.get([epoch, id]);
      await s.repository.deleteItem(id);
      await s.repository.purgeItem({
        id,
        location: { scope: 'trash', itemId: null },
        expectedSubtreeIds: [id],
      });
      // Cloud independently promoted the target and added a child. The old purge must never remove either.
      await remote.libraries.put(pointer);
      await remote.notes.put({ ...original!, kind: 'tree' });
      await remote.notes.put({
        ...original!,
        id: other,
        placement: { ...original!.placement, parentId: id },
      });
      await sign();
      const w = await load();
      assert(
        w.items.length === 2 && !w.items[0].deletedAt,
        'stale subtree retained',
      );
      return 'ok';
    }
    if (which === 'creation') {
      const parent = crypto.randomUUID(),
        child = crypto.randomUUID();
      await capture('parent', parent);
      await s.repository.captureItem({
        id: child,
        markdown: 'child',
        location: { scope: 'live', itemId: parent },
        draft: { key: 'compose:' + parent, revision: 0 },
      });
      const original = await local.pending.toArray(),
        old = await local.notes.get([epoch, child]);
      await seedRemote('other change', epoch);
      await sign();
      const ws = await load();
      assert(
        ws.items.some(
          (i) =>
            i.id === child &&
            i.parentId === parent &&
            i.createdAt === old?.createdAt,
        ),
        'dependent creation at original owner and time',
      );
      for (const p of original.filter(
        (p) => p.command.kind === 'captureItem' && p.command.request.id !== id,
      )) {
        const actual = await remote.pending.get(p.id);
        assert(
          actual?.sequence === p.sequence &&
            actual?.recordedAt === p.recordedAt,
          'original capture journal',
        );
      }
      return 'ok';
    }
    if (which === 'late-buffer') {
      await seedRemote('winner', epoch);
      await edit('losing text');
      await s.repository.checkpointDraft(id, 'losing draft', 4);
      await sign();
      const r = await s.repository.refreshFromRemote!([
        { key: id, markdown: 'newer trailing buffer', revision: 5 },
      ]);
      assert(
        r.replaced &&
          !r.workspace.drafts.some((d) => d.key === id) &&
          r.workspace.items[0].markdown === 'winner',
        'same-epoch adoption resets view, losing overlay not active',
      );
      await s.repository.exportBackup();
      assert(
        exported.includes('newer trailing buffer') &&
          exported.includes('losing draft'),
        'both alternatives retained',
      );
      return 'ok';
    }
    if (which === 'offline-restore') {
      const old = (await local.notes.get([epoch, id]))!,
        orders = await local.orders.toArray();
      await s.repository.exportBackup();
      const b = JSON.parse(exported);
      b.library.items[0].markdown = 'restored';
      input = JSON.stringify(b);
      const preview = await s.repository.previewRestore();
      await s.repository.confirmRestore(preview!.token, true);
      const intent = (await local.pending.toArray()).find(
        (p) => p.command.kind === 'replaceLibrary',
      )!;
      await remote.libraries.put({ id: libraryId, epoch });
      await remote.notes.put(old);
      await remote.orders.bulkPut(orders);
      await sign();
      assert(
        state.phase === 'signed-in' &&
          (await load()).items[0].markdown === 'restored',
        'same-account offline restore uses original replacement',
      );
      assert(
        (await remote.libraries.get(libraryId))?.epoch === intent.epoch &&
          (await remote.witnesses.get(intent.id))?.recordedAt ===
            intent.recordedAt,
        'exact restore epoch and receipt',
      );
      return 'ok';
    }
    await edit('detached');
    await s.repository.setItemDone(id, true);
    await seedRemote(
      'remote change',
      which === 'epoch' ? 'replacement' : epoch,
    );
    if (which === 'account') who = 'different';
    await sign();
    if (which === 'account') {
      assert(
        (await load()).items[0].markdown === 'detached' && state.error,
        'different account retained local branch',
      );
      return 'ok';
    }
    assert(state.phase === 'signed-in', 'rejoin failed: ' + state.error);
    const item = (await load()).items[0];
    assert(
      item.markdown === 'remote change' && item.done === (which !== 'epoch'),
      'remote text and safe completion / epoch recovery',
    );
    await s.repository.exportBackup();
    assert(exported.includes('detached'), 'source backup recovery');
    if (which === 'archives') {
      await s.auth.signOut();
      await s.sync.exportRecovery();
      assert(
        exported.includes('saveItemSource') &&
          exported.includes('detached-conflict'),
        'raw export retains exact archived command across a second logout',
      );
    }
    return 'ok';
  } finally {
    s.close();
    local.close();
    remote.close();
    await new ScratchtreeDatabase({ name: localName }).delete();
    await new ScratchtreeDatabase({ name: cloudName }).delete();
  }
}
