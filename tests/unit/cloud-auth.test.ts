import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CloudAuthController,
  type AuthHost,
  type CloudLogin,
} from '../../src/lib/sync/auth';
import type { DXCUserInteraction, UserLogin } from 'dexie-cloud-addon';

function setup() {
  let interaction:
    ((prompt: DXCUserInteraction | undefined) => void) | undefined;
  let resolveLogin!: () => void;
  let rejectLogin!: (error: Error) => void;
  let cancelled = 0;
  let started = 0;
  let submitted = 0;
  const hints: unknown[] = [];
  const user: UserLogin = {
    claims: {},
    lastLogin: new Date(),
    isLoggedIn: false,
  };
  const api: CloudLogin = {
    currentUser: { getValue: () => user },
    userInteraction: {
      subscribe: (listener) => {
        interaction = listener;
        return {
          unsubscribe: () => {
            interaction = undefined;
          },
        };
      },
    },
    login: (hint) => {
      hints.push(hint);
      started++;
      return new Promise<void>((resolve, reject) => {
        resolveLogin = resolve;
        rejectLogin = reject;
      });
    },
  };
  let finishCount = 0;
  let join: { localNotes: number; cloudNotes: number } | null = null;
  let failFinish = false;
  let signedOut = 0;
  const host: AuthHost = {
    configured: true,
    accountExists: async () => true,
    prepareSignIn: async () => api,
    cancelSignIn: async () => {
      cancelled++;
    },
    finishSignIn: async () => {
      finishCount++;
      if (failFinish) throw new Error('Offline');
      return join;
    },
    mergeNotes: async () => {
      join = null;
    },
    signOut: async () => {
      signedOut++;
    },
  };
  const auth = new CloudAuthController(host);
  const tick = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  const otp = (invalid = false) =>
    interaction?.({
      type: 'otp',
      title: 'Code',
      fields: { otp: { type: 'text', label: 'Code' } },
      alerts: invalid
        ? [
            {
              type: 'error',
              messageCode: 'INVALID_OTP',
              message: 'Wrong code',
              messageParams: {},
            },
          ]
        : [
            {
              type: 'info',
              messageCode: 'OTP_SENT',
              message: 'Code sent',
              messageParams: {},
            },
          ],
      submitLabel: 'Submit',
      cancelLabel: 'Cancel',
      onSubmit: () => {
        submitted++;
      },
      onCancel: () => rejectLogin(new Error('Cancelled')),
    });
  return {
    auth,
    host,
    tick,
    otp,
    hints,
    user,
    success: () => {
      user.isLoggedIn = true;
      resolveLogin();
    },
    prompt: (p: DXCUserInteraction) => interaction?.(p),
    failure: () => rejectLogin(new Error('Offline')),
    setJoin: () => {
      join = { localNotes: 2, cloudNotes: 3 };
    },
    setFailFinish: (value: boolean) => {
      failFinish = value;
    },
    counts: () => ({ started, submitted, cancelled, finishCount, signedOut }),
  };
}

