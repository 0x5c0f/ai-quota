# Repository Guidelines

## Project Structure & Module Organization

这是一个 GNOME Shell 扩展仓库。核心运行时代码在根目录：`extension.js` 负责顶栏指示器、余额刷新和面板 UI，`prefs.js` 负责扩展设置窗口，`stylesheet.css` 存放样式，`metadata.json` 定义扩展元数据。服务商逻辑放在 `providers/`，例如 `deepseek.js`、`kimi.js`、`generic.js`，以及桥接型 provider `codexbar.js`。GSettings schema 位于 `schemas/`，截图等文档资产位于 `docs/`。发布流水线在 `.github/workflows/release.yml`。

## Build, Test, and Development Commands

- `glib-compile-schemas schemas/`：本地编译 GSettings schema，适合快速检查 XML 是否可用。
- `glib-compile-schemas --strict --targetdir=$(mktemp -d) schemas/`：按 CI 方式严格校验 schema。
- `for f in extension.js prefs.js providers/*.js; do cp "$f" /tmp/check.mjs && node --check /tmp/check.mjs; done`：检查所有 JavaScript 模块语法。
- `gnome-extensions pack -f --extra-source=providers .`：使用 GNOME 工具打包扩展。
- `zip -r api-balance@tools.0x5c0f.cc.zip metadata.json extension.js prefs.js stylesheet.css schemas/*.xml providers/*.js`：手动生成发布 zip。

## Coding Style & Naming Conventions

JavaScript 使用 ES modules、4 空格缩进和分号。类名使用 `PascalCase`，函数和局部变量使用 `camelCase`，GNOME/GObject 私有状态沿用 `_fieldName` 风格。变更 provider 响应结构时，同时更新错误提示和文档示例。schema key 与设置代码保持语义一致，避免只改一侧。

gjs/GNOME 46 实测陷阱（均已踩过）：

- ISO 时间用 `GLib.DateTime.new_from_iso8601(str, null)`，本平台没有 `new_from_iso8601_string`。
- `St.DrawingArea` 自身请求高度为 0，也没有 `request_height`/`set_content_height`：进度条要把 `DrawingArea` 放进一个 CSS 固定高度的 `St.BoxLayout` 容器（与 `.ab-sep` 同法），并设 `x_expand`/`y_expand`。
- `area.get_surface_size()` 返回 `[width, height]` 两个值，不是四个。
- 子进程判错用 `get_exit_status() !== 0`（无 `if_success()`）；临时文件名用 `GLib.get_monotonic_time()` 生成（`GLib.get_pid` 不存在），先读文件再删除。

新增 provider 需同步五处（漏一处，设置界面或打包校验就会坏）：

1. `providers/<id>.js` 导出默认 provider 类，并在 `extension.js` 的 `buildProviders()` 注册（按面板实例化，勿在模块加载时 `new`）。
2. 新建子 schema 文件（见下节），并在主 schema 中加 `<child>` 声明。
3. `prefs.js` 顶部的 provider 列表加入条目。
4. `.github/workflows/release.yml` 中 verify-zip 的硬编码文件清单。
5. `README.md` 与 `README.en.md` 的 provider 表格。

## Provider 接口约定

直连型 provider：字段 `id`/`name`/`defaultBaseUrl`，可选 `visible(cfg)`；`buildRequest(cfg) → {uri, headers}`；`parse(status, body, cfg) → {ok:true, entries:[{currency,total,granted,toppedUp}]}` 或 `{ok:false, kind?, error}`（401/403 用 `kind:'auth'`）。`cfg` 来自该 provider 子 schema（`enabled`/`pinned`/`api-key`）。

桥接型 provider（现有仅 `codexbar.js`）与直连型不同，新增同类 provider 时注意：

- 类上带 `bridge = true`，`extension.js` 的 `_fetchAll` 走独立分支，不经 `defaultBaseUrl`。
- 子 schema 没有 `api-key`，改为传输配置：`mode`（默认 `cli`）、`url`、`token`、`command`；`prefs.js` 中它属于「桥接层」分组，不进 provider 列表。
- 两种传输：HTTP 用 `buildRequest(cfg)`（GET `cfg.url`，带 `Authorization: Bearer <token>`）；CLI 用 `cliArgs(cfg, tmpPath)`（`extension.js` 以 `Gio.Subprocess` 执行、读临时文件后删除，用 `get_exit_status()` 判错——`if_success()` 在 gjs 中不存在）。
  注意：`codexbar serve` 的 `/dashboard/v1/snapshot` 强制令牌鉴权，**未设令牌也一律 401**（fail-closed），且令牌只能走 `--dashboard-token`/`CODEXBAR_DASHBOARD_TOKEN`，不在 codexbar 的 config.json 里；CLI 模式直接读 `~/.config/codexbar/config.json`，无需任何额外配置，故为默认。
