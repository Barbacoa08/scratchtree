# Arch Linux Preview

Scratchtree Preview targets current Arch Linux x86_64 for signed-out use with synthetic or disposable notes. It uses the Preview application identity, standard Linux window controls, and Ctrl for the app shortcuts described as Command in the Mac guide. Closing the window waits for the current save. If saving fails, the window stays open so you can retry or keep editing.

## Get the package

Download the [0.3.4 Arch Linux x86_64 Preview package](https://github.com/Barbacoa08/scratchtree/releases/download/v0.3.4/scratchtree-preview-0.3.4-1-x86_64.pkg.tar.zst) and [SHA256SUMS.txt](https://github.com/Barbacoa08/scratchtree/releases/download/v0.3.4/SHA256SUMS.txt) from the [same GitHub prerelease](https://github.com/Barbacoa08/scratchtree/releases/tag/v0.3.4). In the download directory on an up-to-date Arch x86_64 installation, verify the Arch entry and install the package.

```sh
package='scratchtree-preview-0.3.4-1-x86_64.pkg.tar.zst'
checksum=$(awk -v package="$package" '$2 == package { print }' SHA256SUMS.txt) &&
  test -n "$checksum" &&
  printf '%s\n' "$checksum" | sha256sum --check - &&
  sudo pacman -U "./$package"
```

Launch **Scratchtree Preview** from the application menu or run `scratchtree-preview`. Remove the package with `sudo pacman -R scratchtree-preview`. Package removal leaves the Preview’s user data on disk.

## Signed repository setup

Add the signed Scratchtree repository once to receive updates through pacman. The repository uses the same package name as the manual download, so you can add it to an existing installation.

1. Download the [Scratchtree public key](https://scratchtree-arch.netlify.app/scratchtree-arch.asc) as `scratchtree-arch.asc`. Run `gpg --show-keys --fingerprint scratchtree-arch.asc` and check that it shows one key with the full fingerprint `85B619358B7EFAA0A056EDD32F22C381A2134675`.
2. Add the verified key and sign it locally in pacman's keyring. [Pacman key management](https://man.archlinux.org/man/pacman-key.8.en)

   ```sh
   sudo pacman-key --add scratchtree-arch.asc
   sudo pacman-key --lsign-key 85B619358B7EFAA0A056EDD32F22C381A2134675
   ```

3. Add this block at the end of `/etc/pacman.conf`. [Pacman repository configuration](https://man.archlinux.org/man/pacman.conf.5.en)

   ```ini
   [scratchtree]
   SigLevel = Required TrustedOnly
   Server = https://scratchtree-arch.netlify.app/arch/$arch
   ```

4. If you're installing Scratchtree for the first time, run `sudo pacman -Syu scratchtree/scratchtree-preview`. If Scratchtree is already installed, use `sudo pacman -Syu` as usual. Pacman verifies the index and package before installing or updating Scratchtree. [Pacman upgrades](https://man.archlinux.org/man/pacman.8.en)

If the signer changes, check the new full fingerprint in these official instructions before trusting the replacement key. When Scratchtree announces that an old key is retired or compromised, remove the announced old fingerprint with `sudo pacman-key --delete <old-fingerprint>`.

## What CI verifies

GitHub Actions builds Tauri’s Debian bundle on Ubuntu 24.04 with the locked project dependencies. An Arch build stage checks the Debian bundle’s SHA-256 and uses `makepkg` to wrap its binary, desktop entry, and icon with Arch runtime dependencies. A fresh Arch stage installs the package with pacman and checks its files and shared libraries before adding the test tools.

The runtime check uses Arch’s WebKitGTK under Xvfb and Openbox in an offline Podman container as an unprivileged user. It launches the installed desktop entry, saves and copies a synthetic Markdown note, edits it, closes the window, relaunches, and compares the exact source through the system clipboard. CI also checks package removal. The evidence artifact contains the source commit, runtime versions, logs, and a screenshot when the app reaches that step.

A separate offline container uses a disposable signing key and an isolated pacman keyring. It verifies a signed repository install, rejects a missing repository signature, an untrusted signer, an unsigned package, and a signature that belongs to different package bytes. It then upgrades to the next package revision and checks a saved note and an unfinished composer draft after reopening. Both revisions in the regular smoke job use the same Scratchtree binary.

To test actual release binaries, manually run the Arch Preview workflow with two releases that list their Arch packages in the shared `SHA256SUMS.txt`. This downloads the exact versioned packages from GitHub, verifies their published checksums, and uses the same disposable signing and pacman checks in a clean Arch container with both packages’ declared dependencies. The job uploads verification evidence only.

```sh
gh workflow run arch-preview.yml -f older_release=0.3.1 -f newer_release=0.3.2
```

This verifies the package upgrade and local note and draft retention. For each release, test the previous-to-new package pair. The [maintainer release checklist](RELEASING.md#verify-the-released-arch-upgrade) covers when to run this check and how to verify the signed HTTPS repository before and after publication.

The live repository check repeats a signed clean install and a system upgrade against the published HTTPS URL. It compares the package downloaded by pacman with the checksum-verified public release, and checks a saved note and draft after upgrading.

For broader Arch desktop support beyond this experimental Preview, repeat installation and local use in a full Arch desktop VM using the same package. Check native Wayland and X11 where available, keyboard and pointer use, draft retention, backup file dialogs, and package upgrade with a retained Preview profile. The sign-in controls are present. Real-account sign-in and cross-device synchronization still require acceptance on Linux. The CI smoke covers a virtual X11 session. WebKitGTK may rely on container isolation when nested sandboxing is unavailable.
