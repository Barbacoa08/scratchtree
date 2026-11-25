# Open discussions

These are product decisions for future discussion, not authorization to implement them. The accepted foundation remains local-first Markdown editing with visible syntax, SvelteKit, Svelte, CodeMirror, Tauri, Dexie persistent IndexedDB, and Dexie Cloud. Current behavior and technical contracts live in [README.md](README.md) and [AGENTS.md](AGENTS.md). Technical defects and evidence limits should be tracked separately from these product choices.

When a topic becomes actionable, link its individual GitHub issue here. Record a decision in the appropriate current guidance and mark the topic resolved instead of duplicating accepted policy indefinitely.

## Branding, terminology, and identity

**Scratchtree** is the accepted name, with “Fast Markdown notes, organized into note trees” as its description. Use note, note tree / tree, parent, sibling, and child note. Root is the top navigation destination. Library refers to all stored data; use notes, Root, or editor in their specific contexts. The [branding record](docs/branding/README.md) preserves the terminology and selected icon family.

Release builds use the permanent identity `tech.barbajoe.scratchtree`; ordinary Preview and explicitly authorized disposable identities stay separate. Current-only storage/backup contracts remain. Alpha compatibility is not promised; actual notes still need a deliberate private backup and transfer. Historical alpha releases can be removed once the new package and private recovery path are verified. The application now offers System, Light, and Dark appearance, with a device-local preference separate from notes and backups. Platform icon containers and future icon/style refinements remain open, including alternate icon treatments for each appearance.

## Styling experiment

The desktop interface uses locally authored CSS; no desktop styling library is selected. The separate landing page uses `@barbajoe/css-lib`. Compare it with an experiment using `@barbajoe/css-lib`, including interaction fidelity and maintenance costs, before deciding whether adoption helps.

## Cross-parent movement

M uses a staged destination dialog for moving selected siblings together within or between the live library and Trash. An acknowledged move between locations shows the note count and destination in a five-second corner toast with a Go to tree action. Details retains the last move. A live-to-Trash move is one action in the session Undo and Redo history. Dragging and Command-Up/Down rearrange siblings. Decide whether dragging should also move items between parents, and discuss cross-owner selection separately.

## Keyboard selection and batch actions