describe('public Dexie login flow', () => {
  afterEach(() => vi.useRealTimers());

  async function challenge(f: ReturnType<typeof setup>) {
    f.auth.showSignIn();
    const email = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.otp();
    await email;
  }

  it('offers recovery at five seconds without submitting another code or adopting late authentication after Close', async () => {
    vi.useFakeTimers();
    const f = setup();
    await challenge(f);
    const code = f.auth.submitCode('123456');
    await vi.advanceTimersByTimeAsync(4999);
    expect(f.auth.state.canCancel).toBe(false);
    f.auth.dismiss();
    expect(f.auth.state.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.auth.state).toMatchObject({
      phase: 'verifying',
      canCancel: true,
      pendingRecovery: true,
    });
    await f.auth.submitCode('654321');
    f.auth.dismiss();
    await code;
    f.success();
    await f.tick();
    expect(f.auth.state).toMatchObject({
      open: false,
      authenticated: false,
      phase: 'signed-out',
    });
    expect(f.counts()).toMatchObject({
      started: 1,
      submitted: 1,
      finishCount: 0,
      cancelled: 1,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the original recovery deadline when verification becomes a pending initial sync', async () => {
    vi.useFakeTimers();
    const f = setup();
    let release!: () => void;
    f.host.finishSignIn = () =>
      new Promise((resolve) => {
        release = () => resolve(null);
      });
    await challenge(f);
    const code = f.auth.submitCode('123456');
    await vi.advanceTimersByTimeAsync(4000);
    f.success();
    await f.tick();
    expect(f.auth.state).toMatchObject({
      phase: 'syncing',
      authenticated: true,
      canCancel: false,
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(f.auth.state.canCancel).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.auth.state).toMatchObject({
      canCancel: true,
      pendingRecovery: true,
    });
    f.auth.dismiss();
    expect(f.auth.state.open).toBe(false);
    release();
    await code;
    await f.tick();
    expect(f.auth.state).toMatchObject({
      phase: 'signed-in',
      open: false,
      pendingRecovery: false,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps recovery available if authentication succeeds after the deadline but sync remains pending', async () => {
    vi.useFakeTimers();
    const f = setup();
    let release!: () => void;
    f.host.finishSignIn = () =>
      new Promise((resolve) => {
        release = () => resolve(null);
      });
    await challenge(f);
    const code = f.auth.submitCode('123456');
    await vi.advanceTimersByTimeAsync(5000);
    await code;
    f.success();
    await f.tick();
    expect(f.auth.state).toMatchObject({
      phase: 'syncing',
      authenticated: true,
      canCancel: true,
      pendingRecovery: true,
    });
    f.auth.dismiss();
    release();
    await f.tick();
    expect(f.auth.state).toMatchObject({ phase: 'signed-in', open: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps local use available while canceled provider work drains before another login', async () => {
    vi.useFakeTimers();
    const f = setup();
    await challenge(f);
    // A provider may ignore cancellation while its verification request is pending.
    f.prompt({
      type: 'otp',
      title: 'Code',
      submitLabel: 'Submit',
      cancelLabel: 'Cancel',
      fields: { otp: { type: 'text', label: 'Code' } },
      alerts: [
        {
          type: 'info',
          messageCode: 'OTP_SENT',
          message: 'Code sent',
          messageParams: {},
        },
      ],
      onSubmit: () => {},
      onCancel: () => {},
    });
    const code = f.auth.submitCode('123456');
    await vi.advanceTimersByTimeAsync(5000);
    f.auth.dismiss();
    await code;
    f.auth.showSignIn();
    const next = f.auth.submitEmail('next@example.com');
    await f.tick();
    expect(f.counts().started).toBe(1);
    expect(f.auth.state).toMatchObject({
      phase: 'sending-code',
      canCancel: true,
    });
    f.auth.dismiss();
    f.success();
    await next;
    expect(f.counts()).toMatchObject({
      started: 1,
      finishCount: 0,
      cancelled: 1,
    });
    expect(f.auth.state).toMatchObject({ phase: 'signed-out', open: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds pending sync Retry and explicit adoption without duplicating their writes', async () => {
    vi.useFakeTimers();
    const f = setup();
    f.setFailFinish(true);
    await challenge(f);
    const code = f.auth.submitCode('123456');
    f.success();
    await code;
    let release!: () => void;
    let calls = 0;
    f.host.finishSignIn = () => {
      calls++;
      return new Promise((resolve) => {
        release = () => resolve({ localNotes: 2, cloudNotes: 3 });
      });
    };
    const retry = f.auth.retrySync();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.auth.state).toMatchObject({
      canCancel: true,
      pendingRecovery: true,
    });
    await f.auth.retrySync();
    expect(calls).toBe(1);
    release();
    await retry;
    let adopted = 0;
    f.host.mergeNotes = () => {
      adopted++;
      return new Promise((resolve) => {
        release = () => resolve();
      });
    };
    const adoption = f.auth.mergeNotes();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.auth.state).toMatchObject({
      canCancel: true,
      pendingRecovery: true,
    });
    await f.auth.mergeNotes();
    expect(adopted).toBe(1);
    f.auth.dismiss();
    release();
    await adoption;
    expect(f.auth.state).toMatchObject({
      phase: 'signed-in',
      open: false,
      pendingRecovery: false,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears an invalid-code deadline before a new verification gets its own full grace period', async () => {
    vi.useFakeTimers();
    const f = setup();
    await challenge(f);
    const first = f.auth.submitCode('123456');
    await vi.advanceTimersByTimeAsync(4000);
    f.otp(true);
    await first;
    expect(vi.getTimerCount()).toBe(0);
    const second = f.auth.submitCode('654321');
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.auth.state.canCancel).toBe(false);
    await vi.advanceTimersByTimeAsync(4000);
    f.auth.dismiss();
    await second;
    await f.tick();
    expect(f.auth.state.open).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('requests existing-user OTP once, and only enables the code after OTP_SENT', async () => {
    const f = setup();
    f.auth.showSignIn();
    const pending = f.auth.submitEmail(' dev@example.com ');
    await f.tick();
    expect(f.auth.state.phase).toBe('sending-code');
    await f.auth.submitEmail('other@example.com');
    expect(f.hints).toEqual([
      { email: 'dev@example.com', grant_type: 'otp', intent: 'login' },
    ]);
    f.otp();
    await pending;
    expect(f.auth.state).toMatchObject({
      phase: 'code',
      email: 'dev@example.com',
      canCancel: true,
    });
  });

  it('cancels an unknown-user retry instead of submitting to an intent-losing email prompt', async () => {
    const f = setup();
    f.auth.showSignIn();
    const pending = f.auth.submitEmail('dev@example.com');
    await f.tick();
    let submitted = false;
    f.prompt({
      type: 'email',
      title: 'Email',
      fields: { email: { type: 'text', placeholder: 'Email' } },
      alerts: [
        {
          type: 'error',
          messageCode: 'USER_NOT_REGISTERED',
          message: 'Unknown',
          messageParams: {},
        },
      ],
      submitLabel: 'Submit',
      cancelLabel: 'Cancel',
      onSubmit: () => {
        submitted = true;
      },
      onCancel: () => f.failure(),
    });
    await pending;
    await f.tick();
    expect(submitted).toBe(false);
    expect(f.auth.state).toMatchObject({
      phase: 'email',
      error: 'That account does not exist. Sign-up is coming soon.',
    });
    const second = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.otp();
    await second;
    expect(f.counts().started).toBe(2);
    expect(f.hints).toHaveLength(2);
  });

  it('blocks cancellation during verification and retains the challenge after an invalid code', async () => {
    const f = setup();
    f.auth.showSignIn();
    const email = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.otp();
    await email;
    const code = f.auth.submitCode('123456');
    await f.tick();
    expect(f.auth.state).toMatchObject({
      phase: 'verifying',
      canCancel: false,
    });
    f.auth.dismiss();
    expect(f.auth.state.open).toBe(true);
    f.otp(true);
    await code;
    expect(f.auth.state).toMatchObject({
      phase: 'code',
      email: 'dev@example.com',
      canCancel: true,
      error: 'That code is invalid or expired. Try again.',
    });
  });

  it('distinguishes authenticated-but-pending sync from completed sign-in', async () => {
    const f = setup();
    f.setFailFinish(true);
    f.auth.showSignIn();
    const email = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.otp();
    await email;
    const code = f.auth.submitCode('123456');
    f.success();
    await code;
    expect(f.auth.state).toMatchObject({
      phase: 'syncing',
      authenticated: true,
      open: true,
      error: 'Offline',
    });
    f.setFailFinish(false);
    await f.auth.retrySync();
    expect(f.auth.state).toMatchObject({
      phase: 'signed-in',
      authenticated: true,
      open: false,
    });
    expect(f.counts().started).toBe(1);
  });

  it('does not adopt a pre-existing cloud library until explicitly accepted', async () => {
    const f = setup();
    f.setJoin();
    f.auth.showSignIn();
    const email = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.otp();
    await email;
    const code = f.auth.submitCode('123456');
    f.success();
    await code;
    expect(f.auth.state).toMatchObject({
      phase: 'syncing',
      open: true,
      join: { localNotes: 2, cloudNotes: 3 },
    });
    f.auth.dismiss();
    expect(f.auth.state.open).toBe(false);
    f.auth.showSignIn();
    expect(f.auth.state).toMatchObject({
      open: true,
      phase: 'syncing',
      join: { localNotes: 2, cloudNotes: 3 },
    });
    await f.auth.mergeNotes();
    expect(f.auth.state).toMatchObject({
      phase: 'signed-in',
      open: false,
      join: null,
    });
  });

  it('keeps an uninterruptible initial adoption open until the join or error is available', async () => {
    const f = setup();
    let release!: () => void;
    f.host.finishSignIn = () =>
      new Promise((resolve) => {
        release = () => resolve(null);
      });
    f.auth.showSignIn();
    const email = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.otp();
    await email;
    const code = f.auth.submitCode('123456');
    f.success();
    await f.tick();
    f.auth.dismiss();
    expect(f.auth.state).toMatchObject({
      open: true,
      phase: 'syncing',
      canCancel: false,
    });
    release();
    await code;
  });

  it('settles cancellation before a new attempt and ignores late completion', async () => {
    const f = setup();
    f.auth.showSignIn();
    const first = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.otp();
    await first;
    f.auth.dismiss();
    await f.tick();
    expect(f.auth.state).toMatchObject({ open: false, authenticated: false });
    expect(f.counts().cancelled).toBe(1);
    f.auth.showSignIn();
    const next = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.otp();
    await next;
    expect(f.auth.state.phase).toBe('code');
    expect(f.counts().finishCount).toBe(0);
  });

  it('keeps authenticated state if preserving notes during sign-out fails', async () => {
    const host: AuthHost = {
      configured: true,
      accountExists: async () => true,
      prepareSignIn: async () => {
        throw Error('Unused');
      },
      cancelSignIn: async () => {},
      finishSignIn: async () => null,
      mergeNotes: async () => {},
      signOut: async () => {
        throw Error('Storage full');
      },
    };
    const auth = new CloudAuthController(host, true);
    await auth.signOut();
    expect(auth.state).toMatchObject({
      phase: 'signed-in',
      authenticated: true,
      error: 'Storage full',
    });
  });

  it('allows retrying interrupted cleanup instead of permanently disabling sign-in', async () => {
    let fail = true;
    const f = setup();
    // The session keeps its durable cleanup marker on failure, and must get
    // another opportunity to finish it before a new login can start.
    f.host.cancelSignIn = async () => {
      if (fail) throw Error('Offline cleanup');
    };
    f.auth.showSignIn();
    const email = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.otp();
    await email;
    f.auth.dismiss();
    await f.tick();
    fail = false;
    f.auth.showSignIn();
    const retry = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.otp();
    await retry;
    expect(f.auth.state.phase).toBe('code');
    expect(f.counts().started).toBe(2);
  });

  it('explicitly restarts a code challenge with login-only intent and the retained email', async () => {
    const f = setup();
    f.auth.showSignIn();
    const first = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.otp();
    await first;
    f.auth.restartSignIn();
    expect(f.auth.state).toMatchObject({
      phase: 'email',
      email: 'dev@example.com',
      open: true,
    });
    const second = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.otp();
    await second;
    expect(f.hints).toEqual([
      { email: 'dev@example.com', grant_type: 'otp', intent: 'login' },
      { email: 'dev@example.com', grant_type: 'otp', intent: 'login' },
    ]);
  });

  it('cancels an OTP prompt arriving after Close while its email request was in flight', async () => {
    const f = setup();
    f.auth.showSignIn();
    const email = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.auth.dismiss();
    f.otp();
    await email;
    await f.tick();
    expect(f.counts().cancelled).toBe(1);
    f.auth.showSignIn();
    const next = f.auth.submitEmail('next@example.com');
    await f.tick();
    expect(f.counts().started).toBe(2);
    f.otp();
    await next;
    expect(f.auth.state).toMatchObject({
      phase: 'code',
      email: 'next@example.com',
    });
  });

  it('settles a stale email submission waiting on cleanup without starting it in a newer modal', async () => {
    const f = setup();
    let release!: () => void;
    f.host.cancelSignIn = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    f.auth.showSignIn();
    const first = f.auth.submitEmail('first@example.com');
    await f.tick();
    f.otp();
    await first;
    f.auth.dismiss();
    await f.tick();
    f.auth.showSignIn();
    const stale = f.auth.submitEmail('stale@example.com');
    await f.tick();
    f.auth.restartSignIn();
    const latest = f.auth.submitEmail('latest@example.com');
    await f.tick();
    release();
    await f.tick();
    expect(f.hints).toEqual([
      { email: 'first@example.com', grant_type: 'otp', intent: 'login' },
      { email: 'latest@example.com', grant_type: 'otp', intent: 'login' },
    ]);
    await stale;
    f.otp();
    await latest;
    expect(f.auth.state).toMatchObject({
      phase: 'code',
      email: 'latest@example.com',
    });
  });

  it('retains pending-sync retry ownership when the sign-out preservation barrier fails', async () => {
    const f = setup();
    f.setFailFinish(true);
    f.auth.showSignIn();
    const email = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.otp();
    await email;
    const code = f.auth.submitCode('123456');
    f.success();
    await code;
    f.host.signOut = async () => {
      throw Error('Storage full');
    };
    await f.auth.signOut();
    expect(f.auth.state).toMatchObject({
      phase: 'syncing',
      open: true,
      authenticated: true,
      error: 'Storage full',
    });
    f.setFailFinish(false);
    await f.auth.retrySync();
    expect(f.auth.state).toMatchObject({ phase: 'signed-in', open: false });
    expect(f.counts().finishCount).toBe(2);
  });

  it('rejects an unlisted account before opening Dexie authentication or sending a code', async () => {
    const f = setup();
    f.host.accountExists = async () => false;
    f.auth.showSignIn();
    const pending = f.auth.submitEmail('unknown@example.invalid');
    await f.tick();
    expect(f.auth.state).toMatchObject({
      phase: 'email',
      error: 'That account does not exist. Sign-up is coming soon.',
    });
    expect(f.hints).toHaveLength(0);
    await pending;
  });

  it('retains email and blocks OTP when the account endpoint fails', async () => {
    const f = setup();
    f.host.accountExists = async () => {
      throw Error('Account check failed. Try again later.');
    };
    f.auth.showSignIn();
    const pending = f.auth.submitEmail('dev@example.com');
    await f.tick();
    expect(f.auth.state).toMatchObject({
      phase: 'email',
      email: 'dev@example.com',
      error: 'Account check failed. Try again later.',
    });
    expect(f.hints).toHaveLength(0);
    await pending;
  });

  it('cannot let a late account-check response change a newer login', async () => {
    const f = setup();
    let release!: (allowed: boolean) => void;
    f.host.accountExists = (email) =>
      email === 'old@example.invalid'
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(true);
    f.auth.showSignIn();
    const old = f.auth.submitEmail('old@example.invalid');
    await f.tick();
    f.auth.dismiss();
    f.auth.showSignIn();
    const current = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.otp();
    await current;
    release(false);
    await old;
    expect(f.auth.state).toMatchObject({
      phase: 'code',
      email: 'dev@example.com',
      error: null,
    });
    expect(f.hints).toHaveLength(1);
  });
});
