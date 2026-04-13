import Steel from "steel-sdk";
import type {
  CaptchaSolveResponse,
  CaptchaStatusResponse,
} from "steel-sdk/resources/sessions";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { toolError } from "./tools/tool-runtime.js";

type SessionCreateOptions = Steel.SessionCreateParams;
type SessionMetadata = Awaited<ReturnType<Steel["sessions"]["create"]>>;

type SessionGotoOptions = Parameters<Page["goto"]>[1];
type SessionWaitForSelectorOptions = Parameters<Page["waitForSelector"]>[1];
type SessionClickOptions = Parameters<Page["click"]>[1];
type SessionTypeOptions = Parameters<Page["type"]>[2];
type SessionScreenshotOptions = Parameters<Page["screenshot"]>[0];
type SessionPdfOptions = Parameters<Page["pdf"]>[0];
type SessionComputerParams = Steel.SessionComputerParams;
type SessionComputerResponse = Steel.SessionComputerResponse;

export interface LiveSteelSession {
  id: string;
  sessionViewerUrl: string;
  debugUrl: string;
  page: Page;
  goto: (url: string, options?: SessionGotoOptions) => Promise<unknown>;
  goBack: (options?: Parameters<Page["goBack"]>[0]) => Promise<unknown>;
  back: (options?: Parameters<Page["goBack"]>[0]) => Promise<unknown>;
  url: () => string;
  title: () => Promise<string>;
  waitForSelector: (
    selector: string,
    options?: SessionWaitForSelectorOptions
  ) => Promise<unknown>;
  click: (selector: string, options?: SessionClickOptions) => Promise<unknown>;
  fill: (selector: string, text: string) => Promise<unknown>;
  type: (
    selector: string,
    text: string,
    options?: SessionTypeOptions
  ) => Promise<unknown>;
  evaluate: <T>(fn: (...args: any[]) => T, ...args: any[]) => Promise<T>;
  locator: (selector: string) => ReturnType<Page["locator"]>;
  content: () => Promise<string>;
  screenshot: (options?: SessionScreenshotOptions) => Promise<unknown>;
  pdf: (options?: SessionPdfOptions) => Promise<unknown>;
  computer: (body: SessionComputerParams) => Promise<SessionComputerResponse>;
  captchasStatus: () => Promise<CaptchaStatusResponse>;
  captchasSolve: () => Promise<CaptchaSolveResponse>;
}

type TrackedSession = {
  metadata: SessionMetadata;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  liveSession: LiveSteelSession;
};

export interface SteelClientOptions {
  sessionTimeoutMs?: number;
  sessionCreateOptions?: Partial<SessionCreateOptions>;
}

export interface SessionRefreshOptions {
  useProxy?: boolean;
  proxyUrl?: string | null;
}

const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off"]);

function parseBooleanEnv(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return undefined;
  }

  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (TRUE_ENV_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_ENV_VALUES.has(normalized)) {
    return false;
  }

  throw toolError(
    "SteelClient initialization",
    `${name} must be a boolean value (one of: ${[...TRUE_ENV_VALUES, ...FALSE_ENV_VALUES].join(", ")}).`
  );
}

function parseProxyUrlEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return undefined;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = new URL(trimmed);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("proxy URL protocol must be http or https");
    }
    return parsed.toString();
  } catch (error: unknown) {
    throw toolError(
      "SteelClient initialization",
      `${name} is invalid: ${error instanceof Error ? error.message : "invalid URL"}`
    );
  }
}

function resolveSessionCreateOptionsFromEnv(): Partial<SessionCreateOptions> {
  const resolved: Partial<SessionCreateOptions> = {};
  const solveCaptcha = parseBooleanEnv("STEEL_SOLVE_CAPTCHA");
  const useProxy = parseBooleanEnv("STEEL_USE_PROXY");
  const proxyUrl = parseProxyUrlEnv("STEEL_PROXY_URL");

  if (solveCaptcha !== undefined) {
    resolved.solveCaptcha = solveCaptcha;
  }
  if (useProxy !== undefined) {
    resolved.useProxy = useProxy;
  }
  if (proxyUrl !== undefined) {
    resolved.proxyUrl = proxyUrl;
  }

  return resolved;
}

