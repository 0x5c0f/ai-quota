// Generic provider: user supplies the full query URL, a currency, and dotted
// JSON paths that map the response onto the three displayed fields.
// Paths support array indices, e.g. "data.balance_infos.0.total_balance".

function getPath(obj, path) {
    let cur = obj;
    for (const seg of path.split('.')) {
        if (cur === null || cur === undefined)
            return null;
        cur = cur[seg];
    }
    return cur === undefined ? null : cur;
}

export default class GenericProvider {
    id = 'custom';
    name = '自定义';
    logo = { color: '#00b0ff' }; // no text: the card shows the user's own name initial
    defaultBaseUrl = '';

    // Only render a card once the user has named it or given it a URL.
    visible(cfg) {
        return !!(cfg.url || cfg.name);
    }

    buildRequest(cfg) {
        return {
            uri: cfg.url,
            headers: { Authorization: `Bearer ${cfg.api_key}` },
        };
    }

    parse(status, body, cfg) {
        if (status === 401 || status === 403)
            return { ok: false, kind: 'auth', error: '密钥无效 (HTTP 401/403)' };
        if (status !== 200)
            return { ok: false, error: `HTTP ${status}` };

        let data;
        try {
            data = JSON.parse(body);
        } catch (e) {
            return { ok: false, error: '响应不是合法 JSON' };
        }

        if (!cfg.map_total)
            return { ok: false, error: '未配置「余额」映射路径' };

        // Returns a number, or null when the path is unset (field then hidden).
        const num = path => {
            if (!path)
                return null;
            const v = getPath(data, path);
            if (v === null)
                return null;
            const n = typeof v === 'number' ? v : parseFloat(v);
            return Number.isFinite(n) ? n : null;
        };

        const total = num(cfg.map_total);
        if (total === null)
            return { ok: false, error: `「余额」路径无有效数值: ${cfg.map_total}` };

        // Currency is a returned value, not something we send: read it from the
        // response via map-currency; unset/missing falls back to CNY.
        let currency = 'CNY';
        if (cfg.map_currency) {
            const c = getPath(data, cfg.map_currency);
            if (typeof c === 'string' && c.trim())
                currency = c.trim();
            else if (typeof c === 'number')
                currency = String(c);
        }

        return {
            ok: true,
            entries: [{
                currency,
                total,
                granted: num(cfg.map_granted),
                toppedUp: num(cfg.map_topped_up),
            }],
        };
    }
}