Shift-click selects from the original anchor, and Command-click toggles membership. Shift+Up/Down grows the selection at its corresponding edge. X and Command+Backspace act on the selected group. One Undo reverses a recoverable group deletion. Editing, assigning color, and the card action buttons retain one primary target. C and Copy Markdown copy selected visible notes together in displayed order, preserving their source and adding one newline between notes. Current selection conventions draw on [Apple’s selection guidance](https://support.apple.com/guide/mac-help/select-items-mchlp1378/mac) and [WAI-ARIA guidance distinguishing focus and selection](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/#kbd_focus_vs_selection). Interactive note cards retain their content/button semantics rather than becoming listbox options.

## Tabs

Root, Search, and the first eight visible direct-child trees have keyboard navigation hints. Command-1 opens Root, and Command-2–9 opens those trees in sidebar order. Tabs remain deferred; decide whether they improve navigation and what their state should be.

## Pinning

The sidebar shows live trees except completed trees and their descendants, and no pin control is offered. Decide whether pinning has a useful purpose and, if so, its behavior and presentation.

## Dedicated to-dos

Completion is item metadata toggled with X, not a separate task system. Decide whether a dedicated to-do view is useful and how it relates to existing items and completion.

## Custom colors

The current picker offers nine fixed colors and Reset. Decide whether arbitrary colors are useful and how they would fit the storage contract and accessible picker.

## Trash purge

Manual Delete inside Trash permanently removes the selected item and its children, without Undo. Automatic permanent cleanup is not enabled. Decide any future 90-day cleanup schedule, retention exceptions, and recovery behavior separately; existing backups are not securely erased by logical item deletion.

## Accounts and synchronization

**Accepted:** Dexie Cloud, one personal library across Macs, local-first access, and existing-account email/code sign-in. The initial private alpha has no public sign-up; a server-side allowed-email check precedes OTP, and Dexie enforces account access. Sign-out retains local notes and stops transport. Submitted notes, tree structure/order, colors, completion, and Trash sync; drafts, workspace Undo and Redo, editor history, preferences, and recovery stay on each Mac. Restore replaces the shared library, and older offline edits are recovered rather than automatically added back. Current-server synchronization is sufficient. Version history remains deferred. On first sign-in with existing notes on both sides, merge distinct notes after confirmation and keep the most recently saved version of a note present in both libraries.

Current source replaces native SQLite with persistent Dexie behind Repository and uses current-only BackupV8. Previous release backups use a separate local conversion/transfer procedure, not an app migration ladder. The 0.2.7 Apple Silicon prerelease includes private existing-account synchronization; the retained alpha.5 installer is local-only. Source implementation, managed/browser proofs, packaged native acceptance, actual-note transfer, and publication are separate gates.

Still to discuss: public registration/invitations and multi-user access, account management beyond this private alpha, historical/versioned backup, and any future sharing. Mobile sync follows the same library once phone scope and platform acceptance are decided. The right pane uses concise current-library status with expanded confirmation/recovery details; connectivity alone does not imply success.

## Native sign-in and status wording

Keep the normal sign-in flow to email and code. Explain any necessary macOS authorization for the app's protected device sign-in key before the system prompt, and use recognizable app naming. Preserve existing keys and their access controls; changing a confusing label must not reset authentication material. When opening a saved Mac session, the startup screen names the Keychain item before access and keeps waiting for that attempt to settle. If opening succeeds, the editor opens automatically. After a failed open, Try again starts a fresh attempt, and the separate local notes option is visible below a divider with its effect on future launches explained. A separately identified native first-run build completed user-verified email/code sign-in and same-build reopening without Keychain prompts. That result does not establish trust across rebuilt ad-hoc updates or repair the earlier Preview key. The accepted friendly system-item name is **Scratchtree sign-in key**. Its native implementation remains under investigation: changing the displayed name must preserve the existing key, trusted applications, allowed operations, and other access settings. The in-app explanation describes that item-scoped purpose without implying access to the entire Keychain. Stable signing and any separate test identity remain separately authorized decisions.

The right panel uses **Status**, covering local saves and cloud synchronization without implying versioned backups. Its signed-out explanation identifies notes and drafts on this Mac; its signed-in explanation covers local saves and cloud sync. Keep the panel compact.

## Arch Linux distribution

Scratchtree 0.2.7 was the first GitHub prerelease with an experimental Arch Linux x86_64 pacman package. Each release includes that platform alongside the Apple Silicon DMG, and the landing page links to both installers. Its accepted scope is signed-out local use, with the native X11 smoke and download procedure documented in the [Arch Preview guide](docs/ARCH-PREVIEW.md). AUR, AppImage, and broader desktop acceptance remain open.

## Mobile companions

Mac comes first. Future iOS and Android companions are intended primarily for viewing, copy/paste, and short Markdown capture. Tauri is preferred, with Capacitor as a fallback if mobile friction warrants it. Decide the mobile scope and validate platform/editor constraints separately.

## Developer ID signing and notarization

**Accepted.** Use local Developer ID signing with Keychain-held credentials, Apple notarization, and a stapled ticket for the direct-download Apple Silicon DMG. Each new package goes through the [release guide](docs/RELEASING.md). Version 0.2.8 is the first public Developer ID-signed and notarized Mac download. The maintainer verified clean installation and exercised the upgrade from the public ad-hoc 0.2.8 build in a signed-in smoke test. Track the transition in [issue #6](https://github.com/Barbacoa08/scratchtree/issues/6).

## Desktop updates

**Accepted.** Show **Update available** near the bottom of the left panel, above the account action, with the offered version and a full-width button. A configured desktop build checks when the workspace opens. Installation requires an explicit choice and a successful save. Direct-download Mac builds use a signed updater archive and preserve the DMG as a manual and recovery path. Arch Preview hands off to pacman and keeps the manual package download. Public feeds depend on private packaged acceptance. The Arch repository and its signing setup have a separate public rollout. The browser editor's existing **Check for updates** action has its own [deployment workflow](docs/RELEASING.md#web-editor-deployment).

The first updater-enabled Mac release is 0.3.2. Install its notarized DMG once to receive future offers. The initial feed points to 0.3.2, and the first live in-app upgrade remains to be verified when a newer release is published to the feed. [Release guide](docs/RELEASING.md#desktop-update-candidates)

## Arch package signatures

**Accepted.** Use a dedicated OpenPGP key and a pacman repository with signed packages and indexes. Provide a one-time fingerprint check and repository setup. Keep release signing private keys outside Git, CI, and release assets. Prove trusted installation, rejection paths, and saved notes and drafts across a package upgrade with disposable keys and profiles. The signed repository is hosted as a standalone Netlify project. Pacman can update the Preview after one-time key and repository setup. Enabling the Arch in-app update feed remains a separate decision. [Arch setup](docs/ARCH-PREVIEW.md#signed-repository-setup) · [Signing workflow](docs/RELEASING.md#stage-a-signed-arch-repository-snapshot)

## Mac App Store distribution

**Planned for later.** Continue direct distribution through GitHub and the website for the current release path. Evaluate App Store signing and review requirements, sandbox compatibility, and how users would move notes or reconnect synced accounts when the store edition is in scope.

## Other repository decision

No public license has been selected. Choose one separately before representing the project as licensed for reuse.
