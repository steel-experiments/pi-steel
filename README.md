# @steel-dev/pi-steel

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

## Install

Install into Pi as a package:

```bash
pi install npm:@steel-dev/pi-steel
```

Or load it for a single run:

```bash
pi -e npm:@steel-dev/pi-steel
```

For local development from this repo:

```bash
pi -e .
```

## Requirements

- Node.js 20+
- A Pi runtime that supports extensions
- `STEEL_API_KEY` exported in the environment

Optional runtime configuration:

- `STEEL_SESSION_TIMEOUT_MS`
- `STEEL_TOOL_TIMEOUT_MS`
- `STEEL_SOLVE_CAPTCHA`
- `STEEL_USE_PROXY`
- `STEEL_PROXY_URL`
- `STEEL_CAPTCHA_MAX_RETRIES`
- `STEEL_CAPTCHA_WAIT_MS`
- `STEEL_CAPTCHA_POLL_INTERVAL_MS`
- `STEEL_NAVIGATE_RETRY_COUNT`

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

That lets Pi load the package root directly after `pi install npm:@steel-dev/pi-steel`.
