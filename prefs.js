import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Keep in sync with PROVIDERS in extension.js and <child> entries in the schema.
const PROVIDERS = [
    { id: 'deepseek', name: 'DeepSeek', defaultBaseUrl: 'https://api.deepseek.com' },
    { id: 'kimi', name: 'Kimi', defaultBaseUrl: 'https://api.moonshot.cn' },
];

export default class ApiBalancePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        // Keep settings local: the prefs object must not retain window-scoped
        // objects (EGO-L-006).
        const settings = this.getSettings();
        window.set_default_size(560, 520);

        const page = new Adw.PreferencesPage();
        window.add(page);

        this._buildGeneralGroup(page, settings);
        this._buildProvidersGroup(page, settings);
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
                strings: ['单显（仅显示第一个置顶后端）', '轮播（在多个置顶后端间切换）'],
            }),
        });
        combo.set_selected(settings.get_string('topbar-display') === 'carousel' ? 1 : 0);
        combo.connect('notify::selected', () => {
            settings.set_string('topbar-display', combo.get_selected() === 1 ? 'carousel' : 'single');
        });
        group.add(combo);
    }

    _buildProvidersGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: '后端',
            description: '点击展开以配置各后端的 API 密钥与地址',
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
