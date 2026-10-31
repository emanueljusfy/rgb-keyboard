#!/usr/bin/env bash
# Run after enrolling the Secure Boot MOK.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Loading modules..."
sudo modprobe tuxedo_compatibility_check
sudo modprobe tuxedo_keyboard
sudo modprobe clevo_wmi
sudo modprobe clevo_acpi || true

echo "Modules:"
lsmod | grep -E 'tuxedo|clevo' || true

echo "LEDs:"
ls -d /sys/class/leds/rgb:kbd_backlight* 2>/dev/null || {
  echo "Still missing. Check: sudo dmesg | grep -Ei 'tuxedo|clevo'"
  exit 1
}

for d in /sys/class/leds/rgb:kbd_backlight*; do
  sudo chmod 0666 "$d/brightness" 2>/dev/null || true
  [[ -f "$d/multi_intensity" ]] && sudo chmod 0666 "$d/multi_intensity" || true
done

"$ROOT/scripts/test-leds.sh" '255 0 0' 128
echo "If the keyboard turned red, the GNOME extension can control it after login."