export class SteelClient {
  private static readonly DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

  private readonly client: Steel;
  private readonly apiKey: string;
  private readonly sessionTimeoutMs: number;
  private readonly sessionCreateOptions: Partial<SessionCreateOptions>;
  private currentSession: TrackedSession | null = null;
  private readonly sessions = new Map<string, TrackedSession>();
  private creatingSession: Promise<TrackedSession> | null = null;

  constructor(apiKey?: string, options: SteelClientOptions = {}) {
    const resolvedApiKey = (typeof apiKey === "string" ? apiKey : process.env.STEEL_API_KEY)?.trim();
    if (!resolvedApiKey) {
      throw toolError(
        "SteelClient initialization",
        "STEEL_API_KEY is required. Set it explicitly in the SteelClient constructor or via the environment variable."
      );
    }

    const configuredTimeout =
      options.sessionTimeoutMs === undefined
        ? undefined
        : Number(options.sessionTimeoutMs);

    const fallbackTimeout = Number.parseInt(
      process.env.STEEL_SESSION_TIMEOUT_MS || "",
      10
    );

    const normalizedConfiguredTimeout =
      typeof configuredTimeout === "number" &&
      Number.isFinite(configuredTimeout) &&
      configuredTimeout > 0
        ? configuredTimeout
        : undefined;
    const normalizedFallbackTimeout =
      Number.isFinite(fallbackTimeout) && fallbackTimeout > 0
        ? fallbackTimeout
        : undefined;
    const resolvedTimeout =
      normalizedConfiguredTimeout ??
      normalizedFallbackTimeout ??
      SteelClient.DEFAULT_SESSION_TIMEOUT_MS;

    this.client = new Steel({ steelAPIKey: resolvedApiKey });
    this.apiKey = resolvedApiKey;
    this.sessionTimeoutMs = resolvedTimeout;
    this.sessionCreateOptions = {
      ...resolveSessionCreateOptionsFromEnv(),
      ...(options.sessionCreateOptions ?? {}),
    };
  }

  async getOrCreateSession(): Promise<LiveSteelSession> {
    if (this.currentSession) {
      return this.currentSession.liveSession;
    }

    if (!this.creatingSession) {
      this.creatingSession = this.createSession();
    }

    const tracked = await this.creatingSession;
    return tracked.liveSession;
  }

  isProxyConfigured(): boolean {
    const { useProxy, proxyUrl } = this.sessionCreateOptions;
    if (typeof proxyUrl === "string" && proxyUrl.trim().length > 0) {
      return true;
    }
    if (typeof useProxy === "boolean") {
      return useProxy;
    }
    return useProxy !== undefined;
  }

  async refreshSession(options: SessionRefreshOptions = {}): Promise<LiveSteelSession> {
    const currentSessionId = this.currentSession?.metadata.id;
    if (currentSessionId) {
      await this.closeSession(currentSessionId);
    }

    this.creatingSession = this.createSession(
      this.resolveSessionCreateOptions(options)
    );
    const tracked = await this.creatingSession;
    return tracked.liveSession;
  }

  async closeSession(sessionId?: string): Promise<void> {
    const targetSessionId = sessionId ?? this.currentSession?.metadata.id;
    if (!targetSessionId) {
      return;
    }

    const tracked = this.sessions.get(targetSessionId);
    this.sessions.delete(targetSessionId);

    if (this.currentSession?.metadata.id === targetSessionId) {
      this.currentSession = null;
    }

    if (!tracked) {
      return;
    }

    await Promise.allSettled([
      tracked.browser.close(),
      this.client.sessions.release(targetSessionId),
    ]);
  }

