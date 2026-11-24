# Synthetic library backups

Use these BackupV8 fixtures for repeatable performance and manual testing. The notes are generated Markdown with fixed IDs, timestamps, and ordering. Each file starts with an empty Trash, no drafts, and no recovery history.

| Backup                                               |  Notes | Trees | Cards in Root | Use                                                  |
| ---------------------------------------------------- | -----: | ----: | ------------: | ---------------------------------------------------- |
| [small.json.gz](small.json.gz)                       |     48 |    24 |            48 | Quick smoke tests                                    |
| [medium.json.gz](medium.json.gz)                     |  1,200 |    72 |            48 | Distributed library baseline                         |
| [medium-short.json.gz](medium-short.json.gz)         |  1,200 |    72 |            48 | Short Markdown at the same item count                |
| [medium-long.json.gz](medium-long.json.gz)           |  1,200 |    72 |            48 | More Markdown at the same item count                 |
| [medium-wide-root.json.gz](medium-wide-root.json.gz) |  1,200 |    72 |           624 | The same Markdown as medium, with more Root siblings |
| [large.json.gz](large.json.gz)                       |  3,000 |   144 |            48 | Large library with most notes inside trees           |
| [very-large.json.gz](very-large.json.gz)             | 19,000 |   500 |            48 | 500 slots below the 20,000-item ceiling              |

## Restore into a test app

Run from the repository root to decompress the large fixture. Change `fixture` to select another backup.

```sh
fixture=large
test_dir=".projects/$(date +%F)-library-backups"
mkdir -p "$test_dir"
backup="$test_dir/$fixture.json"
gzip -dc "tests/fixtures/library-backups/$fixture.json.gz" > "$backup"
printf '%s\n' "$PWD/$backup"
```

1. Open a disposable Mac app with a fresh, signed-out test profile. Ordinary Preview also works with an empty, signed-out profile reserved for synthetic notes.
2. Select **Restore backup**, choose the decompressed `.json` file, and check the preview's note and tree counts against the table.
3. Select **Replace library**. Restore replaces the destination library, so always use the disposable test profile.

Start each comparison run with a fresh disposable profile and restore the fixture once. Restore can retain the outgoing library in recovery, so reusing a populated profile can change what gets measured or hit the backup size limit. Use `medium` and `medium-wide-root` to compare sibling width at the same library size. Use `medium-short` and `medium-long` to compare Markdown size at the same item count and layout. Keep a fresh empty profile for the zero-note baseline.

The [fixture test](../../unit/library-backups.test.ts) decompresses each archive and checks it with Scratchtree's current backup validator.
