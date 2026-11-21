import type { BackupFiles } from '../platform/backup-files';
import type { RemoteBuffer, Repository } from '../platform/workspace';
import type { WorkspaceController } from '../workspace/controller';
import { CloudAuthController, type AuthHost } from './auth';
import { createAccountPreflight } from './account-preflight';
import { ScratchtreeDatabase, type DatabaseOptions } from './database';
import { DexieRepository } from './repository';
import { SyncEngine } from './engine';
import type { SyncPort, SyncState, AuthState } from './service-types';
import {
  detach,
  readActivation,
  setActivation,
  type Activation,
} from './detached';
import { digest } from './intents';
import { reconcileTransfer } from './rejoin';
interface Options {
  files: BackupFiles;
  databaseUrl: string;
  accountCheckUrl: string;
  localName?: string;
  cloudName?: string;
  useLocalRecovery?: boolean;
  fetch?: typeof fetch;
  createDatabase?: (options: DatabaseOptions) => ScratchtreeDatabase;
  timeoutMs?: number;
  signal?: AbortSignal;
  beforeOpenCloudCache?: () => Promise<void>;
}
type Controller = Pick<
  WorkspaceController,
  'flush' | 'refreshFromRepository' | 'state'
>;
function queue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>) => {
    const run = tail.then(work);
    tail = run.catch(() => {});
    return run;
  };
}
const cacheWaitMessage =
  'The local sync storage is still opening. Finish any permission prompt, then retry.';
const inactive = () =>
  new Error('The active notes changed. Retry from the current view.');
