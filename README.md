# @steel-dev/pi

Official [Steel](https://steel.dev) cloud-browser tools for the [Pi coding agent](https://pi.dev).

## Install

```bash
pi install npm:@steel-dev/pi
steel login
```

Alternatively, export `STEEL_API_KEY`. Then ask Pi to browse:

```text
Open Hacker News, inspect the page, and tell me the top story.
```

For a one-off run:

```bash
pi -e npm:@steel-dev/pi
```

## Browser tools

- Navigation: `steel_navigate`, `steel_go_back`, `steel_get_url`, `steel_get_title`
- Inspection: `steel_snapshot`, `steel_scrape`, `steel_find_elements`
- Interaction: `steel_click`, `steel_type`, `steel_fill_form`, `steel_wait`, `steel_scroll`
- Artifacts: `steel_screenshot`, `steel_pdf`
- Structured data: `steel_extract`
- Low-level input: `steel_computer`
- Lifecycle: `steel_pin_session`, `steel_release_session`

Start interactive workflows with `steel_snapshot`. It returns an ARIA tree that lets Pi target controls by accessible role and name instead of guessing CSS selectors.

Interaction tools accept exactly one target method:

```json
{ "role": "button", "name": "Continue" }
```

```json
{ "targetText": "Sign in" }
```

```json
{ "selector": "[data-testid='submit']" }
```

Role/name targeting is preferred. CSS remains available for pages without useful accessibility metadata.

## Sessions

The default mode is `session`: one Steel browser remains available across Pi prompts until Pi switches sessions, shuts down, or calls `steel_release_session`.

Set `STEEL_SESSION_MODE` to:

- `session` — persistent across prompts (default)
- `agent` — release after each agent run
- `turn` — release after each turn

`steel_pin_session` switches to persistent mode at runtime. `steel_release_session` closes the current browser and restores the configured default.

All creation failures attempt API cleanup, and every tracked session is released during Pi lifecycle cleanup.

## Configuration

Requirements:

- Node.js 22.19 or newer
- A current Pi runtime with package extensions
- `STEEL_API_KEY` or Steel CLI authentication from `steel login`

Connection:

- `STEEL_BASE_URL` — override the API base URL
- `STEEL_CONFIG_DIR` — override Steel CLI configuration directory
- `STEEL_BROWSER_API_URL`, `STEEL_LOCAL_API_URL`, `STEEL_API_URL` — compatibility aliases

Session:

- `STEEL_SESSION_MODE`
- `STEEL_SESSION_TIMEOUT_MS`
- `STEEL_SESSION_HEADLESS`
- `STEEL_SESSION_REGION`
- `STEEL_SESSION_PROFILE_ID`
- `STEEL_SESSION_PERSIST_PROFILE`
- `STEEL_SESSION_CREDENTIALS`
- `STEEL_SESSION_NAMESPACE`

Proxy and CAPTCHA:

- `STEEL_USE_PROXY`, `STEEL_PROXY_URL`
- `STEEL_SOLVE_CAPTCHA`
- `STEEL_CAPTCHA_MAX_RETRIES`, `STEEL_CAPTCHA_WAIT_MS`, `STEEL_CAPTCHA_POLL_INTERVAL_MS`

Tools and artifacts:

- `STEEL_TOOL_TIMEOUT_MS`
- `STEEL_NAVIGATE_RETRY_COUNT`
- `STEEL_SCRAPE_MAX_CHARS`
- `STEEL_ARTIFACT_DIR` — defaults to `~/.cache/steel/pi`

Scrapes are saved in full before inline output is truncated. Screenshot, PDF, computer-action image, and scrape results return absolute artifact paths.

### Self-hosted API

Point the SDK at the API root. A trailing `/v1` is accepted and normalized:

```bash
STEEL_BASE_URL=http://localhost:8080/v1 pi -e .
```

The extension prefers the session-scoped `websocketUrl` returned by session creation. It does not append the account API key when that URL already carries a connect token.

## Local development

```bash
npm install
npm test
pi --no-extensions -e .
```

Run the opt-in live test with Steel credentials:

```bash
STEEL_API_KEY=... npm run test:live
```

Package verification:

```bash
npm pack --dry-run
```

## Migration and attribution

This package graduates the original `@steel-experiments/pi-steel` prototype into the official `@steel-dev` scope. It preserves the prototype’s tool names so existing prompts continue to work, while updating Pi dependencies, CDP authentication, cleanup, semantic targeting, artifacts, and tests.

The initial implementation derives from [`steel-experiments/pi-steel`](https://github.com/steel-experiments/pi-steel), with additional packaging and fresh-install lessons informed by the community-maintained [`@false00/pi-steel`](https://github.com/false00/pi-steel). See the repository history and license for attribution.
