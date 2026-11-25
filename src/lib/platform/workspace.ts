import type { WorkspaceSnapshot, Location, ColorToken } from '../domain/notes';
import type { HistoryRequest } from '../domain/workspace-history';
export interface RestorePreview {
  token: string;
  notes: number;
  drafts: number;
  trees: number;
  warning: string;
}
export interface DraftAck {
  key: string;
  revision: number;
}
export interface CaptureItem {
  id: string;
  location: Location;
  markdown: string;
  draft: DraftAck;
}
export interface CreateChildTree {
  id: string;
  parent: Location;
  leave?: Location;
}
export interface ReorderItem {
  id: string;
  group: Location;
  toIndex: number;
  attempt?: { id: string; before: string[] };
}
export interface DeleteAttempt {
  id: string;
  from: Location;
  before: string[];
  trash: string[];
  descendants: Pick<StructuralItem, 'id' | 'parentId' | 'deletedAt'>[];
  deletedAt: number;
}
export interface PurgeItem {
  id: string;
  location: Location;
  expectedSubtreeIds: string[];
}
export type PurgeRequest =
  | PurgeItem
  | { ids: string[]; location: Location; expectedSubtreeIds: string[] };
export interface PurgeResult {
  workspace: WorkspaceSnapshot;
  removedIds: string[];
}
export interface TransitionLocation {
  from: Location;
  to: Location;
  promoteDestination: boolean;
}
export type StructuralItem = Pick<
  import('../domain/notes').Item,
  | 'id'
  | 'parentId'
  | 'kind'
  | 'position'
  | 'deletedAt'
  | 'restoreParentId'
  | 'restoreIndex'
>;
export interface StructuralProof {
  before: StructuralItem[];
  after: StructuralItem[];
}
export interface UndoDeleteRequest {
  ids: string[];
  proof: StructuralProof;
}
export interface MoveItems {
  operationId?: string;
  proof?: StructuralProof;
  deletedAt?: number;
  ids: string[];
  from: Location;
  to: Location;
  beforeFrom: string[];
  beforeTo: string[];
  afterFrom: string[];
  afterTo: string[];
}
/** Captured dirty input; origin fences repeats after a remote epoch was adopted. */
export interface RemoteBuffer {
  key: string;
  markdown: string;
  revision: number;
  originEpoch?: string;
}
export interface RemoteRefresh {
  workspace: WorkspaceSnapshot;
  replaced: boolean;
  removedIds: string[];
  originEpoch: string;
}
export interface Repository {
  /** Logical library generation, preserved when only transport changes. */
  readonly viewEpoch?: string | null;
  refreshFromRemote?(buffers: RemoteBuffer[]): Promise<RemoteRefresh>;
  loadWorkspace(): Promise<WorkspaceSnapshot>;
  /** Read the current bound epoch without adopting a replacement. */
  readBoundWorkspace?(epoch: string): Promise<WorkspaceSnapshot>;
  checkpointDraft(
    key: string,
    markdown: string,
    revision: number,
  ): Promise<WorkspaceSnapshot>;
  discardDraft(key: string): Promise<WorkspaceSnapshot>;
  saveItemSource(
    id: string,
    markdown: string,
    draft: DraftAck,
  ): Promise<WorkspaceSnapshot>;
  captureItem(request: CaptureItem): Promise<WorkspaceSnapshot>;
  createChildTree(request: CreateChildTree): Promise<WorkspaceSnapshot>;
  promoteItem(id: string): Promise<WorkspaceSnapshot>;
  deleteItem(
    id: string,
    leave?: Location,
    attempt?: DeleteAttempt,
  ): Promise<WorkspaceSnapshot>;
  purgeItem(request: PurgeRequest): Promise<PurgeResult>;
  transitionLocation(request: TransitionLocation): Promise<WorkspaceSnapshot>;
  moveItems(request: MoveItems): Promise<WorkspaceSnapshot>;
  restoreItem(id: string): Promise<WorkspaceSnapshot>;
  undoDelete(request: UndoDeleteRequest): Promise<WorkspaceSnapshot>;
  applyHistory(request: HistoryRequest): Promise<WorkspaceSnapshot>;
  setItemDone(id: string, done: boolean): Promise<WorkspaceSnapshot>;
  setItemsDone(ids: string[], done: boolean): Promise<WorkspaceSnapshot>;
  setItemColor(
    id: string,
    color: ColorToken | null,
  ): Promise<WorkspaceSnapshot>;
  reorderItem(request: ReorderItem): Promise<WorkspaceSnapshot>;
  exportBackup(): Promise<string | null>;
  previewRestore(): Promise<RestorePreview | null>;
  confirmRestore(
    token: string,
    confirm: boolean,
  ): Promise<WorkspaceSnapshot | null>;
}