/** One local activation record decides which durable database is allowed to serve notes. */
export class PersistentSession {
  readonly repository: Repository;
  readonly auth: CloudAuthController;
  readonly sync: SyncPort;
  private readonly lifecycle = queue();
  private readonly writes = queue();
  private controller?: Controller;
  private repo!: DexieRepository;
  private engine!: SyncEngine;
  private candidate?: ScratchtreeDatabase;
  private opening?: {
    db: ScratchtreeDatabase;
    ready: Promise<unknown>;
    automaticSync: boolean;
    abandoned: boolean;
  };
  private closed = false;
  private priorEpoch: string | null = null;
  // A controller can preserve several revisions before it publishes the replacement.
  private preservingSwitch?: { epoch: string; generation: number };
  private join: string | null = null;
  private automatic = false;
  private expiredRecovery = false;
  private receiptState: SyncState = {
    state: 'local-only',
    lastConfirmed: null,
    detail: null,
    recoveries: 0,
  };
  private stopAuth: () => void;
  private syncState: SyncState = {
    state: 'local-only',
    lastConfirmed: null,
    detail: null,
    recoveries: 0,
  };
  private listeners = new Set<(s: SyncState) => void>();
  private constructor(
    private options: Options,
    private plain: ScratchtreeDatabase,
    private activation: Activation,
  ) {
    const host: AuthHost = {
      configured: !!options.databaseUrl,
      accountExists: createAccountPreflight(
        options.accountCheckUrl,
        options.fetch,
      ),
      prepareSignIn: () => this.lifecycle(() => this.prepare()),
      cancelSignIn: () =>
        this.lifecycle(async () => {
          if (this.candidate) await this.cleanup();
          else this.abandonOpening();
        }),
      finishSignIn: () => this.finish(false),
      mergeNotes: () => this.finish(true),
      signOut: () => this.signOut(),
    };
    this.auth = new CloudAuthController(host, activation.mode === 'attached');
    this.stopAuth = this.auth.subscribe(() => this.presentStatus());
    this.sync = {
      subscribe: (fn) => {
        this.listeners.add(fn);
        fn(this.syncState);
        return () => {
          this.listeners.delete(fn);
        };
      },
      retry: async () => {
        if (this.expiredRecovery) return;
        if (this.auth.state.phase === 'syncing') {
          this.auth.showSignIn();
          return;
        }
        const { mode, account } = this.activation;
        const binding = this.repo;
        const engine =
          mode === 'attached' && account
            ? await this.lifecycle(async () => {
                // Sign-out may have finished while this request waited for confirmation.
                if (
                  this.closed ||
                  this.activation.mode !== 'attached' ||
                  this.activation.account !== account ||
                  this.repo !== binding
                )
                  return null;
                if (!this.automatic) await this.enableTransport(account);
                await this.bound(
                  this.repo.db.cloud.sync({ purpose: 'pull', wait: true }),
                  'Sync timed out.',
                );
                return this.engine;
              })
            : this.engine;
        await engine?.retry();
      },
      exportRecovery: () => this.engine.exportRecovery(),
      exportOverflow: () => this.engine.exportOverflow(),
      inspectOverflow: () => this.engine.inspectOverflow(),
      purgeOverflow: (r) =>
        this.expiredRecovery
          ? Promise.reject(
              Error(
                'This expired cache is read-only. Export the full raw library.',
              ),
            )
          : this.engine.purgeOverflow(r),
    };
    const call = <K extends keyof DexieRepository>(
      method: K,
      ...args: DexieRepository[K] extends (...a: infer A) => unknown ? A : never
    ) => {
      if (this.expiredRecovery)
        return Promise.reject(
          Error(
            'This saved account cache is available for recovery export only.',
          ),
        );
      const repo = this.repo,
        epoch = repo.viewEpoch,
        captured = structuredClone(args);
      type Result = DexieRepository[K] extends (
        ...a: never[]
      ) => Promise<infer R>
        ? R
        : never;
      return this.writes(async () => {
        if (
          this.closed ||
          repo !== this.repo ||
          (epoch !== null && epoch !== repo.viewEpoch) ||
          (this.controller &&
            (this.priorEpoch !== null ||
              this.preservingSwitch?.generation ===
                this.controller.state.cacheGeneration) &&
            method !== 'loadWorkspace')
        )
          throw inactive();
        return await (
          repo[method] as (...args: unknown[]) => Promise<Result>
        ).apply(repo, captured);
      });
    };
    const session = this;
    this.repository = {
      get viewEpoch() {
        return session.repo.viewEpoch;
      },
      loadWorkspace: () => call('loadWorkspace'),
      readBoundWorkspace: (epoch) => call('readBoundWorkspace', epoch),
      checkpointDraft: (...a) => call('checkpointDraft', ...a),
      discardDraft: (...a) => call('discardDraft', ...a),
      saveItemSource: (...a) => call('saveItemSource', ...a),
      captureItem: (...a) => call('captureItem', ...a),
      createChildTree: (...a) => call('createChildTree', ...a),
      promoteItem: (...a) => call('promoteItem', ...a),
      deleteItem: (...a) => call('deleteItem', ...a),
      purgeItem: (...a) => call('purgeItem', ...a),
      transitionLocation: (...a) => call('transitionLocation', ...a),
      moveItems: (...a) => call('moveItems', ...a),
      restoreItem: (...a) => call('restoreItem', ...a),
      undoDelete: (...a) => call('undoDelete', ...a),
      setItemDone: (...a) => call('setItemDone', ...a),
      setItemsDone: (...a) => call('setItemsDone', ...a),
      setItemColor: (...a) => call('setItemColor', ...a),
      reorderItem: (...a) => call('reorderItem', ...a),
      exportBackup: () => call('exportBackup'),
      previewRestore: () => call('previewRestore'),
      confirmRestore: (...a) => call('confirmRestore', ...a),
      refreshFromRemote: (buffers) => this.refresh(buffers),
    };
  }
  static async open(options: Options) {
    const make =
      options.createDatabase ?? ((opts) => new ScratchtreeDatabase(opts));
    let plain = make({ name: options.localName ?? 'scratchtree-local-v8' });
    let s: PersistentSession | undefined;
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(options.signal!.reason);
    });
    const initialize = async () => {
      options.signal?.throwIfAborted();
      await plain.open();
      options.signal?.throwIfAborted();
      // The activation and cloud cache form one profile. Recovery must never
      // log out, clear, or adopt the original profile's unconfirmed cache.
      const recoveryKey = 'startup-local-recovery';
      if (options.useLocalRecovery)
        await plain.device.put({ key: recoveryKey, value: true });
      options.signal?.throwIfAborted();
      if ((await plain.device.get(recoveryKey))?.value === true) {
        options.signal?.throwIfAborted();
        const localName = plain.name + '-recovery';
        plain.close();
        options = {
          ...options,
          localName,
          cloudName:
            (options.cloudName ?? 'scratchtree-cloud-v8') + '-recovery',
        };
        plain = make({ name: localName });
        await plain.open();
      }
      const a = await readActivation(plain);
      options.signal?.throwIfAborted();
      s = new PersistentSession(options, plain, a);
      if (a.mode === 'attached') {
        await options.beforeOpenCloudCache?.();
        options.signal?.throwIfAborted();
        const db = await s.cloud('startup');
        const cached = new DexieRepository(db, options.files, a.account!);
        const user = db.cloud.currentUser.getValue();
        if (user.isLoggedIn) await s.requireUser(db, a.account);
        const expired =
          user.accessTokenExpiration !== undefined &&
          !(+user.accessTokenExpiration > Date.now());
        if (!user.isLoggedIn || expired) {
          // Expired credentials never unlock a different account. Preserve the previously
          // bound cache before asking for fresh OTP (including all unconfirmed edits).
          if (!(await db.libraries.get(a.account!)))
            throw Error('The saved shared library is unavailable.');
          try {
            await cached.loadWorkspace();
          } catch (error) {
            const assessment = await cached.assessView();
            if (
              assessment.kind !== 'shared-capacity' &&
              assessment.kind !== 'device-capacity' &&
              assessment.kind !== 'invalid-shared'
            )
              throw error;
            // No SDK sync, login, logout, or cache mutation in this recovery session.
            s.check();
            s.expiredRecovery = true;
            s.candidate = undefined;
            s.bind(cached);
            s.publish({
              state: 'needs-sync',
              lastConfirmed: null,
              recoveries: await db.recovery.count(),
              readOnlyRecovery: true,
              detail:
                assessment.kind === 'invalid-shared'
                  ? 'Sign-in expired and the shared notes contain invalid data. Export the full raw library for repair before signing in again.'
                  : 'Sign-in expired and these notes exceed local capacity. Export the full raw library for repair before signing in again.',
              overflow: {
                items: assessment.shared.notes.length,
                correctable: false,
              },
            });
            return s;
          }
          // A still-logged-in account can use the SDK's normal refresh path
          // once we know its cache fits. A signed-out SDK needs a detached copy.
          if (!user.isLoggedIn) {
            const t = await cached.readTransfer();
            const detached = await detach(plain, t, a.account!);
            db.close();
            s.stopAuth();
            s.check();
            s = new PersistentSession(options, plain, detached);
            s.bind(new DexieRepository(plain, options.files));
            return s;
          }
        }
        s.check();
        s.bind(cached);
        s.candidate = undefined;
        // Serve the existing cache before transport setup. Reopen failure leaves every
        // Repository operation available; Retry can re-enable the network later.
        const session = s;
        void s
          .lifecycle(() => session.enableTransport(a.account!))
          .catch((error) => {
            if (!session.closed && !session.receiptState.overflow)
              session.publish({
                ...session.receiptState,
                state: 'needs-sync',
                detail:
                  error instanceof Error && error.message === cacheWaitMessage
                    ? cacheWaitMessage
                    : 'Could not start sync. Retry when connected.',
              });
          });
      } else {
        const local = new DexieRepository(
          plain,
          options.files,
          undefined,
          a.mode === 'local',
        );
        await local.settleLocalWrites();
        s.check();
        s.bind(local);
      }
      s.check();
      return s;
    };
    options.signal?.addEventListener('abort', abort);
    try {
      // A mounted route owns this startup; an entered platform call can
      // remain pending after Dexie closes, so explicitly release the caller.
      return await Promise.race([initialize(), cancelled]);
    } catch (error) {
      s?.close();
      plain.close();
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', abort);
    }
  }
  attachController(controller: Controller) {
    this.controller = controller;
  }
  private check() {
    if (this.closed) throw Error('Session closed.');
  }
  private async bound<T>(promise: Promise<T>, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, rej) => {
          timer = setTimeout(
            () => rej(Error(message)),
            this.options.timeoutMs ?? 10000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private async cloud(mode: 'startup' | 'manual' | 'automatic') {
    this.check();
    const automaticSync = mode === 'automatic';
    if (!this.opening) {
      const opts = {
        name: this.options.cloudName ?? 'scratchtree-cloud-v8',
        databaseUrl: this.options.databaseUrl,
        automaticSync,
      };
      const db =
        this.options.createDatabase?.(opts) ?? new ScratchtreeDatabase(opts);
      const ready = db.open();
      this.opening = { db, automaticSync, ready, abandoned: false };
      void ready.catch(() => {
        if (this.opening?.db === db) {
          this.opening = undefined;
          db.close();
        }
      });
    }
    const opening = this.opening;
    if (opening.automaticSync !== automaticSync) throw inactive();
    opening.abandoned = false;
    // Startup waits for the cache to settle. Route disposal aborts the Session open.
    if (mode === 'startup') await opening.ready;
    else {
      try {
        await this.bound(opening.ready, cacheWaitMessage);
      } catch (error) {
        // An idle automatic connection must not start serving transport
        // unchecked when a timed-out caller is no longer there to bind it.
        if (automaticSync && this.opening === opening) this.abandonOpening();
        throw error;
      }
    }
    this.check();
    if (this.opening !== opening || opening.abandoned) throw inactive();
    this.opening = undefined;
    this.candidate = opening.db;
    return opening.db;
  }
  private abandonOpening() {
    const opening = this.opening;
    if (!opening || opening.abandoned) return;
    // Let the entered SDK ready handler drain. Only the same, still-abandoned
    // opening may be disposed; a newer explicit retry can claim it meanwhile.
    opening.abandoned = true;
    void opening.ready.then(
      () => {
        if (this.opening === opening && opening.abandoned) {
          this.opening = undefined;
          opening.db.close();
        }
      },
      () => {},
    );
  }
  private async requireUser(db: ScratchtreeDatabase, expected: string | null) {
    const u = db.cloud.currentUser.getValue();
    if (!u.isLoggedIn || !u.userId)
      throw Error('The saved sign-in is unavailable.');
    const account = await digest(['scratchtree-library', u.userId]);
    if (expected && account !== expected)
      throw Error(
        'These notes belong to another account. Sign out and use the original account.',
      );
    return account;
  }
  private async mark(next: Activation) {
    this.check();
    await setActivation(this.plain, next);
    this.activation = next;
  }
  private async prepare() {
    this.check();
    if (this.activation.mode === 'attached') throw inactive();
    if (this.activation.cleanupNeeded) await this.cleanup();
    const db = await this.cloud('manual');
    // No credentials can be created until we hand the ready API to login.
    try {
      await this.mark({ ...this.activation, cleanupNeeded: true });
    } catch (error) {
      db.close();
      this.candidate = undefined;
      throw error;
    }
    if (db.cloud.currentUser.getValue().isLoggedIn)
      throw Error('Finish the previous sign-out before signing in.');
    return db.cloud;
  }
  private async cleanup() {
    if (this.activation.mode === 'attached')
      throw Error('Protect the local library before signing out.');
    const db = this.candidate?.isOpen()
      ? this.candidate
      : await this.cloud('manual');
    try {
      await this.bound(
        db.cloud.logout({ force: true }),
        'Previous sign-out still needs cleanup. Retry when connected.',
      );
      if (db.cloud.currentUser.getValue().isLoggedIn)
        throw Error('Sign-out has not finished.');
      await this.mark({ ...this.activation, cleanupNeeded: false });
    } finally {
      db.close();
      this.candidate = undefined;
    }
  }
  private async flush() {
    if (this.controller && !(await this.controller.flush()))
      throw Error('Save your current input before switching notes.');
  }
  private async signOut() {
    if (this.expiredRecovery)
      throw Error(
        'Export the full raw library before repairing this expired cache.',
      );
    await this.flush();
    const account = this.activation.account;
    await this.lifecycle(async () => {
      this.check();
      if (this.activation.account !== account) throw inactive();
      // Drain SDK startup before logout. An attached view owns a separate
      // transport candidate; an authenticated, unadopted view needs its
      // controlled connection to finish the actual logout.
      if (this.opening?.automaticSync) {
        const spare = await this.cloud('automatic');
        spare.close();
        this.candidate = undefined;
      } else if (
        this.activation.mode !== 'attached' &&
        this.activation.cleanupNeeded &&
        !this.candidate?.isOpen()
      ) {
        await this.cloud('manual');
      }
      const leaving = this.repo;
      if (this.activation.mode === 'attached') {
        await this.writes(async () => {
          if (this.repo !== leaving) throw inactive();
          const t = await leaving.readTransfer();
          const a = await detach(this.plain, t, this.activation.account!);
          this.activation = a;
          this.automatic = false;
          this.candidate = leaving.db;
          const local = new DexieRepository(this.plain, this.options.files);
          local.bindTransferredEpoch(t.epoch);
          this.adoptView(local, t.epoch);
        });
      }
      if (this.activation.cleanupNeeded)
        try {
          await this.cleanup();
        } catch {
          /* The durable marker blocks reuse until explicit cleanup succeeds. */
        }
      this.join = null;
    });
    // The durable detached marker is authoritative even if a later view refresh needs retry.
    void this.refreshController().catch(() =>
      this.publish({
        ...this.syncState,
        detail: 'Refresh your local notes to continue.',
      }),
    );
  }
  private async finish(
    consented: boolean,
  ): Promise<NonNullable<AuthState['join']> | null> {
    await this.flush();
    const result = await this.lifecycle(async () => {
      this.check();
      if (this.activation.mode === 'attached') {
        await this.enableTransport(this.activation.account!);
        return null;
      }
      let db = this.candidate;
      if (!db?.isOpen()) db = await this.cloud('manual');
      const account = await this.requireUser(db, this.activation.account);
      // Reopen after the first authenticated sync. Fresh services learn public primary-key
      // metadata on a real subsequent write; a no-change sync cannot register that schema.
      db.close();
      this.candidate = undefined;
      db = await this.cloud('manual');
      await this.requireUser(db, account);
      await this.bound(
        db.cloud.sync({ purpose: 'pull', wait: true }),
        'Could not retrieve synced notes. Retry when connected.',
      );
      const localRepo = this.repo;
      const outcome = await this.writes(async () => {
        this.check();
        if (this.repo !== localRepo) throw inactive();
        const local = await localRepo.readTransfer(),
          pointer = await db.libraries.get(account);
        const repo = new DexieRepository(db, this.options.files, account);
        let remote = null;
        if (pointer) {
          await repo.loadWorkspace();
          remote = await repo.readTransfer();
        }
        const preview = {
          localNotes: local.backup.library.items.length,
          cloudNotes: remote?.backup.library.items.length ?? 0,
        };
        if (
          !this.activation.baseline &&
          remote &&
          (local.backup.library.items.length ||
            local.backup.device.drafts.length ||
            local.backup.library.purgedIds.length) &&
          (remote.backup.library.items.length ||
            remote.backup.library.purgedIds.length)
        ) {
          const signature = await digest([
            account,
            local.epoch,
            local.backup.library,
            local.backup.device,
            remote.epoch,
            remote.backup.library,
          ]);
          if (!consented || signature !== this.join) {
            this.join = signature;
            return { preview };
          }
          await this.options.files.writeSafety(JSON.stringify(local.backup));
        }
        const { transfer, admitted } = reconcileTransfer(
          local,
          remote,
          this.activation.baseline,
          account,
        );
        await repo.adoptTransfer(
          remote
            ? { epoch: remote.epoch, library: remote.backup.library }
            : null,
          transfer,
          // Fresh seeding writes the complete captured snapshot. Any remaining
          // never-bound intents lacked a proven local completion at startup.
          this.activation.mode === 'local' ? [] : admitted,
        );
        // Both stores are durable here. Only the final plain marker permits future attached opens.
        await this.mark({
          version: 1,
          mode: 'attached',
          cleanupNeeded: false,
          account,
          baseline: null,
        });
        this.candidate = undefined;
        this.adoptView(repo, local.epoch);
        this.join = null;
        return { preview: null };
      });
      if (outcome.preview) return outcome.preview;
      // Reopen using public SDK configuration so future writes and remote changes sync automatically.
      await this.enableTransport(account);
      return null;
    });
    if (!result) await this.refreshController();
    return result;
  }
  private async enableTransport(account: string) {
    if (
      this.activation.mode !== 'attached' ||
      this.activation.account !== account
    )
      throw inactive();
    const old = this.repo;
    const db = await this.cloud('automatic');
    try {
      await this.requireUser(db, account);
      await this.writes(async () => {
        this.check();
        if (this.repo !== old) throw inactive();
        const repo = new DexieRepository(db, this.options.files, account);
        const previousEpoch = old.viewEpoch;
        await repo.loadWorkspace();
        if (
          previousEpoch &&
          previousEpoch !== repo.viewEpoch &&
          !this.priorEpoch
        ) {
          const preserving = this.preservingSwitch;
          this.priorEpoch =
            preserving &&
            preserving.generation === this.controller?.state.cacheGeneration
              ? preserving.epoch
              : previousEpoch;
        }
        this.automatic = true;
        this.bind(repo);
        this.candidate = undefined;
        old.close();
      });
    } catch (error) {
      db.close();
      this.candidate = undefined;
      throw error;
    }
  }
  private adoptView(repo: DexieRepository, prior: string) {
    this.priorEpoch = prior;
    this.preservingSwitch = undefined;
    this.bind(repo);
  }
  // Reopening transport serves the same view, including any unfinished controller preservation.
  private bind(repo: DexieRepository) {
    this.engine?.close();
    this.repo = repo;
    this.engine = new SyncEngine({
      repository: repo,
      db: repo.db,
      files: this.options.files,
      fetch: this.options.fetch,
      serialize: this.lifecycle,
      onInvalidation: () => {
        if (this.repo === repo && !this.closed)
          void this.refreshController().catch(() => {});
      },
    });
    this.engine.subscribe((s) => this.publish(s));
    if (!this.expiredRecovery) this.engine.start();
  }
  private publish(s: SyncState) {
    this.receiptState = s;
    this.presentStatus();
  }
  private presentStatus() {
    const a = this.auth.state;
    this.syncState =
      a.phase === 'syncing'
        ? {
            ...this.receiptState,
            state: a.canCancel ? 'needs-sync' : 'syncing',
            detail:
              a.error ??
              (a.join
                ? 'Review and confirm the note merge.'
                : 'Retrieving your synced notes.'),
          }
        : this.receiptState;
    for (const f of this.listeners) f(this.syncState);
  }
  private async refreshController() {
    if (
      this.controller &&
      !this.closed &&
      !(await this.controller.refreshFromRepository())
    )
      throw Error('Could not refresh your notes. Your input is retained.');
  }
  private refresh(buffers: RemoteBuffer[]) {
    if (this.expiredRecovery) return Promise.reject(inactive());
    const repo = this.repo;
    return this.writes(async () => {
      if (this.repo !== repo || this.closed) throw inactive();
      const generation = this.controller?.state.cacheGeneration;
      if (this.preservingSwitch?.generation !== generation)
        this.preservingSwitch = undefined;
      const switched = this.priorEpoch;
      const remaining: RemoteBuffer[] = [];
      const retired: RemoteBuffer[] = [];
      for (const b of buffers) {
        if (
          switched ||
          (this.preservingSwitch &&
            b.originEpoch === this.preservingSwitch.epoch)
        )
          retired.push(b);
        else remaining.push(b);
      }
      const old = switched ?? this.preservingSwitch?.epoch;
      if (old && retired.length)
        await repo.archiveSwitchedBuffers(retired, old);
      // Repository handles ordinary origin labels and cross-epoch remote changes.
      const result = await repo.refreshFromRemote(remaining);
      if (switched) {
        result.replaced = true;
        result.originEpoch = switched;
        if (generation !== undefined)
          this.preservingSwitch = { epoch: switched, generation };
        this.priorEpoch = null;
      }
      return result;
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.stopAuth();
    this.engine?.close();
    this.opening?.db.close();
    this.opening = undefined;
    this.candidate?.close();
    this.repo?.close();
    this.plain.close();
    this.listeners.clear();
    this.controller = undefined;
  }
}
