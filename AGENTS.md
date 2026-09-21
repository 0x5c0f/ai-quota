# Repository Guidelines

## Project Structure & Module Organization

这是一个 GNOME Shell 扩展仓库。核心运行时代码在根目录：`extension.js` 负责顶栏指示器、余额刷新和面板 UI，`prefs.js` 负责扩展设置窗口，`stylesheet.css` 存放样式，`metadata.json` 定义扩展元数据。服务商逻辑放在 `providers/`，例如 `deepseek.js`、`generic.js`，以及桥接型 provider `codexbar.js`。GSettings schema 位于 `schemas/`，截图等文档资产位于 `docs/`。发布流水线在 `.github/workflows/release.yml`。

## Build, Test, and Development Commands

- `glib-compile-schemas schemas/`：本地编译 GSettings schema，适合快速检查 XML 是否可用。产物 `schemas/gschemas.compiled` 是构建产物（已 gitignore，不进 zip），别提交。
- `glib-compile-schemas --strict --targetdir=$(mktemp -d) schemas/`：按 CI 方式严格校验 schema。
- `for f in extension.js prefs.js providers/*.js; do cp "$f" /tmp/check.mjs && node --check /tmp/check.mjs; done`：检查所有 JavaScript 模块语法。
- `gnome-extensions pack -f --extra-source=providers .`：使用 GNOME 工具打包扩展。
- `zip -r ai-quota@tools.0x5c0f.cc.zip metadata.json extension.js prefs.js stylesheet.css schemas/*.xml providers/*.js`：手动生成发布 zip。

## Coding Style & Naming Conventions

JavaScript 使用 ES modules、4 空格缩进和分号。类名使用 `PascalCase`，函数和局部变量使用 `camelCase`，GNOME/GObject 私有状态沿用 `_fieldName` 风格。变更 provider 响应结构时，同时更新错误提示和文档示例。schema key 与设置代码保持语义一致，避免只改一侧。

gjs/GNOME 46 实测陷阱（均已踩过）：

- ISO 时间用 `GLib.DateTime.new_from_iso8601(str, null)`，本平台没有 `new_from_iso8601_string`。
- `St.DrawingArea` 自身请求高度为 0，也没有 `request_height`/`set_content_height`：进度条要把 `DrawingArea` 放进一个 CSS 固定高度的 `St.BoxLayout` 容器（与 `.ab-sep` 同法），并设 `x_expand`/`y_expand`。
- `area.get_surface_size()` 返回 `[width, height]` 两个值，不是四个。
- 子进程判错用 `get_exit_status() !== 0`（无 `if_success()`）。读子进程输出用 `communicate_utf8_async()`（gjs 未暴露 `get_communicator()`，只有 `get_stdout_pipe()`）：`communicate_utf8_finish()` 返回 `[ok, stdout, stderr]` 且已回收进程，回调里可直接取退出码；必须同时给 `STDOUT_PIPE|STDERR_PIPE` 两个 flag，否则 stdout/stderr 为空。`Gio.MemoryOutputStream` 没有 `dynamic` 属性，构造用 `Gio.MemoryOutputStream.new_resizable()`。
- GNOME 46 的 `St.BoxLayout` 没有 `spacing` 属性：构造时传 `spacing: 6` 会抛 `No property spacing on StBoxLayout`，间距一律写在 CSS 类里。
- 面板自绘样式：`this.menu.box` 本身就带主题的 `popup-menu-content` 类（没有单独的外层容器），覆盖主题规则要用复合选择器 `.popup-menu-content.ab-popup`（靠特异性取胜，不依赖加载顺序）。快照里的 `display.accentColor` 会进 CSS 字符串，必须先按 `^#[0-9a-fA-F]{6}$` 白名单校验再用。
- St 的 CSS 不支持自定义属性（`var(--x)` 无解）：浅色调色板只能给暗色默认规则逐条写 `.ab-light` 覆盖，只覆盖带颜色的属性、布局与字号共用。
- 深浅两套配色挂在**两棵不同的 actor 树**上：弹层用 `this.menu.box`，顶栏用按钮自身，二者都要挂 `ab-light` 才能被 `.ab-light X` 后代选择器命中（St 支持后代选择器，`gnome-shell.css` 里大量在用）。
- 顶栏指示文字**不能**按 `color-scheme` 决定明暗：shell 顶栏背景由 shell 主题自己决定，Yaru 在浅色模式下仍是深色 bar。可靠信号是按钮继承来的主题色 `this.get_theme_node().get_color('color')`（实测 242,242,242,255）；`Main.panel` 自己的节点返回 `0,0,0,0`（未设色），别用它。
- 进度条底槽颜色画在 cairo（`cr.setSourceRGBA`）里，CSS 到不了：切换调色板时必须重绘，`_applyPalette()` 换类后要 `_renderCards()`。

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
- 两种传输：HTTP 用 `buildRequest(cfg)`（GET `cfg.url`，带 `Authorization: Bearer <token>`）；CLI 用 `cliArgs(cfg)`（`extension.js` 以 `Gio.Subprocess` 执行，快照从标准输出读取，用 `get_exit_status()` 判错——`if_success()` 在 gjs 中不存在）。不写临时文件：shexli 会报 `EGO-X-004` 同步文件 IO 警告，且 `--output` 落的是 0644、里面带账号邮箱。
  注意：`codexbar serve` 的 `/dashboard/v1/snapshot` 强制令牌鉴权，**未设令牌也一律 401**（fail-closed），且令牌只能走 `--dashboard-token`/`CODEXBAR_DASHBOARD_TOKEN`，不在 codexbar 的 config.json 里；CLI 模式直接读 `~/.config/codexbar/config.json`，无需任何额外配置，故为默认。
