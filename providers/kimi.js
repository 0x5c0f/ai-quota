export default class KimiProvider {
    id = 'kimi';
    name = 'Kimi';
    defaultBaseUrl = 'https://api.moonshot.cn';

    buildRequest(cfg) {
        return {
            uri: `${(cfg.base_url || this.defaultBaseUrl).replace(/\/+$/, '')}/v1/users/me/balance`,
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

        if (data.status !== true || data.code !== 0)
            return { ok: false, kind: 'unavail', error: `接口返回异常 (code=${data.code} status=${data.status})` };

        const d = data.data;
        if (!d || typeof d.available_balance !== 'number')
            return { ok: false, error: '无余额信息' };

        return {
            ok: true,
            entries: [{
                currency: 'CNY',
                total: d.available_balance || 0,
                toppedUp: d.cash_balance || 0,
                granted: d.voucher_balance || 0,
            }],
        };
    }
}
