# Avell A50i RGB Keyboard (GNOME)

Control solid color and brightness of the Avell A50i RGB keyboard on Linux.

The A50i exposes **Clevo WMI** (`ABBC0F6D…`), not an ITE USB controller. This project:

1. Installs a patched `tuxedo-drivers` kernel module (Avell DMI allow-list)
2. Provides a GNOME Shell 48 extension that writes `/sys/class/leds/rgb:kbd_backlight*`

## Requirements

- Debian/Ubuntu with GNOME Shell 48+
- `dkms`, `linux-headers-$(uname -r)`, `build-essential`, `git`, `mokutil`
- Secure Boot: a one-time MOK enrollment reboot (handled by the installer)

## Quick start

```bash
# 1) Kernel driver (needs sudo). Creates/signs modules and enrolls a MOK key.
sudo ./scripts/install-driver.sh

# 2) Reboot. At the blue MOK Manager screen:
#    Enroll MOK → Continue → Yes → password: rgbavell → Reboot
#    (password is also in driver/mok/mok-password.txt)

# 3) After reboot + MOK enroll, load modules and turn the keyboard red:
./scripts/after-reboot.sh

# 4) Install / enable the GNOME extension (then log out/in on Wayland)
./scripts/install-extension.sh
# Top bar → keyboard icon → color / brightness / on-off
```

## Extension UI

- On/off toggle
- Brightness slider
- Color presets + R/G/B sliders
- Save / remove custom colors (click `+`, right-click to remove)
- Blink with adjustable rate and fade (soft pulse instead of hard on/off)
- Smooth color transitions when changing presets / RGB
- Music sync: aubio tempo beat tracking + fixed palette colors (PipeWire/Pulse via `parec`; needs `python3-aubio`)
- Restores last color/brightness on login (GSettings)

## Manual sysfs

```bash
echo '0 255 0' | sudo tee /sys/class/leds/rgb:kbd_backlight/multi_intensity
echo 200 | sudo tee /sys/class/leds/rgb:kbd_backlight/brightness
echo 0 | sudo tee /sys/class/leds/rgb:kbd_backlight/brightness   # off
```

With the udev rule installed, `sudo` is not required for those writes.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `No rgb:kbd_backlight` | `lsmod \| grep -E 'tuxedo\|clevo'`; `dmesg \| grep -Ei 'tuxedo\|clevo'` |
| `Key was rejected by service` | Secure Boot MOK not enrolled — reboot and finish MOK Manager |
| Extension says permission error | Re-run driver install (udev rule) or `sudo chmod 0666 /sys/class/leds/rgb:kbd_backlight/*` |
| Color does not change | Driver loaded but EC ignored the command — open an issue with `dmesg` + `dmidecode -t system` |

## Layout

```
extension/rgb-keyboard@avell/   GNOME Shell extension
driver/patches/                 Avell DMI patch for tuxedo-drivers
driver/udev/                    Non-root LED write permissions
scripts/install-driver.sh       Build, sign, install modules
scripts/after-reboot.sh         Load modules and apply a test color
scripts/install-extension.sh    Install extension for current user
scripts/test-leds.sh            Smoke-test sysfs
```

## Out of scope (v1)

Per-zone colors, per-key RGB, fan/thermal control.
