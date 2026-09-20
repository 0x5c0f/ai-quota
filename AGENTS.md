# Repository Guidelines

## Project Structure & Module Organization

这是一个 GNOME Shell 扩展仓库。核心运行时代码在根目录：`extension.js` 负责顶栏指示器、余额刷新和面板 UI，`prefs.js` 负责扩展设置窗口，`stylesheet.css` 存放样式，`metadata.json` 定义扩展元数据。服务商逻辑放在 `providers/`，例如 `deepseek.js`、`kimi.js` 和 `generic.js`。GSettings schema 位于 `schemas/`，截图等文档资产位于 `docs/`。发布流水线在 `.github/workflows/release.yml`。

## Build, Test, and Development Commands

- `glib-compile-schemas schemas/`：本地编译 GSettings schema，适合快速检查 XML 是否可用。
- `glib-compile-schemas --strict --targetdir=$(mktemp -d) schemas/`：按 CI 方式严格校验 schema。
- `for f in extension.js prefs.js providers/*.js; do cp "$f" /tmp/check.mjs && node --check /tmp/check.mjs; done`：检查所有 JavaScript 模块语法。
- `gnome-extensions pack -f --extra-source=providers .`：使用 GNOME 工具打包扩展。
- `zip -r api-balance@tools.0x5c0f.cc.zip metadata.json extension.js prefs.js stylesheet.css schemas/*.xml providers/*.js`：手动生成发布 zip。

## Coding Style & Naming Conventions

JavaScript 使用 ES modules、4 空格缩进和分号。类名使用 `PascalCase`，函数和局部变量使用 `camelCase`，GNOME/GObject 私有状态沿用 `_fieldName` 风格。变更 provider 响应结构时，同时更新错误提示和文档示例。schema key 与设置代码保持语义一致，避免只改一侧。

新增 provider 需同步五处（漏一处，设置界面或打包校验就会坏）：

1. `providers/<id>.js` 导出默认 provider 类，并在 `extension.js` 的 `buildProviders()` 注册（按面板实例化，勿在模块加载时 `new`）。
2. 新建子 schema 文件（见下节），并在主 schema 中加 `<child>` 声明。
3. `prefs.js` 顶部的 provider 列表加入条目。
4. `.github/workflows/release.yml` 中 verify-zip 的硬编码文件清单。
5. `README.md` 与 `README.en.md` 的 provider 表格。

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

API Key 保存在 GNOME GSettings/dconf 中，通常不是加密存储。开发和测试时使用低权限密钥，避免把生产密钥写入 README、截图、日志或测试数据。自定义 provider 应优先要求 HTTPS，并继续使用 `Authorization: Bearer <API Key>` 的请求约定。
