#!/usr/bin/env python3
"""Audio helper for rgb-keyboard@avell.

Captures the Pulse/PipeWire monitor via `parec` and detects musical beats with
aubio's tempo tracker (falls back to aubio onset, then spectral flux).

Prints one line per hop:
  <intensity 0..1> <beat 0|1>

Runs outside gnome-shell so analysis never touches the panel process.
"""
from __future__ import annotations

import subprocess
import sys

import numpy as np

try:
    import aubio
except ImportError:  # pragma: no cover - optional at runtime
    aubio = None

RATE = 44100
CHANNELS = 2
WIN = 1024
HOP = 512
SILENCE_DB = -45.0
LOUD_DB = -12.0
MIN_INTENSITY = 0.05
# Tempo tracker is steadier for color steps; onset is a fallback.
AUBIO_TEMPO_THRESHOLD = 0.3
AUBIO_ONSET_THRESHOLD = 0.3
AUBIO_ONSET_MINIOI_MS = 140
AUBIO_SILENCE_DB = -55.0
# Spectral-flux fallback params (used only without aubio).
FLUX_HISTORY = 48
FLUX_SENSITIVITY = 1.65
FLUX_MIN_HOPS = 12


def intensity_from_rms(rms: float) -> float:
    db = 20.0 * np.log10(max(rms, 1e-12))
    return float(max(0.0, min(1.0, (db - SILENCE_DB) / (LOUD_DB - SILENCE_DB))))


def open_parec():
    try:
        proc = subprocess.Popen(
            [
                'parec',
                '--format=float32le',
                f'--rate={RATE}',
                f'--channels={CHANNELS}',
                '--device=@DEFAULT_MONITOR@',
                '--latency-msec=25',
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except FileNotFoundError:
        print('rgb-keyboard audio-monitor: parec not found (install pulseaudio-utils)',
              file=sys.stderr)
        return None
    if proc.stdout is None:
        return None
    return proc


def make_aubio_detector():
    """Prefer tempo (musical beats); fall back to onset."""
    if aubio is None:
        return None, 'flux'

    try:
        det = aubio.tempo('default', WIN, HOP, RATE)
        det.set_threshold(AUBIO_TEMPO_THRESHOLD)
        det.set_silence(AUBIO_SILENCE_DB)
        return det, 'tempo'
    except Exception as exc:  # pragma: no cover
        print(f'rgb-keyboard audio-monitor: aubio.tempo failed ({exc}), trying onset',
              file=sys.stderr)

    try:
        det = aubio.onset('default', WIN, HOP, RATE)
        det.set_threshold(AUBIO_ONSET_THRESHOLD)
        det.set_minioi_ms(AUBIO_ONSET_MINIOI_MS)
        det.set_silence(AUBIO_SILENCE_DB)
        return det, 'onset'
    except Exception as exc:  # pragma: no cover
        print(f'rgb-keyboard audio-monitor: aubio.onset failed ({exc}), using flux',
              file=sys.stderr)
        return None, 'flux'


def run_aubio(proc, detector) -> int:
    ring = np.zeros(0, dtype=np.float32)
    bytes_per_hop = HOP * CHANNELS * 4

    while True:
        raw = proc.stdout.read(bytes_per_hop)
        if not raw or len(raw) < bytes_per_hop:
            break

        mono = np.frombuffer(raw, dtype=np.float32).reshape(-1, CHANNELS).mean(axis=1)
        ring = np.concatenate([ring, mono.astype(np.float32, copy=False)])

        while len(ring) >= HOP:
            frame = ring[:HOP]
            ring = ring[HOP:]

            hit = bool(detector(frame))
            rms = float(np.sqrt(np.mean(frame * frame)))
            intensity = intensity_from_rms(rms)
            beat = 1 if hit and intensity > MIN_INTENSITY else 0

            try:
                sys.stdout.write(f'{intensity:.4f} {beat}\n')
                sys.stdout.flush()
            except BrokenPipeError:
                return 0
    return 0


def run_flux(proc) -> int:
    """Classic spectral-flux onset (Dixon / Bello) if aubio is unavailable."""
    window = np.hanning(WIN).astype(np.float32)
    # Use WIN-sized FFT windows; advance by HOP like the aubio path.
    freqs = np.fft.rfftfreq(WIN, 1.0 / RATE)
    weights = np.clip(freqs / 1800.0, 0.2, 3.5).astype(np.float32)
    prev_mag = np.zeros(WIN // 2 + 1, dtype=np.float32)
    flux_hist: list[float] = []
    ring = np.zeros(0, dtype=np.float32)
    bytes_per_hop = HOP * CHANNELS * 4
    hop_index = 0
    last_beat_hop = -10_000

    while True:
        raw = proc.stdout.read(bytes_per_hop)
        if not raw or len(raw) < bytes_per_hop:
            break

        mono = np.frombuffer(raw, dtype=np.float32).reshape(-1, CHANNELS).mean(axis=1)
        ring = np.concatenate([ring, mono])

        while len(ring) >= WIN:
            chunk = ring[:WIN]
            ring = ring[HOP:]

            spectrum = np.abs(np.fft.rfft(chunk * window))
            flux = float(np.dot(np.maximum(0.0, spectrum - prev_mag), weights))
            prev_mag = spectrum

            flux_hist.append(flux)
            if len(flux_hist) > FLUX_HISTORY:
                flux_hist.pop(0)

            rms = float(np.sqrt(np.mean(chunk * chunk)))
            intensity = intensity_from_rms(rms)

            beat = 0
            if len(flux_hist) >= 12:
                hist = np.asarray(flux_hist, dtype=np.float64)
                median = float(np.median(hist))
                mad = float(np.mean(np.abs(hist - median))) + 1e-9
                threshold = median + FLUX_SENSITIVITY * mad * 1.4826
                rising = flux > flux_hist[-2]
                spaced = (hop_index - last_beat_hop) >= FLUX_MIN_HOPS
                if flux > threshold and rising and spaced and intensity > MIN_INTENSITY:
                    beat = 1
                    last_beat_hop = hop_index

            try:
                sys.stdout.write(f'{intensity:.4f} {beat}\n')
                sys.stdout.flush()
            except BrokenPipeError:
                return 0

            hop_index += 1
    return 0


def main() -> int:
    proc = open_parec()
    if proc is None:
        return 1

    detector, mode = make_aubio_detector()
    print(f'rgb-keyboard audio-monitor: mode={mode}', file=sys.stderr)

    try:
        if detector is not None:
            return run_aubio(proc, detector)
        return run_flux(proc)
    except (KeyboardInterrupt, BrokenPipeError):
        return 0
    finally:
        try:
            proc.kill()
        except Exception:
            pass
        try:
            proc.wait(timeout=1)
        except Exception:
            pass


if __name__ == '__main__':
    raise SystemExit(main())
