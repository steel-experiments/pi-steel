# @steel-experiments/pi-steel

> **Steel Experiments** — This is where we ship early, break things, and explore what's next for browser agents. Experiments, prototypes, bleeding-edge demos, and community contributions that push the boundaries of what's possible with web automation. Not production-ready. Definitely interesting.

[Steel](https://steel.dev) browser automation tools for the [Pi](https://github.com/badlogic/pi-mono) coding agent.

This package publishes the Steel extension as a reusable Pi package so it can be installed directly into Pi or consumed by other runtimes such as Takopi-based wrappers.

## Quick start

```bash
pi install npm:@steel-experiments/pi-steel
```

Then just ask Pi to browse:

```
> Go to hacker news and find the top story
```

Pi will use `steel_navigate` to open the page, `steel_scrape` to read the content, and return what it finds. All session management happens automatically.

## Tools

### Navigation

| Tool | Description |
|------|-------------|
| `steel_navigate` | Open a URL with automatic scheme normalization and retry logic |
| `steel_go_back` | Navigate back in browser history |
| `steel_get_url` | Read the current page URL |
| `steel_get_title` | Read the current page title |

### Content extraction

| Tool | Description |
|------|-------------|
| `steel_scrape` | Extract page content as text, markdown, or html |
| `steel_screenshot` | Capture a screenshot artifact |
| `steel_pdf` | Generate a PDF artifact |
| `steel_extract` | Extract structured data using a JSON schema |

### Interaction

| Tool | Description |
|------|-------------|
| `steel_click` | Click an element with captcha recovery |
| `steel_type` | Type text into a field |
| `steel_fill_form` | Fill multiple form fields at once |
| `steel_scroll` | Scroll the page or a nested container |
| `steel_find_elements` | Find interactive elements by selector |
| `steel_wait` | Wait for an element to appear |
| `steel_computer` | Low-level computer action with screenshot |

### Session management

| Tool | Description |
|------|-------------|
| `steel_pin_session` | Keep the browser session alive across prompts |
| `steel_release_session` | Close the browser and reset to default session mode |

`steel_scrape` defaults to `text`. Ask for `markdown` when headings, lists, and links matter. Ask for `html` only when raw DOM markup is actually needed.

`steel_scroll` can scroll the page or a nested container. For apps like Google Maps, pass a selector for the results pane instead of relying on window scrolling.

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

## Session modes

Steel sessions have a lifecycle tied to how Pi uses them. The default works for most cases, but you can tune it:

| Mode | Behavior |
|------|----------|
| `agent` (default) | One session per Pi prompt, closed after `agent_end` |
| `session` | Session stays alive until Pi switches or shuts down |
| `turn` | Session closed after each Pi turn — aggressive, can break multi-step workflows |

Set the mode via environment variable:

```bash
STEEL_SESSION_MODE=session pi -e npm:@steel-experiments/pi-steel
```

You can also change session persistence at runtime with `steel_pin_session` and `steel_release_session`.

## Configuration

### Required

- Node.js 20+
- A Pi runtime that supports extensions
- Steel authentication via either:
  - `STEEL_API_KEY`, or
  - `steel login` config in `~/.config/steel/config.json`

### Environment variables

**Connection**

| Variable | Purpose |
|----------|---------|
| `STEEL_BASE_URL` | Steel API base URL |
| `STEEL_BROWSER_API_URL` | Browser API endpoint |
| `STEEL_LOCAL_API_URL` | Local Steel instance URL |
| `STEEL_API_URL` | Alternative API URL |
| `STEEL_CONFIG_DIR` | Custom config directory |

**Session**

| Variable | Purpose |
|----------|---------|
| `STEEL_SESSION_MODE` | Lifecycle mode: `agent`, `session`, or `turn` |
| `STEEL_SESSION_TIMEOUT_MS` | Session timeout |
| `STEEL_SESSION_HEADLESS` | Run browser headless |
| `STEEL_SESSION_REGION` | Browser region |
| `STEEL_SESSION_PROFILE_ID` | Persistent browser profile |
| `STEEL_SESSION_PERSIST_PROFILE` | Save profile changes |
| `STEEL_SESSION_CREDENTIALS` | Session credentials |
| `STEEL_SESSION_NAMESPACE` | Session namespace |

**Proxy**

| Variable | Purpose |
|----------|---------|
| `STEEL_USE_PROXY` | Enable proxy |
| `STEEL_PROXY_URL` | Proxy URL |

**Captcha**

| Variable | Purpose |
|----------|---------|
| `STEEL_SOLVE_CAPTCHA` | Enable captcha solving |
| `STEEL_CAPTCHA_MAX_RETRIES` | Max captcha retry attempts |
| `STEEL_CAPTCHA_WAIT_MS` | Captcha solve wait time |
| `STEEL_CAPTCHA_POLL_INTERVAL_MS` | Captcha poll interval |

**Tools**

| Variable | Purpose |
|----------|---------|
| `STEEL_TOOL_TIMEOUT_MS` | Default tool timeout |
| `STEEL_NAVIGATE_RETRY_COUNT` | Navigation retry attempts |

`pi-steel` reads Steel CLI config for auth and local API resolution, and it normalizes CLI-style API URLs such as `http://localhost:3000/v1` to the SDK-compatible base URL form.

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

The package manifest in `package.json` exposes the compiled extension entrypoint via `pi.extensions`, which lets Pi load the package root directly after install.
