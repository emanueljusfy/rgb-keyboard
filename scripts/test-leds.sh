#!/usr/bin/env bash
# Manual smoke test for RGB keyboard sysfs.
set -euo pipefail

shopt -s nullglob
zones=(/sys/class/leds/rgb:kbd_backlight*)

if ((${#zones[@]} == 0)); then
  echo "No rgb:kbd_backlight sysfs entries."
  echo "Install the driver: sudo ./scripts/install-driver.sh"
  echo "If Secure Boot MOK is pending, reboot and enroll the key first."
  exit 1
fi

echo "Found ${#zones[@]} zone(s):"
printf '  %s\n' "${zones[@]}"

color="${1:-255 0 0}"
brightness="${2:-128}"

for z in "${zones[@]}"; do
  if [[ -f "$z/multi_intensity" ]]; then
    echo "$color" > "$z/multi_intensity"
    echo "wrote multi_intensity=$color -> $z"
  fi
  if [[ -f "$z/brightness" ]]; then
    echo "$brightness" > "$z/brightness"
    echo "wrote brightness=$brightness -> $z"
  fi
done

echo "Done. Usage: $0 'R G B' [brightness]"