- 设置窗口里传输字段按 `mode` 互斥显示（`prefs.js` 的 `updateSummary()` 统一驱动）：CLI 只留「CLI 命令」，HTTP 只留「快照地址」+「访问令牌」，另一侧 `visible=false` 但值仍留在 GSettings。运行时本来只读一侧，所以这是纯显示逻辑；新增同类字段务必挂进 `updateSummary()`，别留常年无效的输入框。
- `parse(status, body, cfg, skipIds)` 返回 `{ok:true, cards, generatedAt}` 而非 `entries`；`cards` 每项为 `{id,name,badge?,windows,credits?,todayUSD?,error?,note?,updatedAt?,staleAfter?}`，`windows` 每项为 `{label,remaining,resetAt}`（`remaining` 由快照 `remainingPercent` 或 `100-usedPercent` 推出并夹到 0–100，两者都缺就跳过该窗口）。
- 兼容性规则（只在我们这侧兜住，不向上游提要求）：`w.idle === true` 的窗口必须丢弃（上游文档与内置 Web UI 同此处理，键只在为真时出现）；`kind` 是开放词表（生产者把 `NamedRateWindow.id` 原样传出来，如 `kimi-monthly`），未知 `kind` 走 `KIND_LABELS` 兜底标签「配额窗口」，绝不把裸 id 渲染进面板，有 `windowMinutes` 时按时长标注；行 `windows` 为空且有 `accounts` 时取活动账号（`active === true`，否则第一个对象）的窗口与 `updatedAt`；`accountsError` 是整体采集失败的诊断，只作为 `note` 中性提示行显示，不标错误状态、不影响 `skipIds` 判定；`updatedAt` 超过顶层 `staleAfterSeconds` 时由 `extension.js` 打「N 分/小时前更新」灰标签（`GLib` 只在 UI 层用，provider 保持纯函数）。
- 计费型服务商（DeepSeek/OpenRouter…）在快照里往往只有一个 100% 的占位窗口（`label: "Balance"`）、`credits`/`cost` 全为 null —— 金额只存在于上游的 `resetDescription` 人读字符串里，`makeWindow` 不投影它。不要为此解析 `resetDescription`（`/usage` 无版本、无鉴权、易碎）；README 已把边界写死：看余额用直连服务商。
- 真实快照的形状差异（已按实测适配，勿改回）：套餐名在 `identity.plan` 而非顶层 `plan`；行级 `error` 是 `{code,message,kind}` 对象（取 `message`）；行上有 `enabled` 字段（`false` 时跳过）；`cost.todayUSD` 可以单独存在（无窗口无额度也是有效卡片）。窗口可能完全没有 `label`（旧生产者只给 `kind`/`usedPercent`/`remainingPercent`/`resetAt`/`windowMinutes`），所以 `KIND_LABELS` 是实际生效的文案来源；顶层 `staleAfterSeconds`/`host` 也是新增键，缺失时不标陈旧。
- 顶栏粒度：桥接快照里**每个服务商各占一项**（曾把整份快照塌缩成"最紧的一项"，用户反馈"永远只显示最后一个"，故改）。每项取该卡片最紧的窗口，无窗口退额度、再退今日费用、只有失败行才报 `!`（计入 ⚠ 角标）。所有 parts 按 `rank`（`TOPBAR_PCT` < `TOPBAR_VALUE` < `TOPBAR_FAILED` < `TOPBAR_PENDING`）+ `urgency` 稳定排序，`rank` 在 push 时就写好，**不要按 `tone` 推**（剩余 <20% 的 tone 也是 `err`，会和失败项同档）。`单显` 只渲染前 `TOPBAR_MAX_PARTS`（2）项，其余折叠成 `+N` —— 实测 8 项会把顶栏挤到和时钟重叠；`轮播` 不折叠、逐项循环。
- `skipIds` 是已启用直连 provider 的 id 集合：快照中同 id 的桥接卡片必须丢弃，以直连数据为准。

