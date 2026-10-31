#!/usr/bin/env bash
# Build, sign (Secure Boot MOK) and install Clevo/tuxedo-drivers for Avell A50i.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRIVER_DIR="$ROOT/driver"
MOK_DIR="$DRIVER_DIR/mok"
BUILD_DIR="${BUILD_DIR:-/tmp/tuxedo-drivers-avell}"
REPO_URL="${REPO_URL:-https://github.com/tuxedocomputers/tuxedo-drivers.git}"
KERNEL="$(uname -r)"
SIGN_FILE="/usr/src/linux-headers-${KERNEL}/scripts/sign-file"
MODULE_DEST="/lib/modules/${KERNEL}/updates/dkms"
MOK_PASS="${MOK_PASS:-rgbavell}"

need_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    exec /usr/bin/sudo bash "$0" "$@"
  fi
}

ensure_deps() {
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    dkms build-essential "linux-headers-${KERNEL}" git openssl mokutil xz-utils
}

ensure_mok() {
  mkdir -p "$MOK_DIR"
  if [[ ! -f "$MOK_DIR/mok.key" || ! -f "$MOK_DIR/mok.der" ]]; then
    echo "Generating Secure Boot MOK keypair..."
    openssl req -new -x509 -newkey rsa:2048 \
      -keyout "$MOK_DIR/mok.key" -out "$MOK_DIR/mok.crt" \
      -nodes -days 36500 -subj "/CN=Avell A50i RGB Keyboard/"
    openssl x509 -in "$MOK_DIR/mok.crt" -outform DER -out "$MOK_DIR/mok.der"
    chmod 600 "$MOK_DIR/mok.key"
  fi

  # mokutil --test-key exits 0 when the key is already enrolled.
  if mokutil --test-key "$MOK_DIR/mok.der" >/dev/null 2>&1; then
    echo "MOK already enrolled."
  elif mokutil --list-new 2>/dev/null | grep -q 'Avell A50i RGB Keyboard'; then
    echo "MOK enrollment already pending. Reboot and enroll (password: ${MOK_PASS})."
  else
    echo "Enrolling MOK (one-time reboot required)."
    echo "At the blue MOK Manager screen choose Enroll MOK, then enter password: ${MOK_PASS}"
    printf '%s\n%s\n' "$MOK_PASS" "$MOK_PASS" | mokutil --import "$MOK_DIR/mok.der" || true
  fi
  echo "$MOK_PASS" > "$MOK_DIR/mok-password.txt"
  chmod 600 "$MOK_DIR/mok-password.txt"
}

fetch_and_patch() {
  rm -rf "$BUILD_DIR"
  git clone --depth 1 "$REPO_URL" "$BUILD_DIR"
  patch -d "$BUILD_DIR" -p1 < "$DRIVER_DIR/patches/0001-avell-dmi-compat.patch"
}

build_and_install() {
  make -C "$BUILD_DIR" -j"$(nproc)"

  if [[ ! -x "$SIGN_FILE" ]]; then
    echo "Missing ${SIGN_FILE}. Install linux-headers-${KERNEL}." >&2
    exit 1
  fi

  mkdir -p "$MODULE_DEST"
  # Drop previous broken installs under updates/src
  rm -rf "/lib/modules/${KERNEL}/updates/src"

  find "$BUILD_DIR" -name '*.ko' -print0 | while IFS= read -r -d '' ko; do
    name="$(basename "$ko")"
    cp "$ko" "$MODULE_DEST/$name"
    "$SIGN_FILE" sha256 "$MOK_DIR/mok.key" "$MOK_DIR/mok.der" "$MODULE_DEST/$name"
    echo "signed $name"
  done

  depmod -a

  install -Dm644 "$DRIVER_DIR/modules-load/tuxedo-avell.conf" \
    /etc/modules-load.d/tuxedo-avell.conf
  install -Dm644 "$DRIVER_DIR/modprobe/tuxedo_keyboard.conf" \
    /etc/modprobe.d/tuxedo_keyboard.conf
  install -Dm644 "$DRIVER_DIR/udev/99-rgb-kbd-backlight.rules" \
    /etc/udev/rules.d/99-rgb-kbd-backlight.rules

  udevadm control --reload-rules
  udevadm trigger --subsystem-match=leds || true
}

try_load() {
  for m in tuxedo_compatibility_check tuxedo_keyboard clevo_wmi clevo_acpi; do
    modprobe "$m" 2>/dev/null || true
  done

  echo
  if ls /sys/class/leds/rgb:kbd_backlight* >/dev/null 2>&1; then
    echo "OK: RGB LED sysfs present:"
    ls -d /sys/class/leds/rgb:kbd_backlight*
    # Apply udev perms immediately
    for d in /sys/class/leds/rgb:kbd_backlight*; do
      chmod 0666 "$d/brightness" 2>/dev/null || true
      [[ -f "$d/multi_intensity" ]] && chmod 0666 "$d/multi_intensity" 2>/dev/null || true
    done
    echo "Test: echo '255 0 0' | tee /sys/class/leds/rgb:kbd_backlight/multi_intensity"
  else
    echo "Modules installed but RGB sysfs not visible yet."
    if mokutil --list-new 2>/dev/null | grep -q 'Avell A50i'; then
      echo "Secure Boot MOK is pending. Reboot and enroll the key (password: ${MOK_PASS}),"
      echo "then run: sudo modprobe tuxedo_keyboard && sudo modprobe clevo_wmi"
    else
      echo "Check: dmesg | grep -Ei 'tuxedo|clevo'"
    fi
  fi
}

main() {
  need_root "$@"
  ensure_deps
  ensure_mok
  fetch_and_patch
  build_and_install
  try_load
}

main "$@"
