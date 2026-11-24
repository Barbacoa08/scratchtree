# Arch Linux Preview

Scratchtree Preview targets current Arch Linux x86_64 for signed-out use with synthetic or disposable notes. It uses the Preview application identity, standard Linux window controls, and Ctrl for the app shortcuts described as Command in the Mac guide. Closing the window waits for the current save. If saving fails, the window stays open so you can retry or keep editing.

## Get the package

Download the [0.3.2 Arch Linux x86_64 Preview package](https://github.com/Barbacoa08/scratchtree/releases/download/v0.3.2/scratchtree-preview-0.3.2-1-x86_64.pkg.tar.zst) and [SHA256SUMS.txt](https://github.com/Barbacoa08/scratchtree/releases/download/v0.3.2/SHA256SUMS.txt) from the [same GitHub prerelease](https://github.com/Barbacoa08/scratchtree/releases/tag/v0.3.2). In the download directory on an up-to-date Arch x86_64 installation, verify the Arch entry and install the package.

```sh
package='scratchtree-preview-0.3.2-1-x86_64.pkg.tar.zst'
checksum=$(awk -v package="$package" '$2 == package { print }' SHA256SUMS.txt) &&
  test -n "$checksum" &&
  printf '%s\n' "$checksum" | sha256sum --check - &&
  sudo pacman -U "./$package"
```

Launch **Scratchtree Preview** from the application menu or run `scratchtree-preview`. Remove the package with `sudo pacman -R scratchtree-preview`. Package removal leaves the Preview’s user data on disk.

## Signed repository setup

Use this setup when Scratchtree publishes a signed repository and announces its HTTPS URL and full OpenPGP fingerprint. The current public Preview uses the manual package download above.

1. Download the Scratchtree public key from the official release instructions. Display its full fingerprint with `gpg --show-keys --with-fingerprint scratchtree-arch.asc` and compare it with the fingerprint in the announcement. Proceed only if the file contains the expected signing key and the full fingerprint matches.
2. Add the key with `sudo pacman-key --add scratchtree-arch.asc`. Trust the verified key with `sudo pacman-key --lsign-key <full-fingerprint>`, using the fingerprint you just checked. Pacman enrolls it in its shared trust store. [Pacman key management](https://man.archlinux.org/man/pacman-key.8.en)
3. Add the repository at the end of `/etc/pacman.conf`, substituting the announced server for the example URL. Keep the system-wide signature settings intact. [Pacman repository configuration](https://man.archlinux.org/man/pacman.conf.5.en)

```ini
[scratchtree]
SigLevel = Required TrustedOnly
Server = https://scratchtree.example.invalid/arch/$arch
```

Install with `sudo pacman -Syu scratchtree/scratchtree-preview`. After that, normal full system upgrades with `sudo pacman -Syu` can install newer Scratchtree packages. Pacman verifies the repository index and each package. If the signer changes, check the new full fingerprint in the official release instructions before trusting the replacement key. When Scratchtree announces that an old key is retired or compromised, remove the announced old fingerprint with `sudo pacman-key --delete <old-fingerprint>`. [Pacman upgrades](https://man.archlinux.org/man/pacman.8.en)

## What CI verifies

GitHub Actions builds Tauri’s Debian bundle on Ubuntu 24.04 with the locked project dependencies. An Arch build stage checks the Debian bundle’s SHA-256 and uses `makepkg` to wrap its binary, desktop entry, and icon with Arch runtime dependencies. A fresh Arch stage installs the package with pacman and checks its files and shared libraries before adding the test tools.

The runtime check uses Arch’s WebKitGTK under Xvfb and Openbox in an offline Podman container as an unprivileged user. It launches the installed desktop entry, saves and copies a synthetic Markdown note, edits it, closes the window, relaunches, and compares the exact source through the system clipboard. CI also checks package removal. The evidence artifact contains the source commit, runtime versions, logs, and a screenshot when the app reaches that step.

A separate offline container uses a disposable signing key and an isolated pacman keyring. It verifies a signed repository install, rejects a missing repository signature, an untrusted signer, an unsigned package, and a signature that belongs to different package bytes. It then upgrades to the next package revision and checks a saved note and an unfinished composer draft after reopening. Both revisions use the same Scratchtree binary, so upgrades between different app builds still require packaged acceptance.

For broader Arch desktop support beyond this experimental Preview, repeat installation and local use in a full Arch desktop VM using the same package. Check native Wayland and X11 where available, keyboard and pointer use, draft retention, backup file dialogs, and package upgrade with a retained Preview profile. The sign-in controls are present. Real-account sign-in and cross-device synchronization still require acceptance on Linux. The CI smoke covers a virtual X11 session. WebKitGTK may rely on container isolation when nested sandboxing is unavailable.
