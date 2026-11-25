#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
ulimit -c 0

if [[ $(id -u) != 0 || ! -f /run/.containerenv || $(stat -f -c %T /proof) != tmpfs ]]; then
  echo 'Use the disposable root Podman container with /proof on tmpfs.' >&2
  exit 1
fi
install -d -o smoke -g smoke /home/smoke/evidence
mode=${1:-}
origin=${2:-}
signer=${3:-}
if ! [[ $# == 3 && $mode =~ ^(clean|upgrade)$ &&
  $origin =~ ^https://([a-f0-9]{24}--)?scratchtree-arch[.]netlify[.]app$ &&
  $signer =~ ^([A-F0-9]{40}|[A-F0-9]{64})$ ]]; then
  echo 'Supply clean or upgrade, the Scratchtree Netlify origin, and its signer fingerprint.' >&2
  exit 2
fi

shopt -s nullglob
older_packages=(/package/*.pkg.tar.zst)
newer_packages=(/upgrade/*.pkg.tar.zst)
[[ ${#older_packages[@]} == 1 && ${#newer_packages[@]} == 1 ]]
older=${older_packages[0]}
newer=${newer_packages[0]}
older_version=$(pacman -Qp -- "$older")
newer_version=$(pacman -Qp -- "$newer")
[[ $older_version == 'scratchtree-preview '* && $newer_version == 'scratchtree-preview '* ]]
[[ $(vercmp "${newer_version#* }" "${older_version#* }") == 1 ]]
if pacman -Q scratchtree-preview; then
  echo 'The live repository proof must start without Scratchtree installed.' >&2
  exit 1
fi

work=$(mktemp -d /proof/live.XXXXXX)
install -d -m 700 "$work/keyring" "$work/signer"
cache=/var/cache/pacman/pkg
fetch() {
  curl --proto '=https' --fail --silent --show-error --max-time 60 "$1" --output "$2"
}
fetch "$origin/scratchtree-arch.asc" "$work/signer.asc"
gpg --batch --homedir "$work/signer" --import "$work/signer.asc"
imported=$(gpg --batch --homedir "$work/signer" --with-colons --list-keys | awk -F: '
  $1 == "pub" { count++; primary = 1 }
  $1 == "fpr" && primary { fingerprint = $10; primary = 0 }
  END { if (count != 1) exit 1; print fingerprint }
')
[[ $imported == "$signer" ]]
gpg --batch --homedir "$work/signer" --export "$signer" > "$work/signer.gpg"
gpgconf --homedir "$work/signer" --kill all

server="$origin/arch/x86_64"
for index in scratchtree.db scratchtree.files; do
  fetch "$server/$index" "$work/$index"
  fetch "$server/$index.sig" "$work/$index.sig"
  gpgv --homedir "$work/signer" --keyring "$work/signer.gpg" "$work/$index.sig" "$work/$index"
done
package_name=${newer##*/}
[[ ! -e $cache/$package_name && ! -e $cache/$package_name.sig ]]
fetch "$server/$package_name" "$work/$package_name"
fetch "$server/$package_name.sig" "$work/$package_name.sig"
cmp "$newer" "$work/$package_name"
gpgv --homedir "$work/signer" --keyring "$work/signer.gpg" "$work/$package_name.sig" "$work/$package_name"

pacman_key=(pacman-key --gpgdir "$work/keyring")
"${pacman_key[@]}" --init
"${pacman_key[@]}" --populate archlinux
"${pacman_key[@]}" --add "$work/signer.asc"
"${pacman_key[@]}" --lsign-key "$signer"

# Keep the normal Arch repositories and signature settings.
config="$work/pacman.conf"
cat /etc/pacman.conf > "$config"
cat >> "$config" <<EOF_CONFIG

[scratchtree]
SigLevel = Required TrustedOnly
Server = $server
EOF_CONFIG
pacman_test=(pacman --config "$config" --gpgdir "$work/keyring" --cachedir "$cache" --noconfirm)

run_gui() {
  runuser --user smoke -- dbus-run-session -- \
    xvfb-run -a -s '-screen 0 1440x960x24' bash /usr/local/bin/arch-preview "$@"
}

echo "Verifying $mode from $server with signer $signer."
if [[ $mode == upgrade ]]; then
  # Seed the profile through the documented manual install of the checksum-verified baseline.
  "${pacman_test[@]}" -U -- "$older"
  [[ $(pacman -Q scratchtree-preview) == "$older_version" ]]
  run_gui before-upgrade
  "${pacman_test[@]}" -Syu
else
  "${pacman_test[@]}" -Syu scratchtree/scratchtree-preview
fi

[[ $(pacman -Q scratchtree-preview) == "$newer_version" ]]
pacman -Qi scratchtree-preview | grep -E '^Validated By[[:space:]]*:.*[[:space:]]Signature[[:space:]]*$'
pacman -Qkk scratchtree-preview
database=/var/lib/pacman/sync/scratchtree.db
cmp "$work/scratchtree.db" "$database"
bsdtar -xOf "$database" "scratchtree-preview-${newer_version#* }/desc" |
  awk '/^%PGPSIG%$/ { if (getline == 1) print }' |
  base64 --decode | cmp - "$work/$package_name.sig"
cmp "$newer" "$cache/$package_name"
sha256sum "$cache/$package_name"
if [[ $mode == upgrade ]]; then
  run_gui after-upgrade
else
  run_gui
fi
echo "Live $mode passed for $newer_version."
