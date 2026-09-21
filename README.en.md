# AI Quota

[中文](README.md) · English

**AI Quota** is a GNOME Shell extension for checking the balance or quota of
multiple AI API providers right in the desktop top bar.

It supports built-in providers, custom balance endpoints, and a bridge layer
that consumes usage data from about 70 providers maintained by
[CodexBar](https://github.com/steipete/CodexBar), and ships a native-looking
GNOME preferences window.

## Screenshots

Dropdown panel (with the top bar balance display). The two sides of the
diagonal are the same layout in each of the two self-drawn palettes, matching
the system's dark and light modes:

![Detail panel, dark and light palettes](docs/screenshot-panel.png)

## Features

- Shows pinned providers' balances in the GNOME Shell top bar.
- Pinned providers displayed side by side, or rotating every few seconds.
- Click the top bar indicator to view detailed balance information per provider.
- Displays balance, topped-up quota, granted quota, and currency.
- Automatic and manual refresh.
- Enable/disable each provider individually.
- Custom balance-query endpoints.
- CodexBar bridge: one integration gives you the ~70 providers it maintains
  (Claude, Gemini, Cursor, and more).
- Quota windows (session / weekly, etc.) rendered as progress bars with reset
  countdowns and usage-based colors.
- The dropdown is a self-drawn card UI with its own dark and light palettes: it
  follows the desktop's dark/light preference by default (or pin it in prefs) and
  never tries to adapt to third-party themes.
- The top bar indicator takes the bar's own text colour, so it stays readable on a
  light bar as well as a dark one.
- Reads custom endpoint response fields via JSON dot paths.
- No telemetry; never contacts third-party services you have not configured.

## Supported Providers

Current built-in providers:

| Provider | Endpoint | Authentication |
| --- | --- | --- |
| DeepSeek | `/user/balance` | `Authorization: Bearer <API Key>` |

In addition, other compatible balance-query endpoints can be connected through
the "Custom" configuration.

> The endpoint URLs and response formats of built-in providers are determined
> by the corresponding provider implementations. If a provider changes its
> API, the provider code may need to be updated accordingly.

## CodexBar Bridge

[CodexBar](https://github.com/steipete/CodexBar) is a separate open-source CLI
tool that collects quotas and usage from about 70 AI providers. This extension
consumes its versioned `dashboard-v1` snapshot through a bridge layer and
renders each provider as a card with quota-window progress bars.

Suited for:

- Subscription plans such as Claude, Gemini, Cursor (rate-limited by 5-hour /
  weekly windows).
- Avoiding per-provider API key configuration inside the extension.

### Step 1: configure the providers in CodexBar

Install CodexBar locally first (see its repository). Each provider's login and
keys live **only in CodexBar's own configuration**
(`~/.config/codexbar/config.json`); this extension neither reads nor writes
them.

Do it one of two ways:

- Flip the provider's switch inside CodexBar itself (recommended — its UI runs
  the login flow for you).
- Edit `config.json` directly and add one entry per provider to the `providers`
  array:

```jsonc
{
  "version": 1,
  "providers": [
    { "id": "claude", "enabled": true,  "source": "auto" },
    { "id": "gemini", "enabled": true,  "source": "auto" },
    { "id": "cursor", "enabled": true,  "source": "auto" }
  ]
}
```

`id` is one of CodexBar's provider identifiers — the full set (about 70) is
listed as the accepted values of `--provider` in `codexbar usage --help`.
A single provider can also hold several accounts: `tokenAccounts` looks like
`{ "activeIndex": 0, "accounts": [ { "label": "work", "token": "…" }, … ] }`,
and `activeIndex` picks the one in use.

Then check that CodexBar itself sees data before involving the extension:

```bash
codexbar usage                        # enabled providers (honors in-app toggles)
codexbar usage --provider claude      # one provider
```

> Do not self-check with `--provider all`: it ignores the toggles and probes all
> ~70 providers, some of which (Claude, for instance) fetch usage by driving a
> local CLI session. If that CLI stops answering, the command blocks for minutes
> without printing anything.

**Nothing has to be configured per provider on the extension side**: every
`enabled` provider in the snapshot automatically becomes a card in the panel.

### Step 2: pick a transport

Preferences → 桥接层 (Bridge) → "Connection mode" — choose one.

#### CLI mode (default, zero extra setup)

On every refresh the extension runs:

```bash
codexbar dashboard
```

No daemon and no token needed, because it reads CodexBar's own configuration
directly; the snapshot is read from the command's standard output, so the
extension never writes a snapshot file to disk. A fetch takes from a few seconds
up to a dozen or so, growing with the number of enabled providers, so keep the
"Auto refresh interval" at 5 minutes or more.

If `codexbar` is not in `PATH`, set "CLI command" to its absolute path (e.g.
`/usr/local/bin/codexbar`). The `dashboard` part is appended by the extension —
do not type it into that field.

#### HTTP mode (standing server, faster refresh)

Start the server (listens on `127.0.0.1:8080` by default):

```bash
CODEXBAR_DASHBOARD_TOKEN='your-token' codexbar serve --refresh-interval 60
```

Then fill in the extension settings:

- Snapshot URL: `http://127.0.0.1:8080/dashboard/v1/snapshot`
- Access token: exactly the value used above

Notes:

- `/dashboard/v1/snapshot` requires `Authorization: Bearer <token>` and
  **denies anonymous access by default** — if the server has no token
  configured, the endpoint answers 401 rather than letting requests through.
- Pass the token as an environment variable, not `--dashboard-token`: command
  line arguments are visible to other local users through `ps`.
- `--refresh-interval` (60 seconds by default) is how often the *server*
  recaches the snapshot; setting a shorter refresh interval in the extension
  will not get newer data any faster.
- Binding to anything but the loopback address (e.g. `--host 0.0.0.0`) also
  requires `--allow-plain-http`, and the transport stays plain HTTP — the token
  then crosses the network on every request. Put it behind a TLS reverse proxy
  and never on an untrusted network.
- If you would rather the snapshot not carry account e-mails, add
  `--identity redacted` (hides the local part).

### Step 3: which setting goes where

| Extension setting | CLI mode | HTTP mode |
| --- | --- | --- |
| Enable bridge | on | on |
| Show in top bar (pin) | as needed | as needed |
| Connection mode | CLI (one-shot command) | HTTP (`codexbar serve`) |
| Snapshot URL | leave the default, unused | `http://127.0.0.1:8080/dashboard/v1/snapshot` |
| Access token | leave empty, unused | same as `CODEXBAR_DASHBOARD_TOKEN` |
| CLI command | `codexbar` (or an absolute path) | leave the default, unused |

### Self-check and troubleshooting

```bash
curl -sf http://127.0.0.1:8080/health                        # is the server up?
curl -sf -H "Authorization: Bearer your-token" \
  http://127.0.0.1:8080/dashboard/v1/snapshot | head -c 400   # can the snapshot be fetched?
```

- A card reports **invalid key**, or curl gets 401: the token in the extension
  differs from the server's, or the server was started without one.
- A card reports **service unavailable**: `codexbar serve` is not running, or
  the port/address is wrong (confirm with `/health` first).
- The panel says "No displayable provider in the snapshot": either those
  providers are already covered by direct queries (see below), or CodexBar has
  no provider enabled at all.
- CLI mode reports **Query failed**: check `which codexbar`, or switch the
  setting to an absolute path.

### Behaviour

- Bridge cards never conflict with direct providers: if a provider already has
  direct querying enabled (e.g. DeepSeek), the bridge card with the same id in
  the snapshot is hidden and the direct data wins.
- Quota windows can be shown as "progress bar + reset time" or "text only";
  bar colors are blue / yellow / red by remaining amount.
- In the top bar every provider of the snapshot gets its own slot (treated just
  like a direct provider), ordered by urgency: the tightest remaining share
  first, then credits / today's spend, with failed rows last (they still raise
  the ⚠ badge). "Single" lists at most 2 slots and collapses the rest into
  `+N` — more than that collides with the clock in the middle of the bar;
  "Carousel" cycles through all of them without collapsing.
