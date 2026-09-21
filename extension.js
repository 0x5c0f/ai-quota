import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import DeepSeekProvider from './providers/deepseek.js';
import KimiProvider from './providers/kimi.js';
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
    return [new DeepSeekProvider(), new KimiProvider(), new CodexBarProvider(), new GenericProvider()];
}

const CURRENCY_SYMBOL = { CNY: '¥', USD: '$' };

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
        this._states = new Map(); // providerId -> {kind, ...}
        for (const p of this._providers)
            this._states.set(p.id, { kind: 'init' });

        this._panelBox = new St.BoxLayout({ style_class: 'ab-panel-box' });
        this._icon = new St.Label({ text: '⚡', y_align: Clutter.ActorAlign.CENTER, style_class: 'ab-icon' });
        this._summary = new St.Label({ text: 'API', y_align: Clutter.ActorAlign.CENTER, style_class: 'ab-summary' });
        this._badge = new St.Label({ text: '', y_align: Clutter.ActorAlign.CENTER, style_class: 'ab-badge' });
        this._panelBox.add_child(this._icon);
        this._panelBox.add_child(this._summary);
        this._panelBox.add_child(this._badge);
        this.add_child(this._panelBox);

        this._buildPopup();

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

    /* ── popup panel ──────────────────────────────────── */

    _buildPopup() {
        const box = this.menu.box;
        box.add_style_class_name('ab-popup');

        const refreshBtn = new St.Button({
            label: '刷新',
            style_class: 'ab-btn ab-btn-refresh',
            y_align: Clutter.ActorAlign.CENTER,
        });
        refreshBtn.connect('clicked', () => this._fetchAll());

        this._header = new St.BoxLayout({ style_class: 'ab-header' });
        this._headerText = new St.Label({ text: 'API 额度', style_class: 'ab-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._header.add_child(this._headerText);
        this._header.add_child(refreshBtn);
        box.add_child(this._header);

        this._cards = new St.BoxLayout({ vertical: true, style_class: 'ab-cards' });
        box.add_child(this._cards);

        this._footer = new St.Label({ text: '', style_class: 'ab-footer dim-label', x_align: Clutter.ActorAlign.START });
        box.add_child(this._footer);

        this._sep = new St.BoxLayout({ style_class: 'ab-sep' });
        box.add_child(this._sep);

        const actions = new St.BoxLayout({ style_class: 'ab-actions' });
        const prefsBtn = new St.Button({
            child: new St.Icon({ icon_name: 'emblem-system-symbolic', icon_size: 16 }),
            style_class: 'ab-btn ab-btn-icon',
        });
        prefsBtn.connect('clicked', () => this._openPreferences());
        actions.add_child(prefsBtn);
        box.add_child(actions);
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
            return `${worst.name} ${Math.round(worst.remaining)}%`;
        // Snapshots may hold cost/credits-only rows (no quota window at all);
        // fall back so a pinned bridge is never silent.
        for (const card of st.cards ?? []) {
            if (card.credits)
                return `${card.name} ${fmtCredits(card.credits)}`;
        }
        for (const card of st.cards ?? []) {
            if (card.todayUSD !== null && card.todayUSD !== undefined)
                return `${card.name} $${card.todayUSD.toFixed(2)}`;
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
                    parts.push(`${disp}: !`);
                }
                continue;
            }
            if (st.kind === 'ok') {
                const amounts = st.entries.map(e => fmtAmount(e.currency, e.total)).join(' ');
                parts.push(`${disp}: ${amounts}`);
            } else if (st.kind === 'unconfigured') {
                parts.push(`${disp}: 未配置`);
            } else if (st.kind === 'loading' || st.kind === 'init') {
                parts.push(`${disp}: …`);
            } else {
                errors++;
                parts.push(`${disp}: !`);
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
        const parts = this._topbarParts;
        if (parts.length === 0) {
            this._summary.set_text('API');
            return;
        }
        const mode = this._settings.get_string('topbar-display');
        if (mode === 'single')
            this._summary.set_text(parts.join(' | '));
        else
            this._summary.set_text(parts[this._topbarIdx % parts.length]);
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
                        this._cards.add_child(this._bridgeCard(p, card));
                    if (st.cards.length === 0)
                        this._cards.add_child(this._bridgeCard(p, { name: p.name, windows: [], error: '快照中无可展示的服务商（直连已覆盖或 CodexBar 未配置服务商）' }));
                } else {
                    this._cards.add_child(this._bridgeCard(p, { name: p.name, windows: [], error: st.kind === 'loading' ? null : st.error, loading: st.kind === 'loading' || st.kind === 'init' }));
                }
                continue;
            }
            this._cards.add_child(this._directCard(p, cfg, st));
        }

        if (this._cards.get_n_children() === 0) {
            this._cards.add_child(new St.Label({
                text: '没有启用的后端，请在设置中勾选「启用查询」',
                style_class: 'ab-empty dim-label',
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
        this._footer.set_text(bits.join(' · '));
        this._footer.visible = bits.length > 0;
    }

    _srcTag(text, cls) {
        return new St.Label({ text, style_class: `ab-src-tag ${cls}`, y_align: Clutter.ActorAlign.CENTER });
    }

    _directCard(p, cfg, st) {
        const card = new St.BoxLayout({ vertical: true, style_class: 'ab-card', x_expand: true });
        const head = new St.BoxLayout({ style_class: 'ab-card-head', x_expand: true });
        head.add_child(new St.BoxLayout({
            style_class: cfg.pinned ? 'ab-dot ab-dot-on' : 'ab-dot ab-dot-off',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        head.add_child(new St.Label({
            text: this._displayName(p, cfg),
            style_class: 'ab-card-name',
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        head.add_child(this._srcTag('直连', 'ab-src-direct'));
        head.add_child(this._statusLabel(st.kind));
        card.add_child(head);

        if (st.kind === 'ok') {
            for (const [i, e] of st.entries.entries()) {
                if (i > 0)
                    card.add_child(new St.BoxLayout({ style_class: 'ab-cur-sep', x_expand: true }));
                card.add_child(this._kv('总额', fmtAmount(e.currency, e.total), { big: true }));
                if (e.toppedUp !== null && e.toppedUp !== undefined)
                    card.add_child(this._kv('充值', fmtAmount(e.currency, e.toppedUp), { muted: true }));
                if (e.granted !== null && e.granted !== undefined)
                    card.add_child(this._kv('赠送', fmtAmount(e.currency, e.granted), { muted: true }));
            }
        } else if (st.kind !== 'loading' && st.kind !== 'init') {
            card.add_child(this._kv('错误', st.error ?? st.kind));
        }
        return card;
    }

    _statusLabel(kind) {
        const dotText = {
            ok: '正常', loading: '查询中…', unconfigured: '未配置',
            auth: '密钥无效', unavail: '服务不可用', error: '查询失败', init: '待查询',
        }[kind] ?? kind;
        return new St.Label({
            text: dotText,
            style_class: `ab-status ab-status-${kind}`,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    _bridgeCard(p, card) {
        const box = new St.BoxLayout({ vertical: true, style_class: 'ab-card', x_expand: true });
        const head = new St.BoxLayout({ style_class: 'ab-card-head', x_expand: true });
        const cfg = this._providerConfig(p);
        head.add_child(new St.BoxLayout({
            style_class: cfg.pinned ? 'ab-dot ab-dot-on' : 'ab-dot ab-dot-off',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        head.add_child(new St.Label({
            text: card.name,
            style_class: 'ab-card-name',
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        if (card.badge)
            head.add_child(this._srcTag(card.badge, 'ab-src-plan'));
        head.add_child(this._srcTag('CodexBar', 'ab-src-bridge'));
        head.add_child(this._statusLabel(card.loading ? 'loading' : card.error ? 'error' : 'ok'));
        box.add_child(head);

        const mode = this._settings.get_string('window-display');
        for (const w of card.windows ?? [])
            box.add_child(mode === 'text' ? this._windowText(w) : this._windowBar(w));

        if (card.credits)
            box.add_child(this._kv('额度', fmtCredits(card.credits), { muted: true }));
        else if (card.todayUSD !== null && card.todayUSD !== undefined)
            box.add_child(this._kv('今日费用', `$${card.todayUSD.toFixed(2)}`, { muted: true }));

        if (card.error)
            box.add_child(this._kv('错误', card.error));
        return box;
    }

    _windowBar(w) {
        const wrap = new St.BoxLayout({ vertical: true, style_class: 'ab-win', x_expand: true });
        const top = new St.BoxLayout({ style_class: 'ab-win-top', x_expand: true });
        top.add_child(new St.Label({
            text: `剩余 ${Math.round(w.remaining)}% · ${w.label}`,
            style_class: 'ab-win-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        }));
        if (w.resetAt)
            top.add_child(new St.Label({ text: fmtReset(w.resetAt), style_class: 'ab-win-reset dim-label' }));
        wrap.add_child(top);

        // StDrawingArea requests 0 height; a fixed-height BoxLayout (CSS height,
        // like .ab-sep) allocates the 6px band and the area fills it.
        const track = new St.BoxLayout({ style_class: 'ab-win-bar', x_expand: true });
        const area = new St.DrawingArea({ x_expand: true, y_expand: true });
        area.connect('repaint', a => {
            const cr = a.get_context();
            const [wpx, hpx] = a.get_surface_size();
            const r = hpx / 2;
            cr.setSourceRGBA(1, 1, 1, 0.12);
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
        return wrap;
    }

    _windowText(w) {
        const row = new St.BoxLayout({ style_class: 'ab-kv', x_expand: true });
        row.add_child(new St.Label({
            text: w.label,
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
            style_class: 'ab-kv-key',
        }));
        const suffix = w.resetAt ? `  ·  ${fmtReset(w.resetAt)}` : '';
        row.add_child(new St.Label({
            text: `剩余 ${Math.round(w.remaining)}%${suffix}`,
            x_align: Clutter.ActorAlign.END,
            style_class: 'ab-kv-value',
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

    _kv(k, v, opts = {}) {
        const row = new St.BoxLayout({ style_class: 'ab-kv', x_expand: true });
        const kl = new St.Label({
            text: k,
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
            style_class: opts.muted ? 'ab-kv-key dim-label' : 'ab-kv-key',
        });
        const vl = new St.Label({
            text: v,
            x_align: Clutter.ActorAlign.END,
            style_class: opts.big ? 'ab-kv-value ab-kv-big' : 'ab-kv-value',
        });
        row.add_child(kl);
        row.add_child(vl);
        return row;
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
        const tmpPath = `/tmp/apib-codexbar-${GLib.get_monotonic_time()}.json`;
        let sub;
        try {
            sub = new Gio.Subprocess({ argv: p.cliArgs(cfg, tmpPath), flags: 0 });
            sub.init(null);
        } catch (e) {
            this._states.set(p.id, { kind: 'error', error: `无法启动 CodexBar：${e.message}（请安装 codexbar 或改用 HTTP 模式）` });
            this._render();
            return;
        }
        const cancellable = new Gio.Cancellable();
        this._cancellables.push(cancellable);
        sub.wait_async(cancellable, (s, res) => {
            if (!this._cancellables.includes(cancellable))
                return;
            this._cancellables = this._cancellables.filter(c => c !== cancellable);
            let result;
            try {
                s.wait_finish(res);
                const status = s.get_exit_status();
                if (status !== 0)
                    throw new Error(`codexbar 退出码 ${status}`);
                const [, bytes] = GLib.file_get_contents(tmpPath);
                try {
                    Gio.File.new_for_path(tmpPath).delete(null);
                } catch (_) { /* gone already */ }
                result = p.parse(200, new TextDecoder().decode(bytes), cfg, skipIds);
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
