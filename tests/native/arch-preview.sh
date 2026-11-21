#!/usr/bin/env bash
set -euo pipefail

mkdir -p "$HOME/evidence"
exec > >(tee "$HOME/evidence/smoke.log") 2>&1
export GDK_BACKEND=x11
export XDG_RUNTIME_DIR="$HOME/runtime"
install -d -m 700 "$XDG_RUNTIME_DIR"
openbox &
wm_pid=$!
cleanup() {
  if [[ ! -f "$HOME/evidence/arch-preview.png" ]]; then
    timeout 5 magick import -window root "$HOME/evidence/arch-preview.png" || true
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
echo 'Launching the installed desktop entry offline.'
gio launch "$desktop" >"$HOME/evidence/app-first.log" 2>&1
window=$(wait_for_window)
first_pid=$(xdotool getwindowpid "$window")
xdotool windowactivate --sync "$window"

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

echo 'Editing the saved note and closing with the window manager.'
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
close_window "$window"

echo 'Relaunching and verifying exact Markdown through the native clipboard.'
gio launch "$desktop" >"$HOME/evidence/app-reopen.log" 2>&1
window=$(wait_for_window)
[[ $(xdotool getwindowpid "$window") != "$first_pid" ]]
xdotool windowactivate --sync "$window"
expect_note "$note reopened"
magick import -window root "$HOME/evidence/arch-preview.png"
close_window "$window"
echo 'Arch package, offline desktop launch, save, edit, close, and reopen passed.'
