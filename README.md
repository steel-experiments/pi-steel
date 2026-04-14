# @steel-experiments/pi-steel

Steel browser automation tools for the Pi coding agent.

This package publishes the Steel extension as a reusable Pi package so it can be installed directly into Pi or consumed by other runtimes such as Takopi-based wrappers.

## What it adds

- `steel_navigate`
- `steel_scrape`
- `steel_screenshot`
- `steel_pdf`
- `steel_click`
- `steel_computer`
- `steel_find_elements`
- `steel_type`
- `steel_fill_form`
- `steel_wait`
- `steel_extract`
- `steel_scroll`
- `steel_go_back`
- `steel_get_url`
- `steel_get_title`
- `steel_pin_session`
- `steel_release_session`

`steel_scrape` defaults to `text`. Ask for `markdown` when headings, lists, and links matter. Ask for `html` only when raw DOM markup is actually needed.

`steel_scroll` can scroll the page or a nested scroll container. For apps like Google Maps, pass a selector for the results pane instead of relying on window scrolling.

## Install

Install into Pi as a package:

```bash
pi install npm:@steel-experiments/pi-steel
```

Or load it for a single run:

```bash
pi -e npm:@steel-experiments/pi-steel
```

For local development from this repo:

```bash
pi -e .
```

For browser workflows that should continue across multiple prompts in the same Pi session, use:

```bash
STEEL_SESSION_MODE=session pi -e .
```

## Requirements

- Node.js 20+
- A Pi runtime that supports extensions
- Steel authentication via either:
  - `STEEL_API_KEY`, or
  - `steel login` config in `~/.config/steel/config.json`
- For self-hosted/local Steel, configure a custom base URL

Optional runtime configuration:

- `STEEL_BASE_URL`
- `STEEL_BROWSER_API_URL`
- `STEEL_LOCAL_API_URL`
- `STEEL_API_URL`
- `STEEL_CONFIG_DIR`
- `STEEL_SESSION_TIMEOUT_MS`
- `STEEL_TOOL_TIMEOUT_MS`
- `STEEL_SOLVE_CAPTCHA`
- `STEEL_USE_PROXY`
- `STEEL_PROXY_URL`
- `STEEL_SESSION_HEADLESS`
- `STEEL_SESSION_REGION`
- `STEEL_SESSION_PROFILE_ID`
- `STEEL_SESSION_PERSIST_PROFILE`
- `STEEL_SESSION_CREDENTIALS`
- `STEEL_SESSION_NAMESPACE`
- `STEEL_SESSION_MODE`
- `STEEL_CAPTCHA_MAX_RETRIES`
- `STEEL_CAPTCHA_WAIT_MS`
- `STEEL_CAPTCHA_POLL_INTERVAL_MS`
- `STEEL_NAVIGATE_RETRY_COUNT`

`pi-steel` reads Steel CLI config for auth and local API resolution, and it normalizes CLI-style API URLs such as `http://localhost:3000/v1` to the SDK-compatible base URL form.

Session lifecycle modes:

- `STEEL_SESSION_MODE=agent` keeps one Steel session for the whole Pi prompt and closes it after `agent_end`. This is the default.
- `STEEL_SESSION_MODE=session` keeps the same Steel session alive until Pi switches or shuts down the current session.
- `STEEL_SESSION_MODE=turn` closes the Steel session after each Pi turn. This is more aggressive and can break workflows that need multiple tool rounds inside one prompt.

You can also change session persistence at runtime:

- `steel_pin_session` keeps the current or next Steel browser session alive across prompts for the rest of the Pi session.
- `steel_release_session` closes the current Steel browser immediately and resets runtime session handling back to the default mode from `STEEL_SESSION_MODE`.

## Development

```bash
npm install
npm run build
npm test
```

Publish preflight:

```bash
npm pack --dry-run
```

## Package Layout

This repo is a Pi package. The package manifest in `package.json` exposes the compiled extension entrypoint:

```json
{
  "pi": {
    "extensions": ["./dist/index.js"]
  }
}
```

That lets Pi load the package root directly after `pi install npm:@steel-experiments/pi-steel`.