- `parse(status, body, cfg, skipIds)` 返回 `{ok:true, cards, generatedAt}` 而非 `entries`；`cards` 每项为 `{id,name,badge?,windows,credits?,todayUSD?,error?}`，`windows` 每项为 `{label,remaining,resetAt}`（`remaining` 由快照 `remainingPercent` 或 `100-usedPercent` 推出并夹到 0–100，两者都缺就跳过该窗口）。
- 真实快照的形状差异（已按实测适配，勿改回）：套餐名在 `identity.plan` 而非顶层 `plan`；行级 `error` 是 `{code,message,kind}` 对象（取 `message`）；行上有 `enabled` 字段（`false` 时跳过）；`cost.todayUSD` 可以单独存在（无窗口无额度也是有效卡片）。
- 顶栏兜底：桥接置顶时取最紧窗口，快照里没有任何窗口则退回额度或今日费用（否则纯计费类服务商会让顶栏沉默）。
- `skipIds` 是已启用直连 provider 的 id 集合：快照中同 id 的桥接卡片必须丢弃，以直连数据为准。

## GSettings 与 EGO 审核约束

- `schemas/`：一个文件只放一个 schema，文件名必须等于 schema id，每个 schema 都要显式 `path`（子 schema 用父 path + 子名）。不要合并 schema 文件——曾因此被 EGO 打回。
- provider 的 `id` 必须与子 schema 名对应（`get_child` 会把 `-` 转成 `_`）。
- `prefs.js`：prefs 对象不得把窗口期对象挂在 `this` 上（EGO-L-006），`settings` 用局部变量/参数传递。

## Testing Guidelines

当前没有单元测试框架；提交前至少运行 schema 校验和 JavaScript 语法检查。涉及 UI、刷新逻辑或 provider 响应解析时，先在嵌套 Xephyr 会话验证：隔离 XDG 目录拷入扩展、启动 `gnome-shell --x11`、确认日志无 `JS ERROR`，再考虑装入 live shell（GNOME Shell 45-50 需逐一手动过：启用扩展、`gnome-extensions prefs api-balance@tools.0x5c0f.cc`、手动刷新与错误状态）——未验证代码直接进 live shell，崩溃会拖垮整个桌面会话。嵌套会话已知限制：GNOME 46 禁止经 gdbus 调用 `Shell.Eval`（返回 `(false,'')`），设置窗口需手动打开；弹窗在 Xephyr 下贴不住顶栏，用 `box.translation_y`（Clutter 属性，无 `set_translation_y`）调整。

## Commit & Pull Request Guidelines

Git 历史目前较短，已有 `docs: ...` 这类前缀；建议继续使用简洁的 Conventional Commit 风格，如 `fix: handle empty custom URL`、`docs: update install steps`。PR 应包含变更摘要、验证命令结果、相关 issue 链接，并说明是否影响 GNOME Shell 版本兼容性；若调整面板或设置窗口，请附截图或录屏。不要在提交中包含真实 API Key、dconf 导出或本地打包产物，除非发布流程明确需要。

## Documentation & Release Notes

面向用户的行为变化应同步更新 `README.md` 和 `README.en.md`。新增截图放入 `docs/`，并使用相对路径引用。发布相关改动应对照 `.github/workflows/release.yml`，确认 zip 内容仍只包含扩展运行所需文件，作为 release checklist 和 CI package validation。Release 仅由 `v*` tag 推送触发 CI 打包，文档类提交不打卡片；`metadata.json` 的 `version` 只在向 extensions.gnome.org 上传新版本时递增，与 git tag 无关。

## Security & Configuration Tips

API Key 保存在 GNOME GSettings/dconf 中，通常不是加密存储。开发和测试时使用低权限密钥，避免把生产密钥写入 README、截图、日志或测试数据。自定义 provider 应优先要求 HTTPS，并继续使用 `Authorization: Bearer <API Key>` 的请求约定。桥接层不保存第三方密钥：各服务商密钥由本机 CodexBar 自行管理，扩展只读取其快照。
