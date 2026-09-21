// CodexBar bridge provider: consumes the versioned dashboard-v1 snapshot
// produced by the external CodexBar tool (https://github.com/steipete/CodexBar).
// Two transports, chosen by cfg.mode:
//   http -> GET cfg.url (a running `codexbar serve`)
//   cli  -> run `cfg.command dashboard` once per refresh, reading its stdout
// Bridge results are cards (one per upstream provider), not balance entries.

function num(v) {
    if (typeof v === 'number' && Number.isFinite(v))
        return v;
    if (typeof v === 'string' && v.trim() !== '') {
        const n = parseFloat(v);
        if (Number.isFinite(n))
            return n;
    }
    return null;
}

const KIND_LABELS = {
    session: '会话',
    five_hour: '5 小时',
    fiveHour: '5 小时',
    hourly: '小时',
    daily: '日',
    weekly: '周',
    week: '周',
    monthly: '月',
    month: '月',
    prompts: '请求数',
    tertiary: '第三档',
    other: '配额',
    orb: 'Orb',
};

function fmtSpan(mins) {
    const hours = mins / 60;
    if (hours < 48)
        return `${Math.round(hours)} 小时`;
    const days = hours / 24;
    return days < 60 ? `${Math.round(days)} 天` : `${Math.round(days / 30)} 个月`;
}

// Snapshot `kind` is an open vocabulary (producers pass NamedRateWindow.id
// straight through, e.g. "kimi-monthly"), so an unmapped kind gets a generic
// label rather than leaking a raw id into the panel.
function windowLabel(w) {
    if (w.label)
        return String(w.label);
    const known = KIND_LABELS[w.kind];
    let label = known ?? '配额窗口';
    const mins = num(w.windowMinutes);
    if (!mins)
        return label;
    // The built-in kinds have a fixed length; anything else (or a session lane
    // the producer widened) says how long the window actually is.
    if (!known || (w.kind === 'session' && mins !== 300))
        label = `${label}（${fmtSpan(mins)}）`;
    return label;
}

// A lane marked `idle` reports no usage for a model family the client should
// not draw (docs/dashboard-api.md); the built-in web UI drops it the same way.
function readWindows(list) {
    const out = [];
    for (const w of Array.isArray(list) ? list : []) {
        if (!w || typeof w !== 'object' || w.idle === true)
            continue;
        let remaining = num(w.remainingPercent);
        const used = num(w.usedPercent);
        if (remaining === null && used !== null)
            remaining = 100 - used;
        if (remaining === null)
            continue; // absent is not zero
        out.push({
            label: windowLabel(w),
            remaining: Math.max(0, Math.min(100, remaining)),
            resetAt: typeof w.resetAt === 'string' ? w.resetAt : null,
        });
    }
    return out;
}

// Row-level and account-level diagnostics are plain strings or {code,message,kind}.
function readError(e) {
    if (!e)
        return null;
    return typeof e === 'object'
        ? String(e.message ?? JSON.stringify(e))
        : String(e);
}

export default class CodexBarProvider {
    id = 'codexbar';
    name = 'CodexBar 桥接';
    bridge = true;

    buildRequest(cfg) {
        // Only used by the http transport; cli mode goes through cliArgs().
        // codexbar serve gates /dashboard/v1/snapshot with a bearer token
        // (argv/env only — it is not part of codexbar's config.json) and fails
        // closed with 401 when no token was configured server-side.
        const token = (cfg.token || '').trim();
        return {
            uri: cfg.url,
            headers: token ? { Authorization: `Bearer ${token}` } : {},
        };
    }

    cliArgs(cfg) {
        // Stdout carries only the snapshot JSON; CodexBar logs to stderr.
        const cmd = (cfg.command || 'codexbar').trim() || 'codexbar';
        return [cmd, 'dashboard'];
    }

    parse(status, body, cfg, skipIds) {
        return this.parseSnapshot(status, body, cfg, skipIds ?? new Set());
    }

    // skipIds: normalized ids of enabled direct providers; bridge cards for the
    // same service are dropped (direct data wins).
    parseSnapshot(status, body, cfg, skipIds) {
        if (status === 401 || status === 403)
            return { ok: false, kind: 'auth', error: '快照接口要求访问令牌 (HTTP 401/403)：填入 codexbar serve 的 --dashboard-token / CODEXBAR_DASHBOARD_TOKEN，或改用 CLI 模式' };
        if (status === 404)
            return { ok: false, error: '快照地址无响应 (HTTP 404)，请确认 codexbar serve 已启动且路径为 /dashboard/v1/snapshot' };
        if (status !== 200)
            return { ok: false, error: `HTTP ${status}` };

        let data;
        try {
            data = JSON.parse(body);
        } catch (_) {
            return { ok: false, error: '快照不是合法 JSON' };
        }
        if (data.schemaVersion !== 1 || !Array.isArray(data.providers))
            return { ok: false, error: `不支持的快照格式 (schemaVersion=${data.schemaVersion})` };

        const cards = [];
        const staleAfter = num(data.staleAfterSeconds);
        for (const pv of data.providers) {
            if (!pv || typeof pv !== 'object' || pv.enabled === false)
                continue;
            const id = String(pv.id ?? '');
            if (!id || skipIds.has(id))
                continue;
            const card = { id, name: String(pv.name ?? pv.displayName ?? id) };
            if (typeof pv.display?.accentColor === 'string')
                card.accent = pv.display.accentColor;
            const plan = pv.identity?.plan ?? pv.plan ?? pv.tier;
            if (plan)
                card.badge = String(plan);

            card.windows = readWindows(pv.windows);
            if (typeof pv.updatedAt === 'string')
                card.updatedAt = pv.updatedAt;

            if (!card.windows.length && Array.isArray(pv.accounts)) {
                // Multi-account integrations (claude-swap) can keep usage only on
                // the account rows; the ambient row stays empty for a non-active
                // slot, so fall back to the active account rather than showing blank.
                const acc = pv.accounts.find(a => a && a.active === true)
                    ?? pv.accounts.find(a => a && typeof a === 'object');
                if (acc) {
                    card.windows = readWindows(acc.windows);
                    card.updatedAt ??= typeof acc.updatedAt === 'string' ? acc.updatedAt : null;
                    card.note = readError(acc.error);
                }
            }

            const credits = pv.credits && typeof pv.credits === 'object' ? pv.credits : null;
            const rem = credits ? num(credits.remaining) : null;
            if (rem !== null)
                card.credits = { remaining: rem, unit: String(credits.unit ?? '') };
            if (pv.cost && num(pv.cost.todayUSD) !== null)
                card.todayUSD = num(pv.cost.todayUSD);
            card.error = readError(pv.error);
            if (!card.error && typeof pv.accountsError === 'string')
                card.note ??= pv.accountsError;
            if (staleAfter !== null)
                card.staleAfter = staleAfter;

            if (card.windows.length || card.credits || card.error || card.todayUSD !== undefined)
                cards.push(card);
        }

        return {
            ok: true,
            cards,
            generatedAt: typeof data.generatedAt === 'string' ? data.generatedAt : null,
        };
    }
}
