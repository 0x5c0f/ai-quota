# API Balance

中文 · [English](README.en.md)

**API Balance** 是一个 GNOME Shell 扩展，用于在桌面顶栏查看多个 AI API 服务商的余额或额度。

它支持内置服务商和自定义余额接口，并提供 GNOME 原生风格的配置窗口。

## 功能特性

- 在 GNOME Shell 顶栏显示已置顶服务商的余额。
- 支持单个显示或多个服务商轮播显示。
- 点击顶栏指示器查看各服务商的详细余额信息。
- 支持余额、充值额度、赠送额度和货币信息展示。
- 支持自动刷新和手动刷新。
- 支持启用/停用单个服务商。
- 支持自定义余额查询接口。
- 使用 JSON 点路径读取自定义接口响应字段。
- 不包含遥测功能，不主动连接未配置的第三方服务。

## 支持的服务商

当前内置服务商：

| 服务商 | 请求接口 | 认证方式 |
| --- | --- | --- |
| DeepSeek | `/user/balance` | `Authorization: Bearer <API Key>` |
| Kimi | `/v1/users/me/balance` | `Authorization: Bearer <API Key>` |

此外，还可以通过“自定义”配置接入其他兼容的余额查询接口。

> 内置服务商的接口地址和返回格式由对应 provider 实现决定。服务商接口发生变化时，可能需要同步更新 provider 代码。

## 安装

### 从 GitHub Releases 安装

