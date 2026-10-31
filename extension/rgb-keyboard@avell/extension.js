import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

const LEDS_DIR = '/sys/class/leds';
const POPUP_WIDTH = 280;
const BLINK_FREQ_MIN = 0.2;
const BLINK_FREQ_MAX = 8.0;
const ANIM_MS = 33;
const COLOR_FADE_MS = 420;
/** AGC so brightness follows track dynamics, not master volume. */
const AUDIO_AGC_DECAY = 2.8;
const AUDIO_AGC_FLOOR = 0.05;
/** Distinct palette so beat steps read clearly (no continuous rainbow). */
const AUDIO_SYNC_COLORS = [
    {r: 255, g: 0, b: 0},
    {r: 255, g: 140, b: 0},
    {r: 255, g: 255, b: 0},
    {r: 0, g: 255, b: 0},
    {r: 0, g: 220, b: 255},
    {r: 0, g: 80, b: 255},
    {r: 200, g: 0, b: 255},
];

function listRgbZones() {
    const dir = Gio.File.new_for_path(LEDS_DIR);
    let enumerator;
    try {
        enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    } catch (_e) {
        return [];
    }

    const zones = [];
    let info;
    while ((info = enumerator.next_file(null)) !== null) {
        const name = info.get_name();
        if (name.startsWith('rgb:kbd_backlight'))
            zones.push(`${LEDS_DIR}/${name}`);
    }
    enumerator.close(null);
    zones.sort();
    return zones;
}

function writeSysfs(path, value) {
    // Do not use GLib.file_set_contents(): it writes via temp+rename, which
    // sysfs rejects (Permission denied creating path.XXXXXX).
    try {
        const file = Gio.File.new_for_path(path);
        const stream = file.open_readwrite(null);
        const output = stream.get_output_stream();
        output.write_all(new TextEncoder().encode(`${value}`), null);
        stream.close(null);
        return true;
    } catch (e) {
        console.error(`rgb-keyboard@avell: failed to write ${path}: ${e.message}`);
        return false;
    }
}

function readSysfs(path) {
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        if (!ok)
            return null;
        return new TextDecoder().decode(contents).trim();
    } catch (_e) {
        return null;
    }
}

function applyKeyboardState({enabled, brightness, red, green, blue}) {
    const zones = listRgbZones();
    if (zones.length === 0)
        return {ok: false, reason: 'driver'};

    const level = enabled ? Math.max(0, Math.min(255, Math.round(brightness))) : 0;
    const r = Math.max(0, Math.min(255, Math.round(red)));
    const g = Math.max(0, Math.min(255, Math.round(green)));
    const b = Math.max(0, Math.min(255, Math.round(blue)));
    const intensity = `${r} ${g} ${b}`;

    let wrote = false;
    for (const zone of zones) {
        const multi = `${zone}/multi_intensity`;
        const bright = `${zone}/brightness`;
        if (GLib.file_test(multi, GLib.FileTest.EXISTS))
            wrote = writeSysfs(multi, intensity) || wrote;
        if (GLib.file_test(bright, GLib.FileTest.EXISTS))
            wrote = writeSysfs(bright, String(level)) || wrote;
    }

    return wrote ? {ok: true, zones: zones.length} : {ok: false, reason: 'permission'};
}

function colorKey(r, g, b) {
    return `${r},${g},${b}`;
}

