import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Direct providers with an api-key; keep in sync with buildProviders() in
// extension.js and the <child> entries in the schema. The custom provider is
// not listed here — its card is built from its own child schema.
const PROVIDERS = [
    { id: 'deepseek', name: 'DeepSeek', defaultBaseUrl: 'https://api.deepseek.com' },
];

export default class ApiBalancePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        // Keep settings local: the prefs object must not retain window-scoped
        // objects (EGO-L-006).
        const settings = this.getSettings();
        window.set_default_size(560, 520);

        const page = new Adw.PreferencesPage();
        window.add(page);

        this._buildBridgeGroup(page, settings);
        this._buildProvidersGroup(page, settings);
        this._buildGeneralGroup(page, settings);
    }

    _buildBridgeGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: '桥接层',
            description: '配额数据由第三方工具 CodexBar 采集与维护（约 70 家服务商），密钥存储于其自身配置（~/.config/codexbar/），本扩展不直接接触这些密钥。需本机安装并运行 CodexBar。',
        });
        page.add(group);

        const bs = settings.get_child('codexbar');
        const expander = new Adw.ExpanderRow({ title: 'CodexBar 桥接' });

        const enableRow = new Adw.SwitchRow({
            title: '启用桥接',
            subtitle: '停用后面板不出现桥接卡片',
        });
        bs.bind('enabled', enableRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        expander.add_row(enableRow);

        const pinRow = new Adw.SwitchRow({
            title: '在顶栏显示（置顶）',
            subtitle: '顶栏展示所有桥接窗口中最紧张的一个（剩余百分比）',
        });
        bs.bind('pinned', pinRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        expander.add_row(pinRow);

        const modeRow = new Adw.ComboRow({
            title: '连接模式',
            subtitle: 'HTTP：读取 codexbar serve 的快照接口（需访问令牌）；CLI：每次刷新执行一次 codexbar dashboard，直接读其自身配置、无需令牌',
            model: new Gtk.StringList({
                strings: ['HTTP（codexbar serve）', 'CLI（一次性命令）'],
            }),
        });
        modeRow.set_selected(bs.get_string('mode') === 'cli' ? 1 : 0);
        modeRow.connect('notify::selected', () => {
            bs.set_string('mode', modeRow.get_selected() === 1 ? 'cli' : 'http');
        });
        expander.add_row(modeRow);

        const urlRow = new Adw.EntryRow({ title: '快照地址' });
        urlRow.set_tooltip_text('HTTP 模式下的 dashboard-v1 snapshot 完整 URL');
        bs.bind('url', urlRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        expander.add_row(urlRow);

        const tokenRow = new Adw.EntryRow({ title: '访问令牌' });
        tokenRow.set_tooltip_text('HTTP 模式专用：codexbar serve 的 --dashboard-token / CODEXBAR_DASHBOARD_TOKEN，未设置时该接口一律返回 401');
        bs.bind('token', tokenRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        expander.add_row(tokenRow);

        const cmdRow = new Adw.EntryRow({ title: 'CLI 命令' });
        cmdRow.set_tooltip_text('CLI 模式下执行的命令，默认在 PATH 中查找 codexbar');
        bs.bind('command', cmdRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        expander.add_row(cmdRow);

        const updateSummary = () => {
            const enabled = bs.get_boolean('enabled');
            const bits = [
                enabled ? '已启用' : '已停用',
                bs.get_boolean('pinned') ? '已置顶' : '未置顶',
                bs.get_string('mode') === 'cli' ? 'CLI' : 'HTTP',
            ];
            expander.set_subtitle(bits.join(' · '));
            pinRow.set_sensitive(enabled);
        };
        updateSummary();
        bs.connect('changed', () => updateSummary());

        group.add(expander);
    }

    _buildGeneralGroup(page, settings) {
        const group = new Adw.PreferencesGroup({ title: '常规' });
        page.add(group);

        const minsNow = Math.max(1, Math.round(settings.get_int('refresh-interval') / 60));
        const spinRow = Adw.SpinRow.new_with_range(1, 1440, 1);
        spinRow.set_title('自动刷新间隔（分钟）');
        spinRow.set_digits(0);
        spinRow.set_value(minsNow);
        spinRow.connect('notify::value', () => {
            const mins = Math.max(1, Math.round(spinRow.get_value()));
            settings.set_int('refresh-interval', mins * 60);
        });
        group.add(spinRow);

        const combo = new Adw.ComboRow({
            title: '顶栏显示',
            subtitle: '多个后端同时置顶时顶栏如何显示；展开面板始终列出全部后端',
            model: new Gtk.StringList({
                strings: ['单显（置顶项并列显示）', '轮播（在多个置顶后端间切换）'],
            }),
        });
        combo.set_selected(settings.get_string('topbar-display') === 'carousel' ? 1 : 0);
        combo.connect('notify::selected', () => {
            settings.set_string('topbar-display', combo.get_selected() === 1 ? 'carousel' : 'single');
        });
        group.add(combo);

        const winCombo = new Adw.ComboRow({
            title: '配额窗口显示方式',
            subtitle: '桥接/套餐类服务的用量窗口（如 5 小时、周）在卡片中的呈现',
            model: new Gtk.StringList({
                strings: ['进度条 + 重置时间', '仅文字'],
            }),
        });
        winCombo.set_selected(settings.get_string('window-display') === 'text' ? 1 : 0);
        winCombo.connect('notify::selected', () => {
            settings.set_string('window-display', winCombo.get_selected() === 1 ? 'text' : 'bar');
        });
        group.add(winCombo);

        const themeModes = ['auto', 'dark', 'light'];
        const themeCombo = new Adw.ComboRow({
            title: '面板配色',
            subtitle: '面板为自绘配色，不跟随第三方 GTK 主题；「自动」仅跟随系统的深/浅设置。顶栏文字始终跟随顶栏本身，不受此项影响',
            model: new Gtk.StringList({
                strings: ['自动（跟随系统深/浅色）', '始终暗色', '始终亮色'],
            }),
        });
        themeCombo.set_selected(Math.max(0, themeModes.indexOf(settings.get_string('theme-mode'))));
        themeCombo.connect('notify::selected', () => {
            settings.set_string('theme-mode', themeModes[themeCombo.get_selected()] ?? 'auto');
        });
        group.add(themeCombo);
    }

    _buildProvidersGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: '直连服务',
            description: '扩展直接请求服务商官方接口，密钥保存在 GSettings 中',
        });
        page.add(group);
        for (const p of PROVIDERS)
            group.add(this._buildProviderExpander(p, settings));
        group.add(this._buildCustomExpander(settings));
    }

    _buildProviderExpander(p, settings) {
        const ps = settings.get_child(p.id.replace(/-/g, '_'));

        const expander = new Adw.ExpanderRow({ title: p.name });

        const pinRow = new Adw.SwitchRow({
            title: '在顶栏显示（置顶）',
            subtitle: '仅「已启用且置顶」的后端显示在顶栏，其余只在展开面板中查看',
        });
        ps.bind('pinned', pinRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        expander.add_row(pinRow);

        const enableRow = new Adw.SwitchRow({
            title: '启用查询',
            subtitle: '停用后不再请求，面板显示为已停用',
        });
        ps.bind('enabled', enableRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        expander.add_row(enableRow);

        const keyRow = new Adw.PasswordEntryRow({ title: 'API Key' });
        ps.bind('api-key', keyRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        expander.add_row(keyRow);

        const updateSummary = () => {
            const enabled = ps.get_boolean('enabled');
            const bits = [
                enabled ? '已启用' : '已停用',
                ps.get_boolean('pinned') ? '已置顶' : '未置顶',
                ps.get_string('api-key') ? '已设密钥' : '缺少密钥',
            ];
            expander.set_subtitle(bits.join(' · '));
            pinRow.set_sensitive(enabled);
        };
        updateSummary();
        ps.connect('changed', () => updateSummary());

        return expander;
    }

    _buildCustomExpander(settings) {
        const cs = settings.get_child('custom');
        const expander = new Adw.ExpanderRow({ title: '自定义' });

        const pinRow = new Adw.SwitchRow({
            title: '在顶栏显示（置顶）',
            subtitle: '仅「已启用且置顶」的后端显示在顶栏，其余只在展开面板中查看',
        });
        cs.bind('pinned', pinRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        expander.add_row(pinRow);

        const enableRow = new Adw.SwitchRow({
            title: '启用查询',
            subtitle: '停用后不再请求，面板显示为已停用',
        });
        cs.bind('enabled', enableRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        expander.add_row(enableRow);

        const nameRow = new Adw.EntryRow({ title: '名称' });
        nameRow.set_tooltip_text('显示名，例如 DeepSeek');
        cs.bind('name', nameRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        expander.add_row(nameRow);

        const keyRow = new Adw.PasswordEntryRow({ title: 'API Key' });
        cs.bind('api-key', keyRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        expander.add_row(keyRow);

        const urlRow = new Adw.EntryRow({ title: '余额查询 URL' });
        urlRow.set_tooltip_text('完整地址，直接请求，不再拼接任何路径');
        cs.bind('url', urlRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        expander.add_row(urlRow);

        const currencyRow = new Adw.EntryRow({ title: '「货币」映射路径' });
        currencyRow.set_tooltip_text('从响应读取货币代码，如 balance_infos.0.currency；留空默认 CNY');
        cs.bind('map-currency', currencyRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        expander.add_row(currencyRow);

        const totalRow = new Adw.EntryRow({ title: '「余额」映射路径' });
        totalRow.set_tooltip_text('JSON 点路径，支持数组下标，如 data.balance 或 list.0.total');
        cs.bind('map-total', totalRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        expander.add_row(totalRow);

        const grantedRow = new Adw.EntryRow({ title: '「赠送」映射路径' });
        grantedRow.set_tooltip_text('可留空，留空则不显示该行');
        cs.bind('map-granted', grantedRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        expander.add_row(grantedRow);

        const toppedRow = new Adw.EntryRow({ title: '「充值」映射路径' });
        toppedRow.set_tooltip_text('可留空，留空则不显示该行');
        cs.bind('map-topped-up', toppedRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        expander.add_row(toppedRow);

        const updateSummary = () => {
            const enabled = cs.get_boolean('enabled');
            expander.set_title(cs.get_string('name').trim() || '自定义');
            const bits = [
                enabled ? '已启用' : '已停用',
                cs.get_boolean('pinned') ? '已置顶' : '未置顶',
                cs.get_string('url').trim() ? '已设地址' : '缺少地址',
                cs.get_string('api-key') ? '已设密钥' : '缺少密钥',
            ];
            expander.set_subtitle(bits.join(' · '));
            pinRow.set_sensitive(enabled);
        };
        updateSummary();
        cs.connect('changed', () => updateSummary());

        return expander;
    }
}