1. 打开 [Releases](https://github.com/0x5c0f/api-balance/releases)。
2. 下载最新版本的扩展压缩包。
3. 执行安装命令：

```bash
gnome-extensions install api-balance@tools.0x5c0f.cc.zip
```

4. 启用扩展：

```bash
gnome-extensions enable api-balance@tools.0x5c0f.cc
```

如果扩展没有立即生效，请注销并重新登录。X11 环境也可以使用 `Alt` + `F2`，输入 `r` 重启 GNOME Shell。

### 从源码安装

在项目根目录执行：

```bash
mkdir -p ~/.local/share/gnome-shell/extensions/api-balance@tools.0x5c0f.cc

cp metadata.json extension.js prefs.js stylesheet.css \
  ~/.local/share/gnome-shell/extensions/api-balance@tools.0x5c0f.cc/

cp -r providers schemas \
  ~/.local/share/gnome-shell/extensions/api-balance@tools.0x5c0f.cc/
```

然后启用扩展：

```bash
gnome-extensions enable api-balance@tools.0x5c0f.cc
```

## 配置

打开 GNOME 扩展设置：

```bash
gnome-extensions prefs api-balance@tools.0x5c0f.cc
```

### 常规设置

- **自动刷新间隔**：设置自动查询间隔，单位为分钟，范围为 1–1440。
- **顶栏显示**：
  - **单显**：显示第一个置顶服务商。
  - **轮播**：每隔数秒在多个置顶服务商之间切换。

### 服务商设置

每个服务商可以独立配置：

- **启用查询**：是否执行余额查询。
- **在顶栏显示（置顶）**：是否在顶栏显示该服务商。
- **API Key**：服务商 API 密钥。

停用查询后，该服务商不会执行请求，也不会出现在详情面板中。

## 自定义服务商

自定义服务商允许配置任意 HTTPS 余额查询接口。

需要填写：

- **名称**：在顶栏和详情面板中显示的名称。
- **API Key**：请求时使用的 Bearer Token。
- **余额查询 URL**：完整请求地址，扩展不会自动拼接路径。
- **货币映射路径**：从 JSON 响应中读取货币代码。
- **余额映射路径**：从 JSON 响应中读取总余额。
- **赠送映射路径**：从 JSON 响应中读取赠送额度，可留空。
- **充值映射路径**：从 JSON 响应中读取充值额度，可留空。

### JSON 路径示例

假设接口返回：

```json
{
  "data": {
    "balance_infos": [
      {
        "currency": "CNY",
        "total": 100,
        "granted": 20,
        "topped_up": 80
      }
    ]
  }
}
```

可以使用以下映射：

```text
货币：data.balance_infos.0.currency
余额：data.balance_infos.0.total
赠送：data.balance_infos.0.granted
充值：data.balance_infos.0.topped_up
```

JSON 路径使用点号分隔，数组通过数字下标访问，例如：

```text
items.0.balance
```

### 请求行为

自定义服务商使用：

```http
GET <配置的 URL>
Authorization: Bearer <API Key>
```

接口需要返回合法 JSON，且映射路径必须与实际响应结构匹配。

## 项目结构

```text
.
├── extension.js          # GNOME Shell 主扩展逻辑
├── prefs.js              # 设置窗口
├── metadata.json         # 扩展元数据
├── stylesheet.css        # 界面样式
├── providers/
│   ├── deepseek.js       # DeepSeek provider
│   ├── kimi.js           # Kimi provider
│   └── generic.js        # 自定义 provider
├── schemas/
│   └── *.gschema.xml     # GSettings 配置定义
├── .github/
│   └── workflows/        # GitHub Actions
├── README.md
└── README.en.md
```

## 开发与打包

### 环境要求

- GNOME Shell 45–50
- `glib-compile-schemas`
- `zip`
- 对应的 GNOME JavaScript 运行环境和依赖

Ubuntu/Debian 系统可以安装基础工具：

```bash
sudo apt install libglib2.0-bin zip
```

### 检查 GSettings Schema

```bash
glib-compile-schemas schemas/
```

### 打包扩展

推荐使用 `gnome-extensions pack`，并显式包含 `providers` 目录：

```bash
gnome-extensions pack -f \
  --extra-source=providers \
  .
```

也可以使用 `zip` 手动打包：

```bash
zip -r api-balance@tools.0x5c0f.cc.zip \
  metadata.json \
  extension.js \
  prefs.js \
  stylesheet.css \
  schemas/*.xml \
  providers/*.js
```

### 发布

项目配置了 GitHub Actions。创建并推送版本标签后，可以触发自动打包和 Release 流程：

```bash
git tag v1.0.0
git push origin main --tags
```

请以仓库中的 GitHub Actions 配置为准。

## 安全与隐私

- API Key 会保存到 GNOME GSettings/dconf 中，通常以明文形式存储。
- 不建议在扩展中配置具有高额消费权限或重要生产权限的 API Key。
- 扩展只请求内置 provider 或用户配置的自定义 URL。
- 扩展不包含遥测逻辑，也不会主动向其他服务发送数据。
- 所有余额查询请求均使用 HTTP `GET`，并通过 `Authorization: Bearer <API Key>` 传递密钥。
- 自定义接口建议使用 HTTPS，避免 API Key 在网络中明文传输。

## 故障排查

### 顶栏没有显示余额

请依次检查：

1. 扩展是否已启用：

   ```bash
   gnome-extensions list
   ```

2. 对应服务商是否启用了“启用查询”。
3. API Key 是否填写正确。
4. 服务商是否已设置为“置顶”。
5. 网络是否可以访问对应 API 地址。

### 显示“查询失败”

可能原因包括：

- API 地址不可访问。
- API Key 无效或权限不足。
- 服务商返回非 200 状态码。
- 服务商返回的数据不是合法 JSON。
- 返回字段与 provider 预期格式不一致。

### 自定义服务商没有数据

请重点检查：

- URL 是否为完整地址。
- JSON 映射路径是否正确。
- 数组下标是否正确。
- 余额字段是否为数字或可转换为数字的字符串。

## 兼容性

- GNOME Shell：45、46、47、48、49、50
- 显示服务器：X11、Wayland
- 许可证：MIT

## 许可证

本项目基于 [MIT License](LICENSE) 发布。

## 相关链接

- [项目仓库](https://github.com/0x5c0f/api-balance)
- [GitHub Releases](https://github.com/0x5c0f/api-balance/releases)
- [GNOME Extensions](https://extensions.gnome.org/extension/10989/api-balance/)
