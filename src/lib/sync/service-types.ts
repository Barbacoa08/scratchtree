export type AuthPhase =
  | 'signed-out'
  | 'email'
  | 'sending-code'
  | 'code'
  | 'verifying'
  | 'syncing'
  | 'signed-in'
  | 'signing-out';
export type AuthState = {
  phase: AuthPhase;
  open: boolean;
  email: string;
  error: string | null;
  canCancel: boolean;
  /** The captured request is still pending, but the dialog may be closed. */
  pendingRecovery?: boolean;
  authenticated: boolean;
  configured: boolean;
  join?: { localNotes: number; cloudNotes: number } | null;
};
export type AuthPort = {
  subscribe(listener: (s: AuthState) => void): () => void;
  showSignIn(): void;
  submitEmail(email: string): Promise<void>;
  submitCode(code: string): Promise<void>;
  restartSignIn?(): void;
  dismiss(): void;
  signOut(): Promise<void>;
  retrySync(): Promise<void>;
  mergeNotes?(): Promise<void>;
};
export type SyncState = {
  state: 'local-only' | 'needs-sync' | 'syncing' | 'up-to-date';
  lastConfirmed: number | null;
  detail: string | null;
  recoveries: number;
  readOnlyRecovery?: boolean;
  overflow?: { items: number; correctable?: boolean };
};
export type SyncPort = {
  subscribe(listener: (s: SyncState) => void): () => void;
  retry(): Promise<void>;
  exportRecovery(): Promise<void>;
  exportOverflow(): Promise<void>;
  inspectOverflow?(): Promise<{
    epoch: string;
    overflow: boolean;
    rows: { id: string; markdown: string }[];
  }>;
  purgeOverflow?(request: { epoch: string; ids: string[] }): Promise<void>;
};
