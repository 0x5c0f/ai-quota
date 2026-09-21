import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import DeepSeekProvider from './providers/deepseek.js';
import GenericProvider from './providers/generic.js';
import CodexBarProvider from './providers/codexbar.js';

// Optional dependency: degrade gracefully instead of throwing at load.
let Soup = null;
try {
    Soup = (await import('gi://Soup?version=3.0')).default;
} catch (_) {
    try {
        Soup = (await import('gi://Soup?version=2.4')).default;
    } catch (e) {
        console.error(`[ApiBalance] libsoup unavailable: ${e.message}`);
    }
}

// Provider registry: add a file under providers/ and register it here.
// Instantiated per panel (not at module load) to keep extension.js side-effect free.
function buildProviders() {
    return [new DeepSeekProvider(), new CodexBarProvider(), new GenericProvider()];
}

const CURRENCY_SYMBOL = { CNY: '¥', USD: '$' };

// Logo colours are fixed (not theme-driven) so each card stays recognisable.
const DIRECT_LOGOS = {
    deepseek: { color: '#4d6bfe', text: 'DS' },
    custom: { color: '#00b0ff' },
};
const BRIDGE_LOGOS = ['#7a5af8', '#d97757', '#10a37f', '#00b0ff', '#e8590c'];

function fmtAmount(currency, value) {
    const sym = CURRENCY_SYMBOL[currency] ?? `${currency} `;
    return `${sym}${value.toFixed(2)}`;
}

function fmtCredits(credits) {
    const u = credits.unit;
    return (u === 'USD' || u === '$' || u === '')
        ? `$${credits.remaining.toFixed(2)}`
        : `${credits.remaining.toFixed(2)} ${u}`;
}

function fmtReset(iso) {
    if (!iso)
        return '';
    const dt = GLib.DateTime.new_from_iso8601(iso, null);
    if (!dt)
        return '';
    const now = GLib.DateTime.new_now_utc();
    const secs = dt.to_unix() - now.to_unix();
    if (secs <= 0)
        return '即将重置';
    if (secs < 3600)
        return `${Math.round(secs / 60)}分后重置`;
    if (secs < 86400)
        return `${Math.floor(secs / 3600)}小时${Math.floor(secs % 3600 / 60)}分后重置`;
    const local = dt.to_local();
    return `${local.format('%-m月%-d日')} ${local.format('%H:%M')} 重置`;
}

function windowColor(remaining) {
    if (remaining < 20)
        return [0.878, 0.106, 0.141]; // red
    if (remaining <= 50)
        return [0.961, 0.761, 0.067]; // yellow
    return [0.208, 0.518, 0.894];     // blue
}

// A snapshot field is external input into a CSS string: accept plain hex only.
function safeHex(color) {
    return typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color.trim()) ? color.trim() : null;
}

function accentForId(id) {
    let h = 0;
    for (const c of String(id))
        h = (h * 31 + c.charCodeAt(0)) % BRIDGE_LOGOS.length;
    return BRIDGE_LOGOS[h];
}

function makeMessage(uri, headers) {
    if (Soup.MAJOR_VERSION === 3) {
        const msg = new Soup.Message({ method: 'GET', uri: GLib.Uri.parse(uri, GLib.UriFlags.NONE) });
        for (const [k, v] of Object.entries(headers))
            msg.request_headers.append(k, v);
        return msg;
    }
    const msg = Soup.Message.new('GET', uri);
    for (const [k, v] of Object.entries(headers))
        msg.request_headers.append(k, v);
    return msg;
}

class BalancePanel extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    _init(settings, openPreferences) {
        super._init(0.0, 'API Balance', false);

        // Private class fields initialize only after the _init chain: assign here.
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._timerId = 0;
        this._carouselId = 0;
        this._topbarParts = [];
        this._topbarIdx = 0;
        this._settingsDebounceId = 0;
        this._cancellables = [];
        this._session = null;
        this._lastFetch = null;
        this._signals = [];
        this._providers = buildProviders();
        this._light = false;
        this._barDarkInk = null;
        this._states = new Map(); // providerId -> {kind, ...}
        for (const p of this._providers)
            this._states.set(p.id, { kind: 'init' });

