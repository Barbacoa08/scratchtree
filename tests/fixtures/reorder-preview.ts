import { COLORS, emptyWorkspace, type Item } from '../../src/lib/domain/notes';
import { encodeCloudBackup } from '../../src/lib/sync/backup';
import type { ScratchtreeDatabase } from '../../src/lib/sync/database';
import { orderRows, toSharedItem } from '../../src/lib/sync/representation';

const topics = [
  'Release planning',
  'Reading list',
  'Weekend projects',
  'Design notes',
  'Code snippets',
  'Travel planning',
  'Meeting notes',
  'Home projects',
  'Writing ideas',
  'Reference material',
  'Learning notes',
  'Ideas to try',
];
const sections = ['Plans', 'In progress', 'Reference'];
const noteTitles = [
  'Questions to revisit',
  'Next steps',
  'Quick reminder',
  'Things to compare',
  'Example',
  'Open questions',
  'Draft notes',
  'Ideas for later',
  'Things to keep',
  'Weekend checklist',
  'Summary',
  'Useful details',
];
const bodies = [
  'A quick thought to come back to.',
  '- [ ] Review the first pass\n- [ ] Write down the next decision\n- [ ] Check the result',
  '**Priority** for the next work session. Keep a short summary with the result.',
  'Use the smallest example first.\n\n```ts\nconst result = items.filter((item) => item.ready);\n```',
  '> There are two good ways to start. Try the simplest one first.\n\n1. Make a list\n2. Pick one item\n3. Check the outcome',
  '## Notes\n\nKeep the examples in this tree for reference.\n\n- Ask about the next step.\n- Save the draft.\n- Revisit the original question.\n- Write a summary.',
];

function sampleWorkspace() {
  const snapshot = emptyWorkspace();
  const append = (
    kind: Item['kind'],
    markdown: string,
    parentId: string | null,
    position: number,
  ) => {
    const ordinal = snapshot.items.length + 1;
    const id = `aabbccdd-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
    const time = Date.UTC(2026, 10, 1) + ordinal * 60_000;
    snapshot.items.push({
      id,
      parentId,
      kind,
      markdown,
      position,
      createdAt: time,
      updatedAt: time,
      deletedAt: null,
      restoreParentId: null,
      restoreIndex: null,
      done: kind === 'note' && ordinal % 14 === 0,
      color: ordinal % 4 === 0 ? COLORS[ordinal % COLORS.length] : null,
    });
    return id;
  };
  const notes = (owner: string, topic: string, length: number, offset = 0) => {
    for (let index = 0; index < length; index++)
      append(
        'note',
        `${noteTitles[index]} · ${topic}\n\n${bodies[(index + offset) % bodies.length]}`,
        owner,
        index + offset,
      );
  };
  topics.forEach((topic, index) => {
    append(
      'note',
      `What to try next · ${topic}\n\n${bodies[index % bodies.length]}`,
      null,
      index * 2,
    );
    const tree = append('tree', topic, null, index * 2 + 1);
    sections.forEach((section, position) => {
      const child = append('tree', `${topic} · ${section}`, tree, position);
      notes(child, section, noteTitles.length);
    });
    notes(tree, topic, 10, sections.length);
  });
  return snapshot;
}

export async function seedReorderPreview(db: ScratchtreeDatabase) {
  if (db.cloudEnabled || db.name !== 'scratchtree-reorder-preview-v1')
    throw Error('The comparison fixture requires its isolated database.');
  await db.transaction('rw', [db.libraries, db.notes, db.orders], async () => {
    if (await db.libraries.get('local')) return;
    const snapshot = sampleWorkspace();
    encodeCloudBackup({
      library: { items: snapshot.items, purgedIds: [] },
      device: { drafts: [], undoDeleteIds: [], recovery: [] },
    });
    const epoch = crypto.randomUUID();
    await db.libraries.add({ id: 'local', epoch });
    await db.notes.bulkAdd(
      snapshot.items.map((item) => toSharedItem(item, epoch)),
    );
    await db.orders.bulkAdd(orderRows(snapshot, epoch));
  });
}
