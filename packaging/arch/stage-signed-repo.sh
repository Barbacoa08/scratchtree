#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

if [[ $# != 4 ]]; then
  printf 'Usage: %s <package> <expected-sha256> <signer-fingerprint> <new-directory>\n' "$0" >&2
  exit 2
fi

[[ -f $1 ]] || fail 'The input package is missing.'
package=$(realpath -- "$1")
expected=$2
signer=$3
[[ $expected =~ ^[0-9a-f]{64}$ ]] || fail 'Supply the expected lowercase SHA-256 checksum.'
[[ $signer =~ ^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$ ]] ||
  fail 'Supply the full fingerprint of the dedicated signing key.'
[[ ${GNUPGHOME:-} == /* && -d $GNUPGHOME ]] ||
  fail 'Set GNUPGHOME to the absolute path of the signing keyring.'

output_parent=$(cd -- "$(dirname -- "$4")" && pwd -P)
snapshot_name=$(basename -- "$4")
[[ $snapshot_name != . && $snapshot_name != .. && $snapshot_name != / ]] ||
  fail 'Choose a new directory inside an existing parent.'
output="$output_parent/$snapshot_name"
[[ ! -e $output && ! -L $output ]] || fail 'The destination already exists.'

umask 077
stage=$(mktemp -d -- "$output_parent/.scratchtree-repo.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
mkdir -- "$stage/index" "$stage/snapshot"

package_name=$(basename -- "$package")
staged_package="$stage/snapshot/$package_name"
install -m 0644 -- "$package" "$staged_package"
checksum=$(sha256sum < "$staged_package")
[[ ${checksum%% *} == "$expected" ]] ||
  fail 'The package checksum differs from the approved artifact.'

# Validate identity after copying so the signed file is the same file we check.
package_version=$(
  bsdtar -xOf "$staged_package" .PKGINFO |
    awk '
      {
        key = $0
        sub(/^[[:space:]]+/, "", key)
        sub(/[[:space:]=].*$/, "", key)
        if (key != "pkgname" && key != "pkgver" && key != "arch") next
        prefix = key " = "
        if (index($0, prefix) != 1) malformed = 1
        count[key]++
        values[key] = substr($0, length(prefix) + 1)
      }
      END {
        version = values["pkgver"]
        if (malformed || count["pkgname"] != 1 || values["pkgname"] != "scratchtree-preview" ||
            count["pkgver"] != 1 || version !~ /^[0-9]+\.[0-9]+\.[0-9]+-[1-9][0-9]*$/ ||
            count["arch"] != 1 || values["arch"] != "x86_64") exit 1
        print version
      }'
) || fail 'The package metadata does not identify a Scratchtree Arch Preview release.'
[[ $package_name == "scratchtree-preview-$package_version-x86_64.pkg.tar.zst" ]] ||
  fail 'The package filename does not match its metadata.'

# Use an exported public key for an independent verification of every signature.
gpg --batch --no-options --export "$signer" > "$stage/signer.gpg"
[[ -s $stage/signer.gpg ]] || fail 'The signing key is missing from the selected keyring.'
gpg --batch --no-options --local-user "$signer" --output "$staged_package.sig"   --detach-sign -- "$staged_package"

repo-add --sign --key "$signer" --include-sigs   "$stage/index/scratchtree.db.tar.gz" "$staged_package"
for index in db files; do
  install -m 0644 -- "$stage/index/scratchtree.$index.tar.gz" "$stage/snapshot/scratchtree.$index"
  install -m 0644 -- "$stage/index/scratchtree.$index.tar.gz.sig" "$stage/snapshot/scratchtree.$index.sig"
done
for asset in "$staged_package" "$stage/snapshot/scratchtree.db" "$stage/snapshot/scratchtree.files"; do
  gpgv --homedir "$stage" --keyring "$stage/signer.gpg" "$asset.sig" "$asset"
done
chmod 0644 "$staged_package.sig"
chmod 0755 "$stage/snapshot"

# Staging and destination share a parent filesystem. Never replace another run's result.
mv -T --no-clobber -- "$stage/snapshot" "$output"
[[ ! -e $stage/snapshot ]] || fail 'The destination appeared while staging the repository.'
printf 'Verified signed repository snapshot: %s\n' "$output"
