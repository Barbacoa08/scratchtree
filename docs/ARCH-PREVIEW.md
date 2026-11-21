# Arch Linux Preview

Scratchtree Preview targets current Arch Linux x86_64 for signed-out use with synthetic or disposable notes. It uses the Preview application identity, standard Linux window controls, and Ctrl for the app shortcuts described as Command in the Mac guide. Closing the window waits for the current save. If saving fails, the window stays open so you can retry or keep editing.

## Get the package

Open the [Arch Preview workflow](https://github.com/Barbacoa08/scratchtree/actions/workflows/arch-preview.yml) and select a successful run from the maintainer’s `main` branch or an explicitly trusted commit. Download its `scratchtree-preview-arch-x86_64-…` artifact. After extracting the artifact and checking `source-commit.txt`, run these commands on an up-to-date Arch x86_64 installation.

```sh
sha256sum --check SHA256SUMS.txt
sudo pacman -U ./scratchtree-preview-*.pkg.tar.zst
```

The source commit identifies the build and the checksum verifies the downloaded package bytes.

Launch **Scratchtree Preview** from the application menu or run `scratchtree-preview`. Remove the package with `sudo pacman -R scratchtree-preview`. Package removal leaves the Preview’s user data on disk.

## What CI verifies

GitHub Actions builds Tauri’s Debian bundle on Ubuntu 24.04 with the locked project dependencies. An Arch build stage checks the Debian bundle’s SHA-256 and uses `makepkg` to wrap its binary, desktop entry, and icon with Arch runtime dependencies. A fresh Arch stage installs the package with pacman and checks its files and shared libraries before adding the test tools.

The runtime check uses Arch’s WebKitGTK under Xvfb and Openbox in an offline Podman container as an unprivileged user. It launches the installed desktop entry, saves and copies a synthetic Markdown note, edits it, closes the window, relaunches, and compares the exact source through the system clipboard. CI also checks package removal. The evidence artifact contains the source commit, runtime versions, logs, and a screenshot when the app reaches that step.

Before wider distribution, repeat installation and local use in a full Arch desktop VM using the same CI artifact. Check native Wayland and X11 where available, keyboard and pointer use, draft retention, backup file dialogs, and package upgrade with a retained Preview profile. The sign-in controls are present. Real-account sign-in and cross-device synchronization still require acceptance on Linux. The CI smoke covers a virtual X11 session. WebKitGTK may rely on container isolation when nested sandboxing is unavailable.
