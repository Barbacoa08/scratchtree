#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
ulimit -c 0

if [[ $(id -u) != 0 || ! -f /run/.containerenv || $(stat -f -c %T /proof) != tmpfs ]]; then
  echo 'The signing proof requires the disposable root Podman container with /proof on tmpfs.' >&2
  exit 1
fi

shopt -s nullglob
releases=(/package/*.pkg.tar.zst)
upgrades=(/upgrade/*.pkg.tar.zst)
[[ ${#releases[@]} == 1 && ${#upgrades[@]} == 1 ]]
release=${releases[0]}
upgrade=${upgrades[0]}
base_version=$(pacman -Qp -- "$release")
[[ $base_version =~ ^(scratchtree-preview\ [0-9]+\.[0-9]+\.[0-9]+)-([1-9][0-9]*)$ ]]
base_revision=${BASH_REMATCH[2]}
upgrade_version="${BASH_REMATCH[1]}-$((base_revision + 1))"
[[ $(pacman -Qp -- "$upgrade") == "$upgrade_version" ]]

work=$(mktemp -d /proof/run.XXXXXX)
install -d -m 700 "$work/keyring" "$work/signer" "$work/cache"
install -d -o smoke -g smoke /home/smoke/evidence
config="$work/pacman.conf"

stage_repositories() (
  export GNUPGHOME="$work/signer" TMPDIR="$work"
  trap 'gpgconf --kill all' EXIT
  gpg --batch --pinentry-mode loopback --passphrase '' --quick-generate-key \
    'Scratchtree Arch CI <scratchtree-arch-ci@example.invalid>' ed25519 sign 1d
  fingerprint=$(gpg --batch --with-colons --list-keys | awk -F: '$1 == "fpr" { print $10 }')
  [[ $fingerprint =~ ^[[:xdigit:]]{40}$ ]]
  printf '%s\n' "$fingerprint" > "$work/fingerprint"
  gpg --batch --export "$fingerprint" > "$work/signer.gpg"
  bash /usr/local/bin/stage-signed-repo "$release" "$(sha256sum -- "$release" | cut -d ' ' -f 1)" \
    "$fingerprint" "$work/release"
  bash /usr/local/bin/stage-signed-repo "$upgrade" "$(sha256sum -- "$upgrade" | cut -d ' ' -f 1)" \
    "$fingerprint" "$work/upgrade"
)
stage_repositories
rm -rf -- "$work/signer"

configure_repo() {
  cat > "$config" <<EOF
[options]
Architecture = auto
CacheDir = $work/cache
GPGDir = $work/keyring
LogFile = $work/pacman.log
SigLevel = Required TrustedOnly
LocalFileSigLevel = Required TrustedOnly

[scratchtree]
Server = file://$1
EOF
}

strict_pacman() {
  pacman --config "$config" --noconfirm "$@"
}

expect_rejection() {
  local diagnosis=$1
  shift
  if strict_pacman "$@" > "$work/rejected.log" 2>&1; then
    cat "$work/rejected.log"
    echo 'pacman accepted a fixture that should have been rejected.' >&2
    return 1
  fi
  cat "$work/rejected.log"
  grep -Eq -- "$diagnosis" "$work/rejected.log"
}

assert_installed() {
  [[ $(pacman -Q scratchtree-preview) == "$1" ]]
  pacman -Qi scratchtree-preview | grep -E '^Validated By[[:space:]]*:.*[[:space:]]Signature[[:space:]]*$'
  pacman -Qkk scratchtree-preview
}

run_gui() {
  runuser --user smoke -- dbus-run-session -- \
    xvfb-run -a -s '-screen 0 1440x960x24' bash /usr/local/bin/arch-preview "$1"
}

# Remove the release package installed for the original smoke test before the
# strict signed transaction. Its runtime dependencies stay installed.
pacman -R --noconfirm scratchtree-preview
[[ ! -e /usr/bin/scratchtree-preview ]]
pacman_key=(pacman-key --gpgdir "$work/keyring")
"${pacman_key[@]}" --init
"${pacman_key[@]}" --add "$work/signer.gpg"
fingerprint=$(cat "$work/fingerprint")
imported_fingerprint=$(gpg --batch --homedir "$work/keyring" --with-colons --fingerprint "$fingerprint" |
  awk -F: '$1 == "fpr" { print $10 }')
[[ $imported_fingerprint == "$fingerprint" ]]

echo 'Checking that pacman requires a repository database signature.'
mkdir "$work/unsigned-db"
cp "$work/release/scratchtree.db" "$work/unsigned-db/"
configure_repo "$work/unsigned-db"
expect_rejection 'scratchtree\.db\.sig|missing (required|PGP) signature' -Syy

echo 'Checking that a repository signed by a known but untrusted key is rejected.'
configure_repo "$work/release"
expect_rejection 'signature from .* is unknown trust' -Syy
# Enroll the pinned signer with pacman's disposable local trust key.
"${pacman_key[@]}" --lsign-key "$fingerprint"

echo 'Checking that pacman rejects the original unsigned package bytes.'
[[ ! -e $release.sig ]]
expect_rejection 'missing required signature|missing PGP signature' -U "$release"
[[ ! -e /usr/bin/scratchtree-preview ]]

echo "Installing signed $base_version from the isolated repository."
strict_pacman -Syy
strict_pacman -Fyy
strict_pacman -S scratchtree-preview
assert_installed "$base_version"
run_gui before-upgrade

echo 'Checking that the base package signature cannot authenticate the upgrade.'
mkdir "$work/wrong-signature"
wrong="$work/wrong-signature/${upgrade##*/}"
cp "$upgrade" "$wrong"
cp "$work/release/${release##*/}.sig" "$wrong.sig"
expect_rejection 'signature from .* is invalid|invalid or corrupted package \(PGP signature\)' -U "$wrong"
assert_installed "$base_version"

echo "Upgrading to signed $upgrade_version from the isolated repository."
configure_repo "$work/upgrade"
strict_pacman -Syyu
assert_installed "$upgrade_version"
run_gui after-upgrade
echo 'Offline signed pacman installation, rejection checks, upgrade, and local workspace recovery passed.'