        this._panelBox = new St.BoxLayout({ style_class: 'ab-panel-box' });
        this._icon = new St.Label({ text: '⚡', y_align: Clutter.ActorAlign.CENTER, style_class: 'ab-icon' });
        this._summaryBox = new St.BoxLayout({ style_class: 'ab-summary-box', y_align: Clutter.ActorAlign.CENTER });
        this._badge = new St.Label({ text: '', y_align: Clutter.ActorAlign.CENTER, style_class: 'ab-badge' });
        this._panelBox.add_child(this._icon);
        this._panelBox.add_child(this._summaryBox);
        this._panelBox.add_child(this._badge);
        this.add_child(this._panelBox);

        this._buildPopup();

        // The desktop dark/light switch is the only system input the palette takes.
        try {
            this._iface = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        } catch (e) {
            this._iface = null; // no interface schema: stay on the dark palette
        }
        if (this._iface)
            this._signals.push({ obj: this._iface, id: this._iface.connect('changed', () => this._applyPalette()) });
        this._applyPalette();

        // Parent keys (refresh-interval, topbar-display) fire on the main settings;
        // per-provider keys (enabled/pinned/api-key, plus custom's url/maps) live in
        // child schemas and do NOT propagate to the parent, so subscribe to each child too.
        this._signals.push({ obj: this._settings, id: this._settings.connect('changed', (s, key) => this._onSettingChanged(key)) });
        for (const p of this._providers) {
            const ps = this._providerSettings(p);
            this._signals.push({ obj: ps, id: ps.connect('changed', (s, key) => this._onSettingChanged(key)) });
        }

