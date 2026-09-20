# API Balance

[中文](README.md) · English

**API Balance** is a GNOME Shell extension for checking the balance or quota of
multiple AI API providers right in the desktop top bar.

It supports built-in providers and custom balance endpoints, and ships a
native-looking GNOME preferences window.

## Screenshots

Dropdown panel (with the top bar balance display):

![Detail panel](docs/screenshot-panel.png)

## Features

- Shows pinned providers' balances in the GNOME Shell top bar.
- Single-value display or rotating display across multiple providers.
- Click the top bar indicator to view detailed balance information per provider.
- Displays balance, topped-up quota, granted quota, and currency.
- Automatic and manual refresh.
- Enable/disable each provider individually.
- Custom balance-query endpoints.
- Reads custom endpoint response fields via JSON dot paths.
- No telemetry; never contacts third-party services you have not configured.

## Supported Providers

Current built-in providers:

| Provider | Endpoint | Authentication |
| --- | --- | --- |
| DeepSeek | `/user/balance` | `Authorization: Bearer <API Key>` |
| Kimi | `/v1/users/me/balance` | `Authorization: Bearer <API Key>` |

In addition, other compatible balance-query endpoints can be connected through
the "Custom" configuration.

> The endpoint URLs and response formats of built-in providers are determined
> by the corresponding provider implementations. If a provider changes its
> API, the provider code may need to be updated accordingly.

## Installation

### From GitHub Releases

1. Open the [Releases](https://github.com/0x5c0f/api-balance/releases) page.
2. Download the zip archive of the latest release.
3. Install it:

```bash
gnome-extensions install api-balance@tools.0x5c0f.cc.zip
```

4. Enable the extension:

```bash
gnome-extensions enable api-balance@tools.0x5c0f.cc
```

If the extension does not take effect immediately, log out and back in. On X11
you can also press `Alt` + `F2`, type `r`, and restart GNOME Shell.

### From Source

Run this in the project root:

```bash
mkdir -p ~/.local/share/gnome-shell/extensions/api-balance@tools.0x5c0f.cc

cp metadata.json extension.js prefs.js stylesheet.css \
  ~/.local/share/gnome-shell/extensions/api-balance@tools.0x5c0f.cc/

cp -r providers schemas \
  ~/.local/share/gnome-shell/extensions/api-balance@tools.0x5c0f.cc/
```

Then enable the extension:

```bash
gnome-extensions enable api-balance@tools.0x5c0f.cc
```

## Configuration

Open the GNOME extensions preferences:

```bash
gnome-extensions prefs api-balance@tools.0x5c0f.cc
```

### General Settings

- **Auto refresh interval**: query interval in minutes, range 1–1440.
- **Top bar display**:
  - **Single**: show the first pinned provider.
  - **Carousel**: switch between pinned providers every few seconds.

### Provider Settings

Each provider is configured independently:

- **Enable queries**: whether to run balance queries.
- **Show in top bar (pin)**: whether to display this provider in the top bar.
- **API Key**: the provider API key.

When queries are disabled, the provider makes no requests and is hidden from
the detail panel.

## Custom Providers

Custom providers allow any HTTPS balance-query endpoint.

Fields:

- **Name**: display name shown in the top bar and detail panel.
- **API Key**: Bearer token used in requests.
- **Balance query URL**: full request URL; the extension never appends paths.
- **Currency mapping path**: reads the currency code from the JSON response.
- **Balance mapping path**: reads the total balance from the JSON response.
- **Granted mapping path**: reads the granted quota; may be left empty.
- **Topped-up mapping path**: reads the topped-up quota; may be left empty.

### JSON Path Example

Suppose the endpoint returns:

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

Use the following mappings:

```text
Currency: data.balance_infos.0.currency
Balance:  data.balance_infos.0.total
Granted:  data.balance_infos.0.granted
Topped-up: data.balance_infos.0.topped_up
```

JSON paths are dot-separated; arrays are accessed by numeric index, e.g.:

```text
items.0.balance
```

### Request Behavior

Custom providers use:

```http
GET <configured URL>
Authorization: Bearer <API Key>
```

The endpoint must return valid JSON, and the mapping paths must match the
actual response structure.

## Project Structure

```text
.
├── extension.js          # GNOME Shell main extension logic
├── prefs.js              # preferences window
├── metadata.json         # extension metadata
├── stylesheet.css        # UI styles
├── providers/
│   ├── deepseek.js       # DeepSeek provider
│   ├── kimi.js           # Kimi provider
│   └── generic.js        # custom provider
├── schemas/
│   └── *.gschema.xml     # GSettings definitions
├── .github/
│   └── workflows/        # GitHub Actions
├── README.md
└── README.en.md
```

## Development & Packaging

### Requirements

- GNOME Shell 45–50
- `glib-compile-schemas`
- `zip`
- the corresponding GNOME JavaScript runtime and dependencies

On Ubuntu/Debian you can install the basic tools:

```bash
sudo apt install libglib2.0-bin zip
```

### Check the GSettings Schema

```bash
glib-compile-schemas schemas/
```

### Packaging

`gnome-extensions pack` is recommended; include the `providers` directory
explicitly:

```bash
gnome-extensions pack -f \
  --extra-source=providers \
  .
```

You can also package manually with `zip`:

```bash
zip -r api-balance@tools.0x5c0f.cc.zip \
  metadata.json \
  extension.js \
  prefs.js \
  stylesheet.css \
  schemas/*.xml \
  providers/*.js
```

### Releasing

The project has GitHub Actions configured. Creating and pushing a version tag
triggers automatic packaging and the release flow:

```bash
git tag v1.0.0
git push origin main --tags
```

See the GitHub Actions configuration in the repository for details.

## Security & Privacy

- API keys are stored in GNOME GSettings/dconf, normally in plaintext.
- Do not configure API keys with high spending limits or important production
  privileges in this extension.
- The extension only requests built-in provider endpoints or the custom URLs
  you configure.
- There is no telemetry logic and no data sent to other services on its own.
- All balance queries use HTTP `GET` with `Authorization: Bearer <API Key>`.
- HTTPS is recommended for custom endpoints so the API key is not transmitted
  in plaintext over the network.

## Troubleshooting

### No balance shown in the top bar

Check in order:

1. Whether the extension is enabled:

   ```bash
   gnome-extensions list
   ```

2. Whether "Enable queries" is on for the provider.
3. Whether the API key is filled in correctly.
4. Whether the provider is pinned ("Show in top bar").
5. Whether the network can reach the API address.

### "Query failed" is displayed

Possible causes:

- The API address is unreachable.
- The API key is invalid or lacks permission.
- The provider returns a non-200 status code.
- The provider response is not valid JSON.
- The response fields do not match what the provider code expects.

### Custom provider shows no data

Focus on:

- Whether the URL is the full address.
- Whether the JSON mapping paths are correct.
- Whether the array indices are correct.
- Whether the balance field is a number or a numeric string.

## Compatibility

- GNOME Shell: 45, 46, 47, 48, 49, 50
- Display servers: X11, Wayland
- License: MIT

## License

This project is released under the [MIT License](LICENSE).

## Links

- [Repository](https://github.com/0x5c0f/api-balance)
- [GitHub Releases](https://github.com/0x5c0f/api-balance/releases)
- [GNOME Extensions](https://extensions.gnome.org/extension/10989/api-balance/)
