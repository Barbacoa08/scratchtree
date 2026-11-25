#!/usr/bin/env bash
set -euo pipefail

phase=${1:-smoke}
evidence="$HOME/evidence"
case "$phase" in
  smoke) ;;
  before-upgrade|after-upgrade) evidence="$evidence/$phase" ;;
  *) echo "Unknown Arch smoke phase: $phase" >&2; exit 1 ;;
esac
mkdir -p "$evidence"
exec > >(tee "$evidence/smoke.log") 2>&1
export GDK_BACKEND=x11
export XDG_RUNTIME_DIR="$HOME/runtime"
install -d -m 700 "$XDG_RUNTIME_DIR"
openbox &
wm_pid=$!
cleanup() {
  if [[ ! -f "$evidence/arch-preview.png" ]]; then
    timeout 5 magick import -window root "$evidence/arch-preview.png" || true
  fi
  kill "$wm_pid" 2>/dev/null || true
}
trap cleanup EXIT

command -v cmp
pacman -Q scratchtree-preview gtk3 webkit2gtk-4.1
desktop='/usr/share/applications/Scratchtree Preview.desktop'
desktop-file-validate "$desktop"
pacman -Qoq "$desktop" /usr/bin/scratchtree-preview
find /usr/share/icons/hicolor -name scratchtree-preview.png -print | grep .
[[ $(uname -m) == x86_64 ]]

wait_for_window() {
  timeout 30 xdotool search --sync --onlyvisible --name '^Scratchtree$' |
    sed -n '1p'
}

copy_matches() {
  local expected=$1
  shift
  printf %s 'clipboard sentinel' | xclip -selection clipboard -in
  xdotool key "$@"
  timeout 2 xclip -selection clipboard -out > "$HOME/clipboard" 2>/dev/null &&
    printf %s "$expected" | cmp -s - "$HOME/clipboard"
}

expect_note() {
  local expected=$1
  xdotool key Escape
  for ((attempt = 0; attempt < 40; attempt++)); do
    if copy_matches "$expected" Down c; then return 0; fi
    sleep 0.25
  done
  echo 'Could not copy the expected saved Markdown.'
  return 1
}

close_window() {
  local window=$1 pid state
  pid=$(xdotool getwindowpid "$window")
  xdotool key alt+F4
  for ((attempt = 0; attempt < 40; attempt++)); do
    state=$(ps -o stat= -p "$pid" || true)
    if [[ -z $state || $state == Z* ]]; then return 0; fi
    sleep 0.25
  done
  echo 'Scratchtree did not close after saving.'
  return 1
}

heading='**Arch Preview** smoke test'
line='A second line of Markdown.'
note=$(printf '%s\n%s' "$heading" "$line")
draft_heading='**Arch Preview** unfinished draft'
draft_line='Draft stays in the composer.'
draft=$(printf '%s\n%s' "$draft_heading" "$draft_line")
launch_app() {
  gio launch "$desktop" >"$evidence/$1" 2>&1
  window=$(wait_for_window)
  xdotool windowactivate --sync "$window"
}

expect_draft() {
  for ((attempt = 0; attempt < 40; attempt++)); do
    if copy_matches "$draft" ctrl+a ctrl+c; then return 0; fi
    sleep 0.25
  done
  echo 'Could not copy the expected unfinished Markdown from the composer.'
  return 1
}

if [[ $phase == after-upgrade ]]; then
  echo 'Relaunching after the signed package upgrade.'
  launch_app app-reopen.log
  expect_note "$note reopened"
  xdotool key space
  expect_draft
  magick import -window root "$evidence/arch-preview.png"
  close_window "$window"
  echo 'Saved Markdown and unfinished composer draft both survived the upgrade.'
  exit
fi

echo 'Launching the installed desktop entry.'
launch_app app-first.log
first_pid=$(xdotool getwindowpid "$window")

echo 'Waiting for native WebKitGTK input and capturing a synthetic note.'
ready=false
for ((attempt = 0; attempt < 40; attempt++)); do
  xdotool key ctrl+n ctrl+a
  xdotool type --clearmodifiers "$heading"
  xdotool key shift+Return
  xdotool type --clearmodifiers "$line"
  if copy_matches "$note" ctrl+a ctrl+c; then
    ready=true
    break
  fi
  sleep 0.25
done
[[ $ready == true ]]
xdotool key End Return
expect_note "$note"

echo 'Editing the saved Markdown.'
xdotool key e
ready=false
for ((attempt = 0; attempt < 40; attempt++)); do
  if copy_matches "$note" ctrl+a ctrl+c; then
    ready=true
    break
  fi
  sleep 0.25
done
[[ $ready == true ]]
xdotool key ctrl+End
xdotool type --clearmodifiers ' reopened'
if [[ $phase == before-upgrade ]]; then
  xdotool key Return
  expect_note "$note reopened"
  echo 'Leaving separate unfinished Markdown in the composer before closing.'
  xdotool key --delay 150 space
  xdotool type --clearmodifiers "$draft_heading"
  xdotool key shift+Return
  xdotool type --clearmodifiers "$draft_line"
  expect_draft
  xdotool key End
  magick import -window root "$evidence/arch-preview.png"
  close_window "$window"
  exit
fi

echo 'Closing with the window manager to flush the inline edit.'
close_window "$window"

echo 'Relaunching and verifying exact Markdown through the native clipboard.'
launch_app app-reopen.log
[[ $(xdotool getwindowpid "$window") != "$first_pid" ]]
expect_note "$note reopened"
magick import -window root "$evidence/arch-preview.png"
close_window "$window"
echo 'Arch package, desktop launch, save, edit, close, and reopen passed.'