function parseColorKey(key) {
    const parts = String(key).split(',').map(p => Number.parseInt(p, 10));
    if (parts.length !== 3 || parts.some(n => Number.isNaN(n)))
        return null;
    return {
        r: Math.max(0, Math.min(255, parts[0])),
        g: Math.max(0, Math.min(255, parts[1])),
        b: Math.max(0, Math.min(255, parts[2])),
    };
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function clamp01(x) {
    return Math.max(0, Math.min(1, x));
}

/** Soft blink envelope: fade=0 hard square, fade=1 full cosine pulse. */
function blinkEnvelope(phase, fade) {
    const square = phase < 0.5 ? 1 : 0;
    const sine = 0.5 * (1 + Math.cos(2 * Math.PI * phase));
    const f = clamp01(fade);
    return square * (1 - f) + sine * f;
}

const PRESET_COLORS = [
    {name: 'White', r: 255, g: 255, b: 255},
    {name: 'Red', r: 255, g: 0, b: 0},
    {name: 'Green', r: 0, g: 255, b: 0},
    {name: 'Blue', r: 0, g: 0, b: 255},
    {name: 'Cyan', r: 0, g: 255, b: 255},
    {name: 'Magenta', r: 255, g: 0, b: 255},
    {name: 'Yellow', r: 255, g: 255, b: 0},
    {name: 'Orange', r: 255, g: 128, b: 0},
];

const RgbKeyboardIndicator = GObject.registerClass(
class RgbKeyboardIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Avell RGB Keyboard');
        this._extension = extension;
        this._settings = extension.getSettings();
        this._applying = false;
        this._destroyed = false;

        this._animSource = 0;
        this._blinkPhase = 0;
        this._lastAnimMs = 0;

        this._live = {
            r: this._settings.get_int('red'),
            g: this._settings.get_int('green'),
            b: this._settings.get_int('blue'),
        };
        this._target = {...this._live};
        this._colorFadeT = 1;
        this._colorFadeFrom = {...this._live};

        this._audioIntensity = 0;
        this._audioSmooth = 0;
        this._audioNormPeak = AUDIO_AGC_FLOOR;
        this._audioBeatPending = false;
        this._audioColorIndex = 0;
        this._audioProc = null;
        this._audioStdout = null;
        this._audioReadId = 0;
        this._lastWritten = null;

        this.add_style_class_name('rgb-keyboard-panel-button');

        this._icon = new St.Icon({
            icon_name: 'preferences-desktop-keyboard-symbolic',
            style_class: 'system-status-icon rgb-keyboard-panel-icon',
        });
        this.add_child(this._icon);

        this.menu.actor.add_style_class_name('rgb-keyboard-popup');
        this.menu.actor.width = POPUP_WIDTH;

        this._statusItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._statusItem.label.add_style_class_name('rgb-keyboard-status-label');
        this._statusItem.label.clutter_text.line_wrap = true;
        this.menu.addMenuItem(this._statusItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._enabledItem = new PopupMenu.PopupSwitchMenuItem('Backlight', true);
        this._enabledItem.connect('toggled', (_item, state) => {
            this._settings.set_boolean('enabled', state);
            this._requestFrame(true);
        });
        this.menu.addMenuItem(this._enabledItem);

        this._brightnessSlider = this._addChannelSlider('Brightness', 'brightness');

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Color'));
        this._addColorPresets();

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Saved'));
        this._savedBox = null;
        this._addSavedColorsSection();

        this._redSlider = this._addChannelSlider('Red', 'red');
        this._greenSlider = this._addChannelSlider('Green', 'green');
        this._blueSlider = this._addChannelSlider('Blue', 'blue');

        this._preview = new St.Widget({
            style_class: 'rgb-keyboard-preview',
            x_expand: false,
            height: 18,
        });
        const previewItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
        previewItem.add_child(this._preview);
        this.menu.addMenuItem(previewItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Blink'));
        this._blinkItem = new PopupMenu.PopupSwitchMenuItem('Blink', false);
        this._blinkItem.connect('toggled', (_item, state) => {
            if (state && this._settings.get_boolean('audio-reactive'))
                this._settings.set_boolean('audio-reactive', false);
            this._settings.set_boolean('blink-enabled', state);
        });
        this.menu.addMenuItem(this._blinkItem);

        this._freqSlider = this._addRangeSlider('Rate', value => {
            const freq = BLINK_FREQ_MIN + value * (BLINK_FREQ_MAX - BLINK_FREQ_MIN);
            this._settings.set_double('blink-frequency', Math.round(freq * 10) / 10);
        });
        this._freqLabel = this._addHintLabel();

        this._fadeSlider = this._addRangeSlider('Fade', value => {
            this._settings.set_double('blink-fade', Math.round(value * 100) / 100);
        });
        this._fadeLabel = this._addHintLabel();

        this._audioItem = new PopupMenu.PopupSwitchMenuItem('Music sync', false);
        this._audioItem.connect('toggled', (_item, state) => {
            if (state && this._settings.get_boolean('blink-enabled'))
                this._settings.set_boolean('blink-enabled', false);
            this._settings.set_boolean('audio-reactive', state);
        });
        this.menu.addMenuItem(this._audioItem);

        this._audioHint = this._addHintLabel();
        this._audioHint.text = 'aubio tempo beats + fixed colors';

        this._settingsChangedIds = [
            this._settings.connect('changed::enabled', () => this._syncFromSettings()),
            this._settings.connect('changed::brightness', () => this._syncFromSettings()),
            this._settings.connect('changed::red', () => this._onColorSettingChanged()),
            this._settings.connect('changed::green', () => this._onColorSettingChanged()),
            this._settings.connect('changed::blue', () => this._onColorSettingChanged()),
            this._settings.connect('changed::saved-colors', () => this._rebuildSavedColors()),
            this._settings.connect('changed::blink-enabled', () => {
                this._syncFromSettings();
                this._syncEffects();
            }),
            this._settings.connect('changed::blink-frequency', () => {
                this._syncFromSettings();
                this._requestFrame();
            }),
            this._settings.connect('changed::blink-fade', () => {
                this._syncFromSettings();
                this._requestFrame();
            }),
            this._settings.connect('changed::audio-reactive', () => {
                this._syncFromSettings();
                this._syncEffects();
            }),
        ];

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refreshStatus();
        });

        this._syncFromSettings();
        this._syncEffects();
        this._requestFrame(true);
    }

    _addHintLabel() {
        const label = new St.Label({
            text: '',
            style_class: 'rgb-keyboard-hint',
            x_expand: true,
        });
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false});
        item.add_child(label);
        this.menu.addMenuItem(item);
        return label;
    }

    _addChannelSlider(label, key) {
        const item = new PopupMenu.PopupBaseMenuItem({activate: false});
        const box = new St.BoxLayout({
            vertical: false,
            x_expand: false,
            style_class: 'rgb-keyboard-slider-row',
        });
        const name = new St.Label({
            text: label,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'rgb-keyboard-slider-label',
        });
        const slider = new Slider(0);
        slider.x_expand = true;

        box.add_child(name);
        box.add_child(slider);
        item.add_child(box);
        this.menu.addMenuItem(item);

        slider.connect('notify::value', () => {
            if (this._applying)
                return;
            const value = Math.round(slider.value * 255);
            this._settings.set_int(key, value);
            if (key === 'brightness')
                this._requestFrame();
            // RGB handled by changed:: handlers → color fade
        });

        return slider;
    }

    _addRangeSlider(label, onChange) {
        const item = new PopupMenu.PopupBaseMenuItem({activate: false});
        const box = new St.BoxLayout({
            vertical: false,
            x_expand: false,
            style_class: 'rgb-keyboard-slider-row',
        });
        const name = new St.Label({
            text: label,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'rgb-keyboard-slider-label',
        });
        const slider = new Slider(0);
        slider.x_expand = true;

        box.add_child(name);
        box.add_child(slider);
        item.add_child(box);
        this.menu.addMenuItem(item);

        slider.connect('notify::value', () => {
            if (this._applying)
                return;
            onChange(slider.value);
        });

        return slider;
    }

    _makeSwatch(r, g, b, {onClick, onRemove = null} = {}) {
        const btn = new St.Button({
            style_class: 'rgb-keyboard-swatch',
            style: `background-color: rgb(${r}, ${g}, ${b});`,
            reactive: true,
            can_focus: true,
            track_hover: true,
        });
        btn.connect('clicked', () => onClick?.());
        if (onRemove) {
            btn.connect('button-press-event', (_actor, event) => {
                // 3 = secondary / right mouse button
                if (event.get_button() === 3) {
                    onRemove();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
        }
        return btn;
    }

    _addColorPresets() {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({
            style_class: 'rgb-keyboard-presets',
            x_expand: false,
        });

        for (const color of PRESET_COLORS) {
            box.add_child(this._makeSwatch(color.r, color.g, color.b, {
                onClick: () => this._setColor(color.r, color.g, color.b),
            }));
        }

        item.add_child(box);
        this.menu.addMenuItem(item);
    }

    _addSavedColorsSection() {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._savedBox = new St.BoxLayout({
            style_class: 'rgb-keyboard-saved',
            x_expand: false,
        });
        item.add_child(this._savedBox);
        this.menu.addMenuItem(item);

        const hint = new PopupMenu.PopupMenuItem('Right-click saved to remove', {
            reactive: false,
            can_focus: false,
        });
        hint.label.add_style_class_name('rgb-keyboard-hint');
        this.menu.addMenuItem(hint);

        this._rebuildSavedColors();
    }

    _rebuildSavedColors() {
        if (!this._savedBox)
            return;

        this._savedBox.destroy_all_children();

        const saved = this._settings.get_strv('saved-colors');
        for (const key of saved) {
            const color = parseColorKey(key);
            if (!color)
                continue;
            this._savedBox.add_child(this._makeSwatch(color.r, color.g, color.b, {
                onClick: () => this._setColor(color.r, color.g, color.b),
                onRemove: () => this._removeSavedColor(key),
            }));
        }

        const addBtn = new St.Button({
            style_class: 'rgb-keyboard-swatch-add',
            label: '+',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });
        addBtn.connect('clicked', () => this._saveCurrentColor());
        this._savedBox.add_child(addBtn);
    }

    _setColor(r, g, b) {
        this._beginColorFade({r, g, b});
        this._applying = true;
        this._settings.set_int('red', r);
        this._settings.set_int('green', g);
        this._settings.set_int('blue', b);
        if (!this._settings.get_boolean('enabled'))
            this._settings.set_boolean('enabled', true);
        this._applying = false;
        this._syncFromSettings();
        this._requestFrame();
    }

    _beginColorFade(next) {
        if (next.r === this._target.r && next.g === this._target.g && next.b === this._target.b)
            return;
        this._colorFadeFrom = {...this._live};
        this._target = {...next};
        this._colorFadeT = 0;
    }

    _saveCurrentColor() {
        const key = colorKey(
            this._settings.get_int('red'),
            this._settings.get_int('green'),
            this._settings.get_int('blue'));
        const saved = this._settings.get_strv('saved-colors');
        if (saved.includes(key))
            return;
        this._settings.set_strv('saved-colors', [...saved, key]);
    }

    _removeSavedColor(key) {
        const saved = this._settings.get_strv('saved-colors').filter(c => c !== key);
        this._settings.set_strv('saved-colors', saved);
    }

    _onColorSettingChanged() {
        if (this._applying) {
            this._syncFromSettings();
            return;
        }
        this._beginColorFade({
            r: this._settings.get_int('red'),
            g: this._settings.get_int('green'),
            b: this._settings.get_int('blue'),
        });
        this._syncFromSettings();
        this._requestFrame();
    }

    _updateHints() {
        const freq = this._settings.get_double('blink-frequency');
        const fade = this._settings.get_double('blink-fade');
        this._freqLabel.text = `${freq.toFixed(1)} Hz`;
        this._fadeLabel.text = `${Math.round(fade * 100)}% soft`;
    }

    _syncFromSettings() {
        this._applying = true;
        const enabled = this._settings.get_boolean('enabled');
        const brightness = this._settings.get_int('brightness');
        const red = this._settings.get_int('red');
        const green = this._settings.get_int('green');
        const blue = this._settings.get_int('blue');
        const blinkEnabled = this._settings.get_boolean('blink-enabled');
        const audioReactive = this._settings.get_boolean('audio-reactive');
        const freq = this._settings.get_double('blink-frequency');
        const fade = this._settings.get_double('blink-fade');

        this._enabledItem.setToggleState(enabled);
        this._brightnessSlider.value = brightness / 255;
        this._redSlider.value = red / 255;
        this._greenSlider.value = green / 255;
        this._blueSlider.value = blue / 255;
        this._blinkItem.setToggleState(blinkEnabled);
        this._audioItem.setToggleState(audioReactive);
        this._freqSlider.value =
            (freq - BLINK_FREQ_MIN) / (BLINK_FREQ_MAX - BLINK_FREQ_MIN);
        this._fadeSlider.value = fade;
        this._updateHints();
        this._preview.set_style(
            `background-color: rgb(${Math.round(this._live.r)}, ${Math.round(this._live.g)}, ${Math.round(this._live.b)}); opacity: ${enabled ? 1 : 0.25};`);
        this._applying = false;
        this._refreshStatus();
    }

    _refreshStatus() {
        const zones = listRgbZones();
        if (zones.length === 0) {
            this._statusItem.label.text =
                'Driver not loaded. Run scripts/install-driver.sh and reboot to enroll the Secure Boot key.';
            return;
        }
        if (this._settings.get_boolean('audio-reactive') && !this._audioProc) {
            this._statusItem.label.text =
                'Music sync needs Python3 + aubio + numpy + parec.';
            return;
        }
        this._statusItem.label.text = `Ready · ${zones.length} zone(s)`;
    }

    _effectsNeedAnim() {
        return this._settings.get_boolean('blink-enabled') ||
            this._settings.get_boolean('audio-reactive') ||
            this._colorFadeT < 1;
    }

    _requestFrame(forceWrite = false) {
        if (this._destroyed)
            return;
        if (forceWrite)
            this._lastWritten = null;
        if (this._animSource)
            return;
        this._lastAnimMs = GLib.get_monotonic_time() / 1000;
        this._animSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ANIM_MS, () => {
            if (this._destroyed) {
                this._animSource = 0;
                return GLib.SOURCE_REMOVE;
            }
            const keep = this._tickAnim();
            if (!keep)
                this._animSource = 0;
            return keep ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });
    }

    _stopAnim() {
        if (this._animSource) {
            GLib.source_remove(this._animSource);
            this._animSource = 0;
        }
    }

    _tickAnim() {
        if (this._destroyed)
            return false;

        const now = GLib.get_monotonic_time() / 1000;
        let dt = (now - this._lastAnimMs) / 1000;
        this._lastAnimMs = now;
        if (!(dt > 0) || dt > 0.25)
            dt = ANIM_MS / 1000;

        // Color fade toward target (skipped while music sync owns the color)
        const audioOn = this._settings.get_boolean('audio-reactive');
        if (!audioOn && this._colorFadeT < 1) {
            this._colorFadeT = clamp01(this._colorFadeT + (dt * 1000) / COLOR_FADE_MS);
            const t = this._colorFadeT * this._colorFadeT * (3 - 2 * this._colorFadeT);
            this._live.r = lerp(this._colorFadeFrom.r, this._target.r, t);
            this._live.g = lerp(this._colorFadeFrom.g, this._target.g, t);
            this._live.b = lerp(this._colorFadeFrom.b, this._target.b, t);
        } else if (!audioOn) {
            this._live.r = this._target.r;
            this._live.g = this._target.g;
            this._live.b = this._target.b;
        }

        let litFactor = 1;
        let outR = this._live.r;
        let outG = this._live.g;
        let outB = this._live.b;

        if (audioOn) {
            const attack = this._audioIntensity > this._audioSmooth ? 0.75 : 0.22;
            this._audioSmooth = lerp(this._audioSmooth, this._audioIntensity, 1 - Math.exp(-attack * dt * 60));
            const energy = this._audioSmooth;

            // Normalize against recent peak → relative dynamics, not master volume
            this._audioNormPeak = Math.max(
                AUDIO_AGC_FLOOR,
                energy,
                this._audioNormPeak * Math.exp(-AUDIO_AGC_DECAY * dt));
            const relative = clamp01(energy / this._audioNormPeak);

            // Beats come from aubio tempo (or flux fallback) in audio-monitor.py
            if (this._audioBeatPending) {
                this._audioBeatPending = false;
                this._audioColorIndex =
                    (this._audioColorIndex + 1) % AUDIO_SYNC_COLORS.length;
            }

            const beatColor = AUDIO_SYNC_COLORS[this._audioColorIndex];
            const snap = 1 - Math.exp(-22 * dt);
            outR = lerp(this._live.r, beatColor.r, snap);
            outG = lerp(this._live.g, beatColor.g, snap);
            outB = lerp(this._live.b, beatColor.b, snap);
            this._live.r = outR;
            this._live.g = outG;
            this._live.b = outB;
            litFactor = 0.42 + 0.58 * relative;
        } else if (this._settings.get_boolean('blink-enabled')) {
            const freq = Math.max(
                BLINK_FREQ_MIN,
                Math.min(BLINK_FREQ_MAX, this._settings.get_double('blink-frequency')));
            this._blinkPhase = (this._blinkPhase + freq * dt) % 1;
            litFactor = blinkEnvelope(
                this._blinkPhase,
                this._settings.get_double('blink-fade'));
        }

        const enabled = this._settings.get_boolean('enabled');
        const brightness = this._settings.get_int('brightness') * litFactor;
        this._writeState({
            enabled,
            brightness,
            red: outR,
            green: outG,
            blue: outB,
        });

        if (this._preview)
            this._preview.set_style(
                `background-color: rgb(${Math.round(outR)}, ${Math.round(outG)}, ${Math.round(outB)}); opacity: ${enabled ? Math.max(0.2, litFactor) : 0.25};`);

        return this._effectsNeedAnim();
    }

    _writeState(state) {
        const key = `${state.enabled}|${Math.round(state.brightness)}|${Math.round(state.red)}|${Math.round(state.green)}|${Math.round(state.blue)}`;
        if (key === this._lastWritten)
            return;
        this._lastWritten = key;
        const result = applyKeyboardState(state);
        if (!result.ok && result.reason === 'permission') {
            this._statusItem.label.text =
                'Cannot write LEDs. Install the udev rule from scripts/install-driver.sh.';
        } else if (!result.ok && result.reason === 'driver') {
            this._statusItem.label.text =
                'Driver not loaded. Run scripts/install-driver.sh and reboot to enroll the Secure Boot key.';
        }
    }

    _syncEffects() {
        const audioOn = this._settings.get_boolean('audio-reactive');
        const wasAudio = !!this._audioProc;

        if (audioOn)
            this._startAudio();
        else
            this._stopAudio();

        if (wasAudio && !audioOn) {
            // Ease back from visualizer colors to the selected solid color
            this._colorFadeFrom = {...this._live};
            this._colorFadeT = 0;
        }

        if (this._settings.get_boolean('blink-enabled'))
            this._blinkPhase = 0;

        this._requestFrame(true);
    }

    _startAudio() {
        if (this._destroyed || this._audioProc)
            return;

        const helper = GLib.build_filenamev([this._extension.path, 'audio-monitor.py']);
        if (!GLib.file_test(helper, GLib.FileTest.IS_EXECUTABLE) &&
            !GLib.file_test(helper, GLib.FileTest.EXISTS)) {
            console.error(`rgb-keyboard@avell: missing audio helper ${helper}`);
            this._refreshStatus();
            return;
        }

        try {
            // Keep GStreamer out of the gnome-shell process — it breaks the panel.
            const proc = Gio.Subprocess.new(
                ['python3', helper],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            this._audioProc = proc;
            this._audioStdout = Gio.DataInputStream.new(proc.get_stdout_pipe());
            this._audioIntensity = 0;
            this._audioSmooth = 0;
            this._audioNormPeak = AUDIO_AGC_FLOOR;
            this._audioBeatPending = false;
            this._audioColorIndex = 0;
            this._audioReadId++;
            this._readAudioLine(this._audioReadId);
        } catch (e) {
            console.error(`rgb-keyboard@avell: audio helper failed: ${e.message}`);
            this._stopAudio();
            this._refreshStatus();
        }
    }

    _readAudioLine(generation) {
        if (this._destroyed || !this._audioStdout || generation !== this._audioReadId)
            return;

        this._audioStdout.read_line_async(
            GLib.PRIORITY_DEFAULT, null, (stream, result) => {
                if (this._destroyed || generation !== this._audioReadId)
                    return;
                try {
                    const [line] = stream.read_line_finish_utf8(result);
                    if (line === null) {
                        this._stopAudio();
                        this._refreshStatus();
                        return;
                    }
                    // Protocol: "<intensity> <beat>" (beat optional for back-compat)
                    const parts = line.trim().split(/\s+/);
                    const value = Number.parseFloat(parts[0]);
                    if (!Number.isNaN(value)) {
                        this._audioIntensity = clamp01(value);
                        if (parts.length > 1 && Number.parseInt(parts[1], 10) === 1)
                            this._audioBeatPending = true;
                        this._requestFrame();
                    }
                } catch (e) {
                    console.error(`rgb-keyboard@avell: audio read failed: ${e.message}`);
                    this._stopAudio();
                    this._refreshStatus();
                    return;
                }
                this._readAudioLine(generation);
            });
    }

    _stopAudio() {
        this._audioReadId++;
        this._audioStdout = null;

        if (this._audioProc) {
            try {
                this._audioProc.force_exit();
            } catch (_e) {
                // already dead
            }
            this._audioProc = null;
        }
        this._audioIntensity = 0;
        this._audioSmooth = 0;
        this._audioNormPeak = AUDIO_AGC_FLOOR;
        this._audioBeatPending = false;
    }

    destroy() {
        this._destroyed = true;
        this._stopAnim();
        this._stopAudio();
        for (const id of this._settingsChangedIds)
            this._settings.disconnect(id);
        this._settingsChangedIds = [];
        super.destroy();
    }
});

export default class RgbKeyboardExtension extends Extension {
    enable() {
        this._indicator = new RgbKeyboardIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