## GSettings 与 EGO 审核约束

- `schemas/`：一个文件只放一个 schema，文件名必须等于 schema id，每个 schema 都要显式 `path`（子 schema 用父 path + 子名）。不要合并 schema 文件——曾因此被 EGO 打回。
- provider 的 `id` 必须与子 schema 名对应（`get_child` 会把 `-` 转成 `_`）。
- `prefs.js`：prefs 对象不得把窗口期对象挂在 `this` 上（EGO-L-006），`settings` 用局部变量/参数传递。

## Testing Guidelines

当前没有单元测试框架；提交前至少运行 schema 校验和 JavaScript 语法检查。涉及 UI、刷新逻辑或 provider 响应解析时，先在嵌套 Xephyr 会话验证：隔离 XDG 目录拷入扩展、启动 `gnome-shell --x11`、确认日志无 `JS ERROR`，再考虑装入 live shell（GNOME Shell 45-50 需逐一手动过：启用扩展、`gnome-extensions prefs ai-quota@tools.0x5c0f.cc`、手动刷新与错误状态）——未验证代码直接进 live shell，崩溃会拖垮整个桌面会话。嵌套会话已知限制：GNOME 46 禁止经 gdbus 调用 `Shell.Eval`（返回 `(false,'')`），设置窗口需手动打开；弹窗在 Xephyr 下贴不住顶栏，用 `box.translation_y`（Clutter 属性，无 `set_translation_y`）调整。

装入 live shell 的两条硬要求：先 `glib-compile-schemas ~/.local/share/gnome-shell/extensions/$UUID/schemas/`（旧的 `gschemas.compiled` 会让新增子 schema/键不可见，`get_child`/`get_string` 直接抛错），再真正重启 gnome-shell（X11 下 `Alt`+`F2` → `r`）。`gnome-extensions disable/enable` 不足以生效：GNOME 45+ 扩展是 ES module，gjs 按进程缓存模块，旧代码会继续运行。重启走的是 re-exec，gnome-shell 的 PID 不变，别用 `pgrep` 判断成败。

## Commit & Pull Request Guidelines

Git 历史目前较短，已有 `docs: ...` 这类前缀；建议继续使用简洁的 Conventional Commit 风格，如 `fix: handle empty custom URL`、`docs: update install steps`。PR 应包含变更摘要、验证命令结果、相关 issue 链接，并说明是否影响 GNOME Shell 版本兼容性；若调整面板或设置窗口，请附截图或录屏。不要在提交中包含真实 API Key、dconf 导出或本地打包产物，除非发布流程明确需要。

## Documentation & Release Notes

面向用户的行为变化应同步更新 `README.md` 和 `README.en.md`。新增截图放入 `docs/`，并使用相对路径引用。发布相关改动应对照 `.github/workflows/release.yml`，确认 zip 内容仍只包含扩展运行所需文件，作为 release checklist 和 CI package validation。Release 仅由 `v*` tag 推送触发 CI 打包，文档类提交不打卡片；`metadata.json` 的 `version` 只在向 extensions.gnome.org 上传新版本时递增，与 git tag 无关。

## Security & Configuration Tips

API Key 保存在 GNOME GSettings/dconf 中，通常不是加密存储。开发和测试时使用低权限密钥，避免把生产密钥写入 README、截图、日志或测试数据。自定义 provider 应优先要求 HTTPS，并继续使用 `Authorization: Bearer <API Key>` 的请求约定。桥接层不保存第三方密钥：各服务商密钥由本机 CodexBar 自行管理，扩展只读取其快照。
