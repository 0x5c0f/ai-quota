// CodexBar bridge provider: consumes the versioned dashboard-v1 snapshot
// produced by the external CodexBar tool (https://github.com/steipete/CodexBar).
// Two transports, chosen by cfg.mode:
//   http -> GET cfg.url (a running `codexbar serve`)
//   cli  -> run `cfg.command dashboard --output <tmpfile>` once per refresh
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
    weekly: '周',
    week: '周',
    daily: '日',
    monthly: '月',
    month: '月',
};

function windowLabel(w) {
    if (w.label)
        return String(w.label);
    let label = KIND_LABELS[w.kind] ?? (w.kind ? String(w.kind) : '窗口');
    const mins = num(w.windowMinutes);
    if (mins && !KIND_LABELS[w.kind])
        label = `${label}（${Math.round(mins / 60)} 小时）`;
    else if (mins && w.kind === 'session' && mins !== 300)
        label = `会话（${Math.round(mins / 60)} 小时）`;
    return label;
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

    cliArgs(cfg, tmpPath) {
        const cmd = (cfg.command || 'codexbar').trim() || 'codexbar';
        return [cmd, 'dashboard', '--output', tmpPath];
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

            const windows = Array.isArray(pv.windows) ? pv.windows : [];
            card.windows = [];
            for (const w of windows) {
                if (!w || typeof w !== 'object')
                    continue;
                let remaining = num(w.remainingPercent);
                const used = num(w.usedPercent);
                if (remaining === null && used !== null)
                    remaining = 100 - used;
                if (remaining === null)
                    continue; // absent is not zero
                card.windows.push({
                    label: windowLabel(w),
                    remaining: Math.max(0, Math.min(100, remaining)),
                    resetAt: typeof w.resetAt === 'string' ? w.resetAt : null,
                });
            }

            const credits = pv.credits && typeof pv.credits === 'object' ? pv.credits : null;
            const rem = credits ? num(credits.remaining) : null;
            if (rem !== null)
                card.credits = { remaining: rem, unit: String(credits.unit ?? '') };
            if (pv.cost && num(pv.cost.todayUSD) !== null)
                card.todayUSD = num(pv.cost.todayUSD);
            // Real snapshots carry row-level errors as {code,message,kind}.
            let err = null;
            if (pv.error) {
                err = typeof pv.error === 'object'
                    ? String(pv.error.message ?? JSON.stringify(pv.error))
                    : String(pv.error);
            }
            card.error = err;

            if (card.windows.length || card.credits || card.error || card.todayUSD !== undefined)
                cards.push(card);
        }

        return { ok: true, cards, generatedAt: typeof data.generatedAt === 'string' ? data.generatedAt : null };
    }
}