        this._startTimer();
        this._fetchAll();
    }

    /* ── config helpers ───────────────────────────────── */

    _providerSettings(p) {
        // get_child takes the schema <child name>, path is derived by GSettings.
        return this._settings.get_child(p.id.replace(/-/g, '_'));
    }

    _providerConfig(p) {
        const ps = this._providerSettings(p);
        const cfg = {
            enabled: ps.get_boolean('enabled'),
            pinned: ps.get_boolean('pinned'),
        };
        if (!p.bridge)
            cfg.api_key = ps.get_string('api-key').trim();
        // The custom provider stores its whole request shape in its child schema.
        if (p.id === 'custom') {
            cfg.name = ps.get_string('name').trim();
            cfg.url = ps.get_string('url').trim();
            cfg.map_currency = ps.get_string('map-currency').trim();
            cfg.map_total = ps.get_string('map-total').trim();
            cfg.map_granted = ps.get_string('map-granted').trim();
            cfg.map_topped_up = ps.get_string('map-topped-up').trim();
        }
        if (p.bridge) {
            cfg.mode = ps.get_string('mode');
            cfg.url = ps.get_string('url').trim();
            cfg.command = ps.get_string('command').trim();
            cfg.token = ps.get_string('token').trim();
        }
        return cfg;
    }

    _displayName(p, cfg) {
        return p.id === 'custom' ? (cfg.name || '自定义') : p.name;
    }

    _desktopPrefersDark() {
        // The same two keys Adwaita reads. Contrast schemes are accessibility
        // settings we do not mirror, so they fall back to the legacy boolean.
        const scheme = this._iface.get_string('color-scheme');
        if (scheme === 'default')
            return false;
        if (scheme === 'prefer-dark')
            return true;
        return this._iface.get_boolean('gtk-application-prefer-dark-theme');
    }

    _applyPalette() {
        const mode = this._settings.get_string('theme-mode');
        const light = mode === 'light' ||
            (mode !== 'dark' && this._iface && !this._desktopPrefersDark());
        if (light === this._light)
            return;
        this._light = light;
        if (light)
            this.menu.box.add_style_class_name('ab-light');
        else
            this.menu.box.remove_style_class_name('ab-light');
        this._renderCards(); // the progress-bar track is painted in JS, not CSS
    }

    _barNeedsDarkInk() {
        // The bar's own background belongs to the shell theme and does not
        // necessarily follow the desktop switch (Yaru keeps a dark bar in light
        // mode), so match the theme's bar text. Our button inherits that colour
        // (.ab-top-* colours the labels, never the button), whereas #panel itself
        // reports an unset colour.
        try {
            const c = this.get_theme_node().get_color('color');
            if (c.alpha < 50)
                throw new Error('button colour is unset');
            return 0.2126 * c.red + 0.7152 * c.green + 0.0722 * c.blue < 128;
        } catch (e) {
            return this._iface ? !this._desktopPrefersDark() : false;
        }
    }

    _applyBarInk() {
        const darkInk = this._barNeedsDarkInk();
        if (darkInk === this._barDarkInk)
            return;
        this._barDarkInk = darkInk;
        // Same state class as the popup, on the other actor tree (the button).
        if (darkInk)
            this.add_style_class_name('ab-light');
        else
            this.remove_style_class_name('ab-light');
    }

    /* ── popup panel ──────────────────────────────────── */

    _buildPopup() {
        const box = this.menu.box;
        box.add_style_class_name('ab-popup');

        this._header = new St.BoxLayout({ style_class: 'ab-header' });
        this._header.add_child(new St.Label({
            text: 'API 额度',
            style_class: 'ab-title',
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const refreshBtn = new St.Button({
            child: new St.Icon({ icon_name: 'view-refresh-symbolic', icon_size: 16 }),
            style_class: 'ab-iconbtn',
        });
        refreshBtn.connect('clicked', () => this._fetchAll());
        const prefsBtn = new St.Button({
            child: new St.Icon({ icon_name: 'emblem-system-symbolic', icon_size: 16 }),
            style_class: 'ab-iconbtn',
        });
        prefsBtn.connect('clicked', () => this._openPreferences());
        this._header.add_child(refreshBtn);
        this._header.add_child(prefsBtn);
        box.add_child(this._header);

        this._cards = new St.BoxLayout({ vertical: true, style_class: 'ab-cards' });
        box.add_child(this._cards);

        this._foot = new St.BoxLayout({ style_class: 'ab-foot' });
        this._footPill = new St.Label({ text: '', style_class: 'ab-foot-pill', x_align: Clutter.ActorAlign.START });
        this._foot.add_child(this._footPill);
        box.add_child(this._foot);
    }

    _render() {
        this._renderSummary();
        this._renderCards();
    }

    _bridgeTightest(st) {
        // Tightest (lowest remaining) window across all bridge cards.
        let worst = null;
        for (const card of st.cards ?? []) {
            for (const w of card.windows ?? []) {
                if (!worst || w.remaining < worst.remaining)
                    worst = { name: card.name, remaining: w.remaining };
            }
        }
        return worst;
    }

    _bridgeTopbarPart(st) {
        const worst = this._bridgeTightest(st);
        if (worst)
            return { name: worst.name, value: `${Math.round(worst.remaining)}%`, tone: worst.remaining < 20 ? 'err' : 'pct' };
        // Snapshots may hold cost/credits-only rows (no quota window at all);
        // fall back so a pinned bridge is never silent.
        for (const card of st.cards ?? []) {
            if (card.credits)
                return { name: card.name, value: fmtCredits(card.credits), tone: 'value' };
        }
        for (const card of st.cards ?? []) {
            if (card.todayUSD !== null && card.todayUSD !== undefined)
                return { name: card.name, value: `$${card.todayUSD.toFixed(2)}`, tone: 'value' };
        }
        return null;
    }

    _renderSummary() {
        const parts = [];
        let errors = 0;
        for (const p of this._providers) {
            const st = this._states.get(p.id);
            const cfg = this._providerConfig(p);
            if (!cfg.enabled || !cfg.pinned)
                continue;
            const disp = this._displayName(p, cfg);
            if (p.bridge) {
                if (st.kind === 'ok') {
                    const part = this._bridgeTopbarPart(st);
                    if (part)
                        parts.push(part);
                } else if (st.kind !== 'loading' && st.kind !== 'init') {
                    errors++;
                    parts.push({ name: disp, value: '!', tone: 'err' });
                }
                continue;
            }
            if (st.kind === 'ok') {
                const amounts = st.entries.map(e => fmtAmount(e.currency, e.total)).join(' ');
                parts.push({ name: disp, value: amounts, tone: 'value' });
            } else if (st.kind === 'unconfigured') {
                parts.push({ name: disp, value: '未配置', tone: 'dim' });
            } else if (st.kind === 'loading' || st.kind === 'init') {
                parts.push({ name: disp, value: '…', tone: 'dim' });
            } else {
                errors++;
                parts.push({ name: disp, value: '!', tone: 'err' });
            }
        }

        this._topbarParts = parts;
        if (this._topbarIdx >= parts.length)
            this._topbarIdx = 0;

        this._icon.set_text(parts.length === 0 ? '⚡' : (errors > 0 ? '⚡' : '💰'));
        this._badge.set_text(errors > 0 ? `⚠${errors}` : '');
        this._badge.visible = errors > 0;

        this._updateCarouselTimer();
        this._applyTopbar();
    }

    _applyTopbar() {
        this._applyBarInk();
        this._summaryBox.destroy_all_children();
        const parts = this._topbarParts;
        const add = (text, cls) => this._summaryBox.add_child(
            new St.Label({ text, style_class: cls, y_align: Clutter.ActorAlign.CENTER }));

        if (parts.length === 0) {
            add('API', 'ab-top-value');
            return;
        }
        const mode = this._settings.get_string('topbar-display');
        const shown = mode === 'single' ? parts : [parts[this._topbarIdx % parts.length]];
        for (const [i, part] of shown.entries()) {
            if (i > 0)
                add('|', 'ab-top-sep');
            add(part.name, 'ab-top-name');
            const tone = part.tone === 'value' ? '' : ` ab-top-${part.tone}`;
            add(part.value, `ab-top-value${tone}`);
        }
    }

    _updateCarouselTimer() {
        const mode = this._settings.get_string('topbar-display');
        const want = mode === 'carousel' && this._topbarParts.length > 1;
        if (want && this._carouselId === 0) {
            this._carouselId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
                if (this._topbarParts.length === 0)
                    return GLib.SOURCE_CONTINUE;
                this._topbarIdx = (this._topbarIdx + 1) % this._topbarParts.length;
                this._applyTopbar();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!want && this._carouselId > 0) {
            GLib.source_remove(this._carouselId);
            this._carouselId = 0;
        }
    }

    _renderCards() {
        this._cards.destroy_all_children();
        for (const p of this._providers) {
            const st = this._states.get(p.id);
            const cfg = this._providerConfig(p);
            if (!cfg.enabled)
                continue; // disabled providers are hidden from the panel entirely
            if (p.visible && !p.visible(cfg))
                continue; // an untouched custom provider shows no card
            if (p.bridge) {
                if (st.kind === 'ok') {
                    for (const card of st.cards)
                        this._cards.add_child(this._bridgeCard(card));
                    if (st.cards.length === 0)
                        this._cards.add_child(this._bridgeCard({ id: p.id, name: p.name, windows: [], error: '快照中无可展示的服务商（直连已覆盖或 CodexBar 未配置服务商）' }));
                } else {
                    this._cards.add_child(this._bridgeCard({ id: p.id, name: p.name, windows: [], error: st.kind === 'loading' ? null : st.error, loading: st.kind === 'loading' || st.kind === 'init' }));
                }
                continue;
            }
            this._cards.add_child(this._directCard(p, cfg, st));
        }

        if (this._cards.get_n_children() === 0) {
            this._cards.add_child(new St.Label({
                text: '没有启用的后端，请在设置中勾选「启用查询」',
                style_class: 'ab-empty',
                x_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            }));
        }
        this._renderFooter();
    }

    _renderFooter() {
        const bits = [];
        if (this._lastFetch)
            bits.push(`上次刷新 ${this._lastFetch.format('%H:%M')}`);
        const bst = this._states.get('codexbar');
        if (bst?.kind === 'ok' && bst.generatedAt) {
            const dt = GLib.DateTime.new_from_iso8601(bst.generatedAt, null);
            if (dt)
                bits.push(`CodexBar 快照 ${dt.to_local().format('%H:%M')}`);
        }
        let failed = false;
        for (const p of this._providers) {
            const kind = this._states.get(p.id).kind;
            if (this._providerConfig(p).enabled && !['ok', 'loading', 'init'].includes(kind))
                failed = true;
        }
        this._footPill.set_text(bits.join(' · '));
        this._footPill.style_class = failed ? 'ab-foot-pill ab-foot-pill-warn' : 'ab-foot-pill';
        this._foot.visible = bits.length > 0;
    }

    _tag(text, cls) {
        return new St.Label({ text, style_class: `ab-tag ${cls}`, y_align: Clutter.ActorAlign.CENTER });
    }

    _statusTag(kind) {
        const text = {
            ok: '正常', loading: '查询中…', unconfigured: '未配置',
            auth: '密钥无效', unavail: '服务不可用', error: '查询失败', init: '待查询',
        }[kind] ?? kind;
        const cls = kind === 'ok' ? 'ab-tag-ok'
            : ['loading', 'init', 'unconfigured'].includes(kind) ? 'ab-tag'
                : 'ab-tag-err';
        return this._tag(text, cls);
    }

    _logo(color, glyph, name) {
        const box = new St.BoxLayout({ style_class: 'ab-logo', y_align: Clutter.ActorAlign.CENTER });
        box.set_style(`background-color: ${safeHex(color) ?? '#5b5b5b'};`);
        const text = glyph ?? (String(name ?? '?').trim().charAt(0).toUpperCase() || '?');
        box.add_child(new St.Label({
            text,
            style_class: 'ab-logo-text',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        return box;
    }

    _nameLabel(text) {
        return new St.Label({
            text,
            style_class: 'ab-card-name',
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    _subLine(text, opts = {}) {
        const row = new St.BoxLayout({ style_class: 'ab-sub', x_expand: true });
        row.add_child(new St.Label({
            text,
            style_class: opts.err ? 'ab-sub-err' : '',
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        if (opts.tag)
            row.add_child(this._tag(opts.tag, opts.tagCls ?? 'ab-tag-src'));
        return row;
    }

    _directCard(p, cfg, st) {
        const card = new St.BoxLayout({ vertical: true, style_class: 'ab-card', x_expand: true });
        const head = new St.BoxLayout({ style_class: 'ab-card-head', x_expand: true });
        const logo = DIRECT_LOGOS[p.id] ?? {};
        head.add_child(this._logo(logo.color, logo.text, this._displayName(p, cfg)));
        head.add_child(this._nameLabel(this._displayName(p, cfg)));
        head.add_child(this._statusTag(st.kind));
        if (st.kind === 'ok') {
            head.add_child(new St.Label({ text: '总额', style_class: 'ab-money-cap', y_align: Clutter.ActorAlign.CENTER }));
            head.add_child(new St.Label({
                text: st.entries.map(e => fmtAmount(e.currency, e.total)).join(' '),
                style_class: 'ab-money-big',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        card.add_child(head);

        if (st.kind === 'ok') {
            for (const [i, e] of st.entries.entries()) {
                if (i > 0)
                    card.add_child(new St.BoxLayout({ style_class: 'ab-cur-sep', x_expand: true }));
                const bits = [];
                if (e.toppedUp !== null && e.toppedUp !== undefined)
                    bits.push(`充值 ${fmtAmount(e.currency, e.toppedUp)}`);
                if (e.granted !== null && e.granted !== undefined)
                    bits.push(`赠送 ${fmtAmount(e.currency, e.granted)}`);
                card.add_child(this._subLine(bits.join(' · '), { tag: '直连' }));
            }
        } else if (st.kind !== 'loading' && st.kind !== 'init') {
            if (st.error)
                card.add_child(this._subLine(st.error, { err: true, tag: '直连' }));
        }
        return card;
    }

    _bridgeCard(card) {
        const box = new St.BoxLayout({ vertical: true, style_class: 'ab-card', x_expand: true });
        const head = new St.BoxLayout({ style_class: 'ab-card-head', x_expand: true });
        head.add_child(this._logo(safeHex(card.accent) ?? accentForId(card.id), card.name.charAt(0).toUpperCase(), card.name));
        head.add_child(this._nameLabel(card.name));
        if (card.badge)
            head.add_child(this._tag(card.badge, 'ab-tag-ok'));
        if (card.loading)
            head.add_child(this._statusTag('loading'));
        else if (card.error)
            head.add_child(this._statusTag('error'));
        head.add_child(this._tag('CodexBar', 'ab-tag'));
        box.add_child(head);

        const metaBits = [];
        if (card.todayUSD !== null && card.todayUSD !== undefined)
            metaBits.push(`今日费用 $${card.todayUSD.toFixed(2)}`);
        if (card.credits)
            metaBits.push(`额度 ${fmtCredits(card.credits)}`);
        const meta = metaBits.join(' · ') || null;

        const mode = this._settings.get_string('window-display');
        for (const [i, w] of (card.windows ?? []).entries())
            box.add_child(mode === 'text' ? this._windowText(w) : this._windowBar(w, i === 0 ? meta : null));

        if (meta && !card.windows?.length)
            box.add_child(this._subLine(meta));
        if (card.error)
            box.add_child(this._subLine(card.error, { err: true }));
        return box;
    }

    _windowBar(w, meta) {
        const wrap = new St.BoxLayout({ vertical: true, style_class: 'ab-win', x_expand: true });
        const top = new St.BoxLayout({ style_class: 'ab-win-top', x_expand: true });
        top.add_child(new St.Label({ text: `剩余 ${Math.round(w.remaining)}%`, style_class: 'ab-win-rem', y_align: Clutter.ActorAlign.CENTER }));
        top.add_child(new St.Label({
            text: `· ${w.label}`,
            style_class: 'ab-win-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        wrap.add_child(top);

        // StDrawingArea requests 0 height; a fixed-height BoxLayout (CSS height,
        // like .ab-cur-sep) allocates the 6px band and the area fills it.
        const track = new St.BoxLayout({ style_class: 'ab-win-bar', x_expand: true });
        const area = new St.DrawingArea({ x_expand: true, y_expand: true });
        area.connect('repaint', a => {
            const cr = a.get_context();
            const [wpx, hpx] = a.get_surface_size();
            const r = hpx / 2;
            cr.setSourceRGBA(...(this._light ? [0, 0, 0, 0.10] : [1, 1, 1, 0.12]));
            this._roundRect(cr, 0, 0, wpx, hpx, r);
            cr.fill();
            const [r0, g0, b0] = windowColor(w.remaining);
            cr.setSourceRGBA(r0, g0, b0, 1);
            const fill = Math.max(hpx, wpx * (1 - w.remaining / 100));
            this._roundRect(cr, 0, 0, fill, hpx, r);
            cr.fill();
            cr.$dispose();
        });
        track.add_child(area);
        wrap.add_child(track);

        const metaRow = new St.BoxLayout({ style_class: 'ab-win-meta', x_expand: true });
        const left = new St.BoxLayout({ style_class: 'ab-win-left', x_expand: true, x_align: Clutter.ActorAlign.START });
        if (w.remaining < 20)
            left.add_child(new St.Label({ text: '即将用尽', style_class: 'ab-win-crit', y_align: Clutter.ActorAlign.CENTER }));
        if (meta)
            left.add_child(new St.Label({ text: meta, style_class: 'ab-win-cost', y_align: Clutter.ActorAlign.CENTER }));
        metaRow.add_child(left);
        if (w.resetAt)
            metaRow.add_child(new St.Label({ text: fmtReset(w.resetAt), style_class: 'ab-win-reset', y_align: Clutter.ActorAlign.CENTER }));
        wrap.add_child(metaRow);
        return wrap;
    }

    _windowText(w) {
        const row = new St.BoxLayout({ style_class: 'ab-win', x_expand: true });
        row.add_child(new St.Label({
            text: w.label,
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
            style_class: 'ab-win-label',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const suffix = w.resetAt ? ` · ${fmtReset(w.resetAt)}` : '';
        row.add_child(new St.Label({
            text: `剩余 ${Math.round(w.remaining)}%${suffix}`,
            style_class: w.remaining < 20 ? 'ab-win-rem ab-win-crit' : 'ab-win-rem',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        return row;
    }

    _roundRect(cr, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        cr.newSubPath();
        cr.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
        cr.arc(x + r, y + r, r, Math.PI / 2, 3 * Math.PI / 2);
        cr.closePath();
    }

    /* ── fetching ─────────────────────────────────────── */

    _startTimer() {
        this._stopTimer();
        const secs = Math.max(60, this._settings.get_int('refresh-interval'));
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secs, () => {
            this._fetchAll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTimer() {
        if (this._timerId > 0) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }

    _onSettingChanged(key) {
        if (key === 'refresh-interval')
            this._startTimer();
        // A palette switch needs no re-render beyond repainting the bars.
        if (key === 'theme-mode') {
            this._applyPalette();
            return;
        }
        // Display-mode change needs only a re-render, not a network refetch.
        if (key === 'topbar-display' || key === 'window-display') {
            this._render();
            return;
        }
        // Pinning only changes what the top bar shows; data is already fetched.
        if (key === 'pinned') {
            this._render();
            return;
        }
        // Debounce: typing in an API-key row fires changed per keystroke.
        if (this._settingsDebounceId > 0)
            GLib.source_remove(this._settingsDebounceId);
        this._settingsDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._settingsDebounceId = 0;
            this._fetchAll();
            return GLib.SOURCE_REMOVE;
        });
    }

    _fetchAll() {
        this._cancelAll();
        this._lastFetch = GLib.DateTime.new_now_local();
        // Direct providers win: bridge cards for the same service id are dropped.
        const skipIds = new Set();
        for (const p of this._providers)
            if (!p.bridge && this._providerConfig(p).enabled)
                skipIds.add(p.id);
        for (const p of this._providers) {
            const cfg = this._providerConfig(p);
            if (!cfg.enabled) {
                this._states.set(p.id, { kind: 'unconfigured' });
                continue;
            }
            if (p.bridge) {
                if (cfg.mode === 'http' && !cfg.url) {
                    this._states.set(p.id, { kind: 'unconfigured' });
                    continue;
                }
                this._states.set(p.id, { kind: 'loading' });
                if (cfg.mode === 'cli')
                    this._fetchBridgeCli(p, cfg, skipIds);
                else if (Soup)
                    this._fetchOne(p, cfg, skipIds);
                else
                    this._states.set(p.id, { kind: 'error', error: 'libsoup 不可用' });
                continue;
            }
            if (!cfg.api_key || (p.id === 'custom' && !cfg.url)) {
                this._states.set(p.id, { kind: 'unconfigured' });
                continue;
            }
            if (!Soup) {
                this._states.set(p.id, { kind: 'error', error: 'libsoup 不可用' });
                continue;
            }
            this._states.set(p.id, { kind: 'loading' });
            this._fetchOne(p, cfg, skipIds);
        }
        this._render();
    }

    _fetchBridgeCli(p, cfg, skipIds) {
        let sub;
        try {
            // Piped output: the snapshot arrives on stdout, so nothing is ever
            // written to disk. communicate also reaps the process for us.
            sub = new Gio.Subprocess({
                argv: p.cliArgs(cfg),
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            sub.init(null);
        } catch (e) {
            this._states.set(p.id, { kind: 'error', error: `无法启动 CodexBar：${e.message}（请安装 codexbar 或改用 HTTP 模式）` });
            this._render();
            return;
        }
        const cancellable = new Gio.Cancellable();
        this._cancellables.push(cancellable);
        sub.communicate_utf8_async(null, cancellable, (s, res) => {
            if (!this._cancellables.includes(cancellable))
                return;
            this._cancellables = this._cancellables.filter(c => c !== cancellable);
            let result;
            try {
                const [, stdout, stderr] = s.communicate_utf8_finish(res);
                const status = s.get_exit_status();
                if (status !== 0) {
                    // CodexBar reports on stderr; its first line beats a bare exit code.
                    const why = (stderr || '').split('\n').find(l => l.trim() !== '');
                    throw new Error(`codexbar 退出码 ${status}${why ? '：' + why.slice(0, 120) : ''}`);
                }
                if (!stdout)
                    throw new Error('CodexBar 没有输出快照');
                result = p.parse(200, stdout, cfg, skipIds);
            } catch (e) {
                result = { ok: false, error: e.message };
            }
            this._states.set(p.id, result.ok
                ? { kind: 'ok', cards: result.cards, generatedAt: result.generatedAt }
                : { kind: result.kind ?? 'error', error: result.error });
            this._render();
        });
    }

    _fetchOne(p, cfg, skipIds) {
        const cancellable = new Gio.Cancellable();
        this._cancellables.push(cancellable);

        try {
            const req = p.buildRequest(cfg);
            const msg = makeMessage(req.uri, req.headers);
            this._session = this._session ?? new Soup.Session();
            this._session.send_and_read_async(
                msg, GLib.PRIORITY_DEFAULT, cancellable,
                (sess, res) => this._onResponse(p, cfg, msg, res, cancellable, skipIds));
        } catch (e) {
            this._states.set(p.id, { kind: 'error', error: e.message });
            this._render();
        }
    }

    _onResponse(p, cfg, msg, res, cancellable, skipIds) {
        if (!this._cancellables.includes(cancellable))
            return; // superseded by a newer fetch or destroyed
        this._cancellables = this._cancellables.filter(c => c !== cancellable);

        let result;
        try {
            let bytes, m;
            if (Soup.MAJOR_VERSION === 3) {
                bytes = this._session.send_and_read_finish(res);
                m = msg;
            } else {
                [m, bytes] = this._session.send_and_read_finish(res);
            }
            const status = m.get_status();
            const body = bytes ? new TextDecoder().decode(bytes.get_data()) : '';
            result = p.parse(status, body, cfg, skipIds);
        } catch (e) {
            result = { ok: false, error: e.message };
        }

        this._states.set(p.id, result.ok
            ? (p.bridge
                ? { kind: 'ok', cards: result.cards, generatedAt: result.generatedAt }
                : { kind: 'ok', entries: result.entries })
            : { kind: result.kind ?? 'error', error: result.error });
        this._render();
    }

    _cancelAll() {
        for (const c of this._cancellables)
            c.cancel();
        this._cancellables = [];
    }

    destroy() {
        this._stopTimer();
        if (this._carouselId > 0) {
            GLib.source_remove(this._carouselId);
            this._carouselId = 0;
        }
        if (this._settingsDebounceId > 0) {
            GLib.source_remove(this._settingsDebounceId);
            this._settingsDebounceId = 0;
        }
        this._cancelAll();
        this._session?.abort();
        this._session = null;
        for (const { obj, id } of this._signals)
            obj.disconnect(id);
        this._signals = [];
        this._iface = null;
        super.destroy();
    }
}

export default class ApiBalanceExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        try {
            this._panel = new BalancePanel(this._settings, () => this.openPreferences());
            Main.panel.addToStatusArea(this.uuid, this._panel);
        } catch (e) {
            // A failure here must never take the shell session down.
            logError(e, '[ApiBalance] failed to start panel');
            this._panel = null;
        }
    }

    disable() {
        this._panel?.destroy();
        this._panel = null;
        this._settings = null;
    }
}
