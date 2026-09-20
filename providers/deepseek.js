const SYMBOLS = { CNY: '¥', USD: '$' };

export function fmtAmount(currency, value) {
    const sym = SYMBOLS[currency] ?? `${currency} `;
    return `${sym}${value.toFixed(2)}`;
}

export default class DeepSeekProvider {
    id = 'deepseek';
    name = 'DeepSeek';
    defaultBaseUrl = 'https://api.deepseek.com';

    buildRequest(cfg) {
        return {
            uri: `${(cfg.base_url || this.defaultBaseUrl).replace(/\/+$/, '')}/user/balance`,
            headers: { Authorization: `Bearer ${cfg.api_key}` },
        };
    }

    parse(status, body) {
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

        if (data.is_available !== true)
            return { ok: false, kind: 'unavail', error: '接口返回 is_available=false（免费额度耗尽或额度服务停用）' };

        const list = Array.isArray(data.balance_infos) ? data.balance_infos : [];
        const entries = list.map(b => ({
            currency: String(b.currency ?? '?'),
            total: parseFloat(b.total_balance) || 0,
            granted: parseFloat(b.granted_balance) || 0,
            toppedUp: parseFloat(b.topped_up_balance) || 0,
        }));
        if (!entries.length)
            return { ok: false, error: '无余额信息' };

        return { ok: true, entries };
    }
}