- The panel footer shows this extension's last refresh time and the generation
  time of the CodexBar snapshot.
- The snapshot is parsed as if every key could be missing: only numbers that are
  actually present are shown, a window without one is never read as 0%, and keys
  added upstream do not break older releases.
- Windows the producer marks as `idle` (a model family with no usage) are not
  drawn; a window kind we do not know is labelled "配额窗口" generically, with the
  window length when available, so no upstream internal id leaks into the panel.
- Some multi-account integrations (claude-swap) keep usage only on the account
  rows: when the row itself has no windows, the active account's windows are
  used. A whole-adapter failure (`accountsError`) is shown as an informational
  line instead of marking the card as failed.
- When a row's `updatedAt` is older than the snapshot's staleness hint
  (`staleAfterSeconds`), the card is labelled "N 分/小时前更新" so it reads as
  stale data rather than live.
- Boundary: the bridge shows CodexBar's **quota window / credit** view.
  Balance-billed providers (DeepSeek, OpenRouter, …) usually expose only a
  placeholder 100% window in the snapshot, with no amount at all — use the
  matching direct provider to see a balance.

## Installation

### From GitHub Releases

1. Open the [Releases](https://github.com/0x5c0f/ai-quota/releases) page.
2. Download the zip archive of the latest release.
3. Install it:

```bash
gnome-extensions install ai-quota@tools.0x5c0f.cc.zip
```

4. Enable the extension:

```bash
gnome-extensions enable ai-quota@tools.0x5c0f.cc
```

If the extension does not take effect immediately, log out and back in. On X11
you can also press `Alt` + `F2`, type `r`, and restart GNOME Shell.

### From Source

Run this in the project root:

```bash
mkdir -p ~/.local/share/gnome-shell/extensions/ai-quota@tools.0x5c0f.cc

cp metadata.json extension.js prefs.js stylesheet.css \
  ~/.local/share/gnome-shell/extensions/ai-quota@tools.0x5c0f.cc/

cp -r providers schemas \
  ~/.local/share/gnome-shell/extensions/ai-quota@tools.0x5c0f.cc/
```

Then enable the extension:

```bash
gnome-extensions enable ai-quota@tools.0x5c0f.cc
```

## Configuration

Open the GNOME extensions preferences:

```bash
gnome-extensions prefs ai-quota@tools.0x5c0f.cc
```

### General Settings

- **Auto refresh interval**: query interval in minutes, range 1–1440.
- **Top bar display**:
  - **Single**: show the most urgent pinned providers side by side, at most 2,
    with the rest collapsed into `+N`.
  - **Carousel**: switch between pinned providers every few seconds.
- **Quota window display**:
  - **Progress bar + reset time**: bridge quota windows render as colored bars.
  - **Text only**: only the remaining percentage and reset time.

### Bridge Settings

Once the CodexBar bridge is enabled in the 桥接层 (Bridge) group:

- **Connection mode**: CLI (default, a one-shot command) or HTTP (requires
  `codexbar serve` to be running).
- **Snapshot URL**: full URL for HTTP mode, defaults to
  `http://127.0.0.1:8080/dashboard/v1/snapshot`.
- **Access token**: HTTP mode only — the `--dashboard-token` /
  `CODEXBAR_DASHBOARD_TOKEN` value given to `codexbar serve`. Unused in CLI mode.
- **CLI command**: executable name or path for CLI mode, defaults to
  `codexbar`.

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
│   ├── generic.js        # custom provider
│   └── codexbar.js       # CodexBar bridge provider
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
zip -r ai-quota@tools.0x5c0f.cc.zip \
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
- The extension only requests built-in provider endpoints, the custom URLs you
  configure, or the snapshot address set for the bridge layer.
- The CodexBar bridge never touches provider keys directly: those keys are
  managed by CodexBar itself (normally under `~/.config/codexbar/`), and this
  extension only reads the snapshot data generated by the local CodexBar.
- The HTTP-mode access token is stored in GSettings/dconf in plaintext as well;
  keep `codexbar serve` bound to the loopback address rather than exposing an
  unencrypted snapshot port to the network.
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

### Bridge shows "Query failed"

Follow the message shown on the card:

- "No response from the snapshot URL (HTTP 404)": HTTP mode needs the CodexBar
  server running, and the URL must end at `/dashboard/v1/snapshot`.
- "The snapshot endpoint requires an access token (HTTP 401/403)": the snapshot
  endpoint denies anonymous access, so the token in the settings must match the
  `--dashboard-token` / `CODEXBAR_DASHBOARD_TOKEN` given to `codexbar serve` —
  or switch to CLI mode, which needs no token.
- CLI mode fails to start: make sure `codexbar` is in `PATH`, or set the full
  executable path in the preferences.
- "Unsupported snapshot format": the installed CodexBar is newer or older than
  the `schemaVersion: 1` this extension reads.
- "No displayable provider in the snapshot": CodexBar has no providers
  configured yet, or every provider in it is already covered by a direct query.
- A single card shows "Query failed" with an error: that is CodexBar's
  row-level error (e.g. it could not resolve the provider's domain); the other
  cards keep working.

## Compatibility

- GNOME Shell: 45, 46, 47, 48, 49, 50
- Display servers: X11, Wayland
- License: MIT

## License

This project is released under the [MIT License](LICENSE).

## Links

- [Repository](https://github.com/0x5c0f/ai-quota)
- [GitHub Releases](https://github.com/0x5c0f/ai-quota/releases)
- [GNOME Extensions](https://extensions.gnome.org/extension/10989/ai-quota/)
