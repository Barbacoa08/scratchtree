/** Platform backup input and output; cancellation returns null. */
export interface BackupFiles {
  readonly restoreWarning?: string;
  chooseRead(): Promise<string | null>;
  chooseWrite(text: string): Promise<string | null>;
  chooseRecoveryWrite?(chunks: AsyncIterable<string>): Promise<string | null>;
  writeSafety(text: string): Promise<void>;
}