  async closeAllSessions(): Promise<void> {
    const trackedSessions = [...this.sessions.values()];
    const sessionIds = trackedSessions.map((tracked) => tracked.metadata.id);
    this.sessions.clear();
    this.currentSession = null;
    this.creatingSession = null;

    if (sessionIds.length === 0) {
      return;
    }

    await Promise.allSettled(
      trackedSessions.map((tracked) => tracked.browser.close())
    );

    const releaseResult = await Promise.allSettled(
      sessionIds.map((sessionId) => this.client.sessions.release(sessionId))
    );

    const allRejected = releaseResult.every((entry) => entry.status === "rejected");
    if (allRejected) {
      await this.client.sessions.releaseAll();
    }
  }

  private resolveSessionCreateOptions(
    options: SessionRefreshOptions = {}
  ): Partial<SessionCreateOptions> {
    const merged: Partial<SessionCreateOptions> = {
      ...this.sessionCreateOptions,
    };

    if (options.useProxy !== undefined) {
      merged.useProxy = options.useProxy;
      if (options.useProxy === false && options.proxyUrl === undefined) {
        delete merged.proxyUrl;
      }
    }

    if (options.proxyUrl === null) {
      delete merged.proxyUrl;
    } else if (typeof options.proxyUrl === "string" && options.proxyUrl.trim()) {
      merged.proxyUrl = options.proxyUrl.trim();
    }

    return merged;
  }

  private async createSession(
    createOptions: Partial<SessionCreateOptions> = this.sessionCreateOptions
  ): Promise<TrackedSession> {
    try {
      const session = await this.client.sessions.create({
        ...createOptions,
        timeout: this.sessionTimeoutMs,
        blockAds: true,
      });

      const websocketUrl = this.withApiKey(session.websocketUrl?.trim());
      if (!websocketUrl) {
        throw new Error("Steel session did not include a websocketUrl.");
      }

      const browser = await chromium.connectOverCDP(websocketUrl);
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());
      const liveSession = this.buildLiveSession(session, page);

      const tracked: TrackedSession = {
        metadata: session,
        browser,
        context,
        page,
        liveSession,
      };

      this.sessions.set(session.id, tracked);
      this.currentSession = tracked;
      return tracked;
    } catch (error: unknown) {
      throw toolError("SteelClient session creation", error);
    } finally {
      this.creatingSession = null;
    }
  }

  private buildLiveSession(
    session: SessionMetadata,
    page: Page
  ): LiveSteelSession {
    return {
      id: session.id,
      sessionViewerUrl:
        session.sessionViewerUrl ||
        `https://app.steel.dev/sessions/${session.id}`,
      debugUrl: session.debugUrl || "",
      page,
      goto: (url, options) => page.goto(url, options),
      goBack: (options) => page.goBack(options),
      back: (options) => page.goBack(options),
      url: () => page.url(),
      title: () => page.title(),
      waitForSelector: (selector, options) =>
        options
          ? page.waitForSelector(selector, options)
          : page.waitForSelector(selector),
      click: (selector, options) => page.click(selector, options),
      fill: (selector, text) => page.fill(selector, text),
      type: (selector, text, options) => page.type(selector, text, options),
      evaluate: <T>(fn: (...args: any[]) => T, ...args: any[]) =>
        page.evaluate(fn, ...args),
      locator: (selector: string) => page.locator(selector),
      content: () => page.content(),
      screenshot: (options) => page.screenshot(options),
      pdf: (options) => page.pdf(options),
      computer: (body) => this.client.sessions.computer(session.id, body),
      captchasStatus: () => this.client.sessions.captchas.status(session.id),
      captchasSolve: () => this.client.sessions.captchas.solve(session.id),
    };
  }

  private withApiKey(websocketUrl?: string): string | null {
    if (!websocketUrl) {
      return null;
    }

    try {
      const parsed = new URL(websocketUrl);
      if (!parsed.searchParams.get("apiKey")) {
        parsed.searchParams.set("apiKey", this.apiKey);
      }
      return parsed.toString();
    } catch {
      if (/(?:[?&])apiKey=/.test(websocketUrl)) {
        return websocketUrl;
      }
      const separator = websocketUrl.includes("?") ? "&" : "?";
      return `${websocketUrl}${separator}apiKey=${encodeURIComponent(this.apiKey)}`;
    }
  }
}
