# Trash maintenance

Notes are eligible after more than 180 full days in Trash. Inherited Trash age follows the parent’s deletion date, with each note’s creation date as a lower bound. A younger descendant prevents purging its ancestors. A backup restore keeps the saved dates. Manual permanent deletion remains available.

Local-only desktop and web profiles catch up on open. A saved local draft protects its note and ancestors. An account copy kept after sign-out uses the account’s synced cleanup on reconnection. Synced drafts and unresolved local edits follow the existing recovery path when an item has been purged.

## Scheduled cleanup for synced notes

Use a separate Netlify maintenance project. Select the repository root as the base directory and `deploy/maintenance` as the package directory. The checked-in configuration publishes only the maintenance directory’s static files and functions. The Scheduled Function runs daily at midnight UTC on the published production deploy. There is no HTTP trigger. [Netlify Scheduled Functions](https://docs.netlify.com/build/functions/scheduled-functions/)

Set runtime values in the maintenance project’s production environment:

| Variable                                                                          | Purpose                                                                                                                                       |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCRATCHTREE_TRASH_SWEEP_MODE`                                                    | `disabled` by default, `dry-run` to read and count candidates, or `purge` to apply cleanup.                                                   |
| `SCRATCHTREE_TRASH_DEXIE_URL`                                                     | Dexie Cloud database origin for the selected environment.                                                                                     |
| `SCRATCHTREE_TRASH_DEXIE_CLIENT_ID` and `SCRATCHTREE_TRASH_DEXIE_CLIENT_SECRET`   | Dedicated service client authorized for `ACCESS_DB` and `IMPERSONATE`. The worker requests only an `ACCESS_DB` token for the configured user. |
| `SCRATCHTREE_TRASH_DEXIE_USER_ID`                                                 | Exact Dexie user ID of the account to sweep. The worker derives the Scratchtree library key from it.                                          |
| `SCRATCHTREE_TRASH_CRONITOR_API_KEY` and `SCRATCHTREE_TRASH_CRONITOR_MONITOR_KEY` | Telemetry-only key and heartbeat monitor for the daily job.                                                                                   |

Keep production credentials out of Deploy Previews, the account preflight project, and public client assets. Use the narrow service-client scopes and keep the user identity in runtime configuration. [Dexie token scopes](https://dexie.org/docs/cloud/rest-api#token) · [Netlify function environment variables](https://docs.netlify.com/build/functions/environment-variables/)

## Verification and operation

1. On a separate maintenance project and disposable Dexie database, set `dry-run`, use synthetic notes, and run the Scheduled Function with **Run now**. Check an expired tree, a tree with a younger descendant, fresh Trash, and live notes. Compare the logged candidate count and verify that no rows changed.
2. In that disposable environment, set `purge` and verify the exact removed notes, retained descendants and live notes, synchronized view, and purge records. Repeat the run to check that it can catch up safely. The shared purge record makes the item disappear from the active view before the worker removes its stored source. If that removal fails, a later sweep finishes it while the epoch is current. The existing library projection reconciles stale order references and dangling restore pointers.
3. Configure one Cronitor heartbeat for the UTC schedule and an email notification list. A successful run sends a heartbeat after the sweep, including when zero notes were eligible. A caught failure sends a failure event. A missing heartbeat after the configured grace period also alerts. Verify success, a synthetic failure, and a missed heartbeat before enabling production purge. [Cronitor Heartbeat Monitoring](https://cronitor.io/docs/heartbeat-monitoring)
4. Before enabling production purge, publish with `dry-run` and confirm the intended account and database in the private configuration. Use **Run now** to check the candidate count against the expected Trash. Then enable `purge` in the production settings and republish.
5. Use **Cloud compute → Functions** to read the outcome and aggregate counts. A run handles up to 25 notes, and the next daily invocation can resume a backlog. After fixing a failure, **Run now** can retry the same day. To pause deletion while keeping the heartbeat, publish in `dry-run` mode. When publishing in `disabled` mode, pause the heartbeat monitor as well. [Netlify function logs](https://docs.netlify.com/build/functions/logs/)

The worker rechecks current placement, ancestors, and children before writing a purge record. An operation can still race that write. A committed purge record takes precedence over stale device copies, so restore important notes before they reach the cutoff.
