# Mac preview releases

Scratchtree currently installs through an Apple Silicon DMG published as a GitHub prerelease. Releases are manual; there is no automatic updater. The 0.2.1 prerelease includes private-account Dexie Cloud synchronization; the retained alpha.5 installer uses local notes only. State the behavior of the exact installer being released, and do not infer publication authorization from source implementation. [README.md](../README.md#download-and-install) is the user-facing installation guide.

The alpha is ad-hoc signed, **not Developer ID signed or notarized**. Production signing, credentials, notarization, Intel builds, and other platforms require separate decisions. The permanent release identifier is `tech.barbajoe.scratchtree`; data is stored separately from the application bundle. Alpha changes may break identity or format compatibility, but using actual notes requires a deliberate private backup and transfer plan first.

## Scope and prerequisites

- Follow [CONTRIBUTING.md](../CONTRIBUTING.md), including independent reviews, verification, and source identity. Packaging is not a replacement for implementation acceptance.
- Confirm the current task authorizes publishing a release. Code approval, a merged PR, or a past release does not grant standing publication or credential access. If publication is already authorized, complete the verified release without asking again. An explicit request to publish a Scratchtree release also authorizes its required website handoff: update the public download links, review and merge the documentation/metadata PR, and verify the existing automatic Netlify deployment. Complete those steps in the same task without a separate website request or permission prompt. This does not authorize an unrequested release, new signing credentials, or unrelated account/service changes.
- Use the README's pinned Node, pnpm, and Rust versions, macOS command-line build prerequisites, the `aarch64-apple-darwin` Rust target, Python 3 for the checks below, and authenticated GitHub CLI access to `Barbacoa08/scratchtree`. Select the toolchains in the shell before running Tauri's child commands. Do not depend on another worktree's ignored toolchain/cache paths.
- Start from a clean, freshly fetched, verified release commit, normally merged `origin/main`, in an isolated worktree. Record commit/tree IDs, tool versions, architecture, commands, outcomes, and omissions in a dated ignored `.projects/` task folder.
- Never use an original third-party application profile or bundle personal notes, IndexedDB/SQLite profiles, backups, exports, private captures, credentials, or scratch directories. New installations start empty. Do not launch against an existing user profile merely to package the installer.

For a prose-only PR, documentation checks are sufficient and no new installer is needed. For a runtime release, verify the selected source under the contributor guide, and record the applicable packaged native checks and their limits. If a squash merge leaves the complete tracked tree identical to the tested PR head, retain both identities and the verified tree equality; do not imply a fresh test run occurred. Build the release afresh from the selected clean commit.

## Build and stage an immutable application

The shell examples assume the repository root and one continuing shell. Keep error checking enabled so a failed build cannot fall through to packaging a cached artifact. Choose an explicitly approved, unused release tag before running them; the example below uses `v0.2.0`. Never overwrite an existing tag or release asset. Check the actual release list first.

```sh
set -eu
gh release list --repo Barbacoa08/scratchtree
release_tag='v0.2.0' # Use the explicitly approved, unused version.
# Keep GitHub's prerelease flag while the application remains in alpha.

git fetch origin --prune
test -z "$(git status --porcelain)"
release_commit=$(git rev-parse HEAD)
test "$release_commit" = "$(git rev-parse origin/main)"
release_dir=$(mktemp -d "$PWD/.projects/$(date +%F)-mac-release-XXXXXX")
git rev-parse HEAD 'HEAD^{tree}' > "$release_dir/source-identity.txt"
node --version > "$release_dir/tool-versions.txt"
pnpm --version >> "$release_dir/tool-versions.txt"
rustc --version >> "$release_dir/tool-versions.txt"
cargo --version >> "$release_dir/tool-versions.txt"

pnpm install --frozen-lockfile
release_target_dir=$(python3 -c 'import os; from pathlib import Path; print(Path(os.environ.get("CARGO_TARGET_DIR", "src-tauri/target")).resolve())')
env -u TAURI_CONFIG -u APPLE_SIGNING_IDENTITY -u APPLE_CERTIFICATE \
  -u APPLE_CERTIFICATE_PASSWORD -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID \
  CARGO_TARGET_DIR="$release_target_dir" \
  pnpm exec tauri build --ci --no-sign --bundles app --target aarch64-apple-darwin \
  > "$release_dir/build-app.log" 2>&1

test -z "$(git status --porcelain)"
mkdir "$release_dir/staging" "$release_dir/assets"
release_app="$release_dir/staging/Scratchtree.app"
ditto "$release_target_dir/aarch64-apple-darwin/release/bundle/macos/Scratchtree.app" "$release_app"
codesign --force --sign - --timestamp=none \
  --identifier tech.barbajoe.scratchtree "$release_app"
codesign --verify --deep --strict --verbose=2 "$release_app"
codesign -dv --verbose=4 "$release_app" 2> "$release_dir/signature.txt"
ln -s /Applications "$release_dir/staging/Applications"
```

`--no-sign` builds without a signing identity; the subsequent `codesign --sign -` seals only the staged copy ad hoc. Do not change keychain, account, certificate, or notarization settings for this procedure. The checked-in `tauri:build` command makes the release app bundle, not a DMG or a published release. Ordinary `tauri:dev` and `tauri:preview` commands use the checked-in Preview override; disposable probes still require their own explicitly authorized identity.

Read `Contents/Info.plist` and confirm product name, bundle identifier, executable, and internal version against the selected source configuration. Run `lipo -archs` on that executable and require `arm64`. Record `vtool -show-build` output; do not claim an older macOS version is supported merely because the plist lists it. Record every staged bundle file's relative path and SHA-256, and inspect its complete contents, including symlinks, against the expected application resources. Never copy a running app's data directory into staging. The staging root must contain only the application and the `/Applications` symlink.

Release tag and internal application version are different identities: alpha.1 and alpha.2 used internal version `0.1.0`. Read and disclose the actual values rather than silently changing source while packaging. A version/configuration change belongs in a reviewed source change before the release build.

## Native Keychain access

WebKit protects persisted WebCrypto keys with an application-bound Keychain master key. A separate database or webview store does not isolate that key from other executables using the same application identity. Keep disposable probes out of both the release identity and ordinary Preview identity (`tech.barbajoe.scratchtree.preview`); a different probe identity needs explicit authorization. Never delete a master key or reset Keychain to make a build appear to pass.

Record the packaged build's designated requirement with `codesign -d -r-`. Ad-hoc builds can have different requirements after rebuilding, so a valid seal does not establish continued access to existing keys. Native OTP, key persistence, and relaunch checks remain separate release gates. Stable signing credentials and notarization still require their own authorization. [Apple code-signing guidance](https://developer.apple.com/library/archive/technotes/tn2206/) explains identity tracking.

If macOS requests Keychain access, identify the exact requesting build and item before advising the user. **Allow** authorizes an access; **Always Allow** adds that app to the relevant operation's trusted list and persists beyond one sign-in. It does not authorize every app. Never request the user's password through chat or promise an exact prompt count. Stop if the same request repeats after a persistent grant, or the requester or item differs from the verified one; investigate without removing protection. See [Apple's access-control documentation](https://developer.apple.com/documentation/security/access-control-lists).

## Package and inspect the DMG

```sh
release_label=${release_tag#v}
release_name="Scratchtree_${release_label}_aarch64.dmg"
release_dmg="$release_dir/assets/$release_name"
test ! -e "$release_dmg"
hdiutil create -volname 'Scratchtree' -fs HFS+ \
  -srcfolder "$release_dir/staging" -format UDZO -imagekey zlib-level=9 \
  "$release_dmg" > "$release_dir/create-dmg.log" 2>&1
hdiutil verify "$release_dmg" > "$release_dir/verify-dmg.log" 2>&1

release_mount="$release_dir/verify-mount"
mkdir "$release_mount"
release_mounted=false
release_cleanup() {
  if [ "$release_mounted" = true ]; then
    hdiutil detach "$release_mount" || return 1
    release_mounted=false
  fi
  if [ -d "$release_mount" ]; then rmdir "$release_mount"; fi
}
trap 'release_cleanup' EXIT
trap 'exit 1' HUP INT TERM
hdiutil attach -readonly -noautoopen -nobrowse \
  -mountpoint "$release_mount" -plist "$release_dmg" \
  > "$release_dir/attach-result.plist"
release_mounted=true
```

The trap detaches the successfully attached image if a later check exits or is interrupted. Keep it active through inspection; equivalent verification scripts must use a cleanup/finally guard. If detachment fails, stop, retain the mount context, and resolve it without forcing unmounts. Check the returned mount point before reading it. Verify all of the following before upload:

1. The volume contains only the expected app, Applications shortcut, and ordinary filesystem metadata. The shortcut is a symlink to `/Applications`.
2. The mounted app's complete file/symlink inventory matches staging, and all file hashes equal the recorded signed manifest. Check identifier, internal version, executable, and arm64 architecture again on the mounted app.
3. `codesign --verify --deep --strict` succeeds on the mounted application. Signature integrity establishes an intact ad-hoc seal; it does not establish Developer ID trust or notarization.
4. There are no bundled notes, profiles, databases, exports, backups, credentials, or unrelated artifacts.
5. The image is detached successfully. Never leave a failed verification mount behind or upload after a failed check.

```sh
codesign --verify --deep --strict "$release_mount/Scratchtree.app"
release_cleanup
trap - EXIT HUP INT TERM
(cd "$release_dir/assets" && shasum -a 256 "$release_name" > SHA256SUMS.txt)
```

`hdiutil` may print deprecation notices on newer macOS versions. This is the verified packaging procedure used for the current alpha; record actual tool behavior and validate an alternative before changing the process.

## Release notes, upload, and publication

Write release notes inside the task folder. Include changes, exact source identity, actual verification/omissions, tested platform and account/synchronization limits, internal version, signing status, and installation instructions. Record the current BackupV8 contract and application identity. Earlier profiles and exports are not opened or migrated automatically. Before moving from the last pre-sync alpha.5, preserve an unchanged private BackupV7 and working recovery installer, use the separate local-only converter, validate its BackupV8 output, import it, and verify a fresh export. Keep each Mac’s distinct export until its intended data is verified. Do not bundle the converter, old reader, or actual exports in the product. Restore **replaces** the destination library and, while signed in, the shared library on every Mac. Drafts and Undo import only on that device; older offline work remains recoverable. Test native account/code persistence, offline reopen, sign-out/no-transport restart, two-client convergence, rejected-input recovery, and converted backup round trip before claiming those release features. Historical public alpha releases may be removed only under applicable task authorization and after a working recovery path exists.

For an ad-hoc release, install the app in Applications, try opening it, click **Done** on the warning, then open **System Settings → Privacy & Security → Security** and click **Open Anyway**. Authenticate if prompted and confirm **Open**. Proceed only if you trust the download. Link [Apple's per-app opening instructions](https://support.apple.com/en-us/102445) and note that managed Macs may restrict opening. Do not prescribe disabling system-wide protections or removing quarantine attributes.

Create a draft first so uploaded files can be checked before public publication:

```sh
gh release create "$release_tag" "$release_dmg" "$release_dir/assets/SHA256SUMS.txt" \
  --repo Barbacoa08/scratchtree --draft --prerelease --target "$release_commit" \
  --title "Scratchtree $release_label — Apple Silicon" \
  --notes-file "$release_dir/release-notes.md"
gh api 'repos/Barbacoa08/scratchtree/releases?per_page=100' \
  > "$release_dir/draft-releases.json"
gh release download "$release_tag" --repo Barbacoa08/scratchtree \
  --dir "$release_dir/download-check" --pattern '*.dmg' --pattern SHA256SUMS.txt
cmp "$release_dmg" "$release_dir/download-check/$release_name"
cmp "$release_dir/assets/SHA256SUMS.txt" "$release_dir/download-check/SHA256SUMS.txt"
```

Before publishing, select the exact tag from the returned metadata and verify draft/prerelease flags, full target commit, exact asset names, uploaded state, byte counts, and asset digests against the local files. Both downloaded assets must be byte-identical. Do not mark those checks complete in release notes until they have actually passed. On failure, keep the release as a draft, preserve evidence, and resolve the issue before proceeding. Use the connected GitHub tools when they support the operation; the CLI supplies release mutations and binary transfers when the connector cannot.

When these checks pass and publication is authorized:

```sh
gh release edit "$release_tag" --repo Barbacoa08/scratchtree \
  --draft=false --prerelease --latest=false
gh api "repos/Barbacoa08/scratchtree/releases/tags/$release_tag" \
  > "$release_dir/published-release.json"
git ls-remote --tags origin "refs/tags/$release_tag" \
  > "$release_dir/published-tag.txt"
curl --fail --location --silent --show-error \
  --output "$release_dir/public-download.dmg" \
  "https://github.com/Barbacoa08/scratchtree/releases/download/$release_tag/$release_name"
cmp "$release_dmg" "$release_dir/public-download.dmg"
```

Confirm public metadata says `draft: false`, `prerelease: true`, and the expected target/assets; the published tag must resolve to the exact release commit. The unauthenticated public download must match the local SHA-256 and byte count. Preserve the release URL, artifact identities, verification output, and any omissions locally. If post-publication checks fail, report the failure and assess the next action under the current authorization; do not silently replace immutable assets or repoint tags.

## Website links and automatic deployment (required)

A release is not complete when the GitHub assets alone are published. The release task includes the website handoff below; do not leave it for the user to request separately.

1. **Update links after publication is verified.** Update the root README's installation and release-notes links, plus `website/release.json` (`version`, `downloadUrl`, and `releaseUrl`), to the exact published tag and DMG. Keep `testedOn` tied to observed platform evidence, and update other current-version guidance where necessary while preserving historical facts. Use exact tag/asset URLs; prereleases are not reliably addressed by `releases/latest`.
2. **Review, check, and merge the metadata update.** Follow [CONTRIBUTING.md](../CONTRIBUTING.md): use a fresh task branch from current main, one independent documentation review, formatting and local-link checks, and `pnpm build:site`. Confirm the generated page has the intended version and links, then merge the reviewed PR into `main` as part of the authorized release. Record its merged commit separately from the immutable application release commit. A documentation-only follow-up does not require rebuilding or replacing the published app, DMG, or tag.
3. **Wait for the automatic production deployment.** The existing `scratchtree` Netlify project is linked to `Barbacoa08/scratchtree` through the Netlify GitHub App. Confirm builds are active on production branch `main`, with the checked-in `netlify.toml` using `pnpm build:site`, `website/dist`, and `netlify/functions`. After the merge, wait for the Git-triggered production deploy to finish, and verify that its source commit matches the merged metadata commit and that it is the currently published deploy. A deploy preview, an older successful deploy, or a manual CLI upload does not establish this automatic merge-to-production path. A routine release should not need a manual upload.
4. **Verify the public result and actual download.** Fetch both [scratchtree.barbajoe.tech](https://scratchtree.barbajoe.tech/) and [scratchtree.netlify.app](https://scratchtree.netlify.app/). Check that the pages show the intended release, their download and release-notes links match the published assets, and the static asset hashes match the reviewed local site build. Follow the download link extracted from the live page, require a successful unauthenticated download, and compare the downloaded DMG's byte count and SHA-256 with the verified release artifact and published `SHA256SUMS.txt`. Preserve the existing account-check function and private server settings; check native-origin preflight and a synthetic unknown-account response without reading or transmitting private allow-list entries or sending an OTP. Separate real-account acceptance remains subject to its existing authorization and evidence requirements.
5. **Record completion or resolve the failure.** Record the release URL, metadata PR/merged commit, Netlify deploy ID/source commit, public page/link results, and download checksum in the task evidence and final handoff. Do not report the full release complete until the GitHub publication, merged links, automatic production deployment, and live download checks all pass. If the automatic deployment fails or the page stays stale, inspect the build, repository connection, and published commit, and resolve the existing pipeline within the authorized scope. If a required permission or external blocker prevents completion, report the exact unfinished gate. Keep immutable release assets and tags unchanged while diagnosing website failures.

Never advertise synchronization, automatic updates, notarization, or wider platform support that the released build does not provide.
