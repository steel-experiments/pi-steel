import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

type SteelConfigFile = {
  apiKey?: unknown;
  browser?: {
    apiUrl?: unknown;
  } | null;
} | null;

type ResolvedSteelRuntimeConfig = {
  apiKey: string | null;
  baseURL?: string;
  baseURLOverridden: boolean;
  viewerBaseURL?: string;
};

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
  apiKey?: string | null;
  baseURL?: string;
  sessionTimeoutMs?: number;
  sessionCreateOptions?: Partial<SessionCreateOptions>;
}

export interface SessionRefreshOptions {
  useProxy?: boolean;
  proxyUrl?: string | null;
}

const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off"]);
const DEFAULT_STEEL_BASE_URL = "https://api.steel.dev";
const DEFAULT_STEEL_APP_URL = "https://app.steel.dev";

function normalizeConfigDir(input: string | undefined): string {
  const trimmed = input?.trim();
  if (trimmed) {
    return trimmed;
  }

  return path.join(os.homedir(), ".config", "steel");
}

function readSteelConfigFile(): SteelConfigFile {
  const configPath = path.join(
    normalizeConfigDir(process.env.STEEL_CONFIG_DIR),
    "config.json"
  );

  try {
    const contents = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(contents) as SteelConfigFile;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeSdkBaseURL(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("base URL must not be empty.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (error: unknown) {
    throw toolError(
      "SteelClient initialization",
      `Invalid Steel base URL: ${error instanceof Error ? error.message : "invalid URL"}`
    );
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw toolError(
      "SteelClient initialization",
      "Steel base URL must use http or https."
    );
  }

  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (pathname === "/v1") {
    parsed.pathname = "";
  }

  return parsed.toString().replace(/\/+$/, "");
}

function resolveViewerBaseURL(baseURL: string | undefined, overridden: boolean): string | undefined {
  if (!overridden || !baseURL) {
    return DEFAULT_STEEL_APP_URL;
  }

  try {
    const parsed = new URL(baseURL);
    const host = parsed.hostname.toLowerCase();
    if (
      host === "api.steel.dev" ||
      host.endsWith(".steel.dev")
    ) {
      return DEFAULT_STEEL_APP_URL;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function resolveSteelRuntimeConfig(
  apiKeyOverride?: string | null,
  baseURLOverride?: string
): ResolvedSteelRuntimeConfig {
  const config = readSteelConfigFile();

  const configApiKey = normalizeOptionalString(config?.apiKey);
  const configBrowserApiUrl = normalizeOptionalString(config?.browser?.apiUrl);

  const explicitApiKey = normalizeOptionalString(apiKeyOverride ?? undefined);
  const envApiKey = normalizeOptionalString(process.env.STEEL_API_KEY);
  const resolvedApiKey = explicitApiKey ?? envApiKey ?? configApiKey ?? null;

  const explicitBaseURL = normalizeOptionalString(baseURLOverride);
  const envBaseURL = normalizeOptionalString(process.env.STEEL_BASE_URL);
  const envBrowserApiURL = normalizeOptionalString(process.env.STEEL_BROWSER_API_URL);
  const envLocalApiURL = normalizeOptionalString(process.env.STEEL_LOCAL_API_URL);
  const envApiURL = normalizeOptionalString(process.env.STEEL_API_URL);

  const rawBaseURL =
    explicitBaseURL ??
    envBaseURL ??
    envBrowserApiURL ??
    envLocalApiURL ??
    configBrowserApiUrl ??
    envApiURL;

  const normalizedBaseURL = rawBaseURL
    ? normalizeSdkBaseURL(rawBaseURL)
    : undefined;
  const baseURLOverridden = normalizedBaseURL !== undefined;

  if (!resolvedApiKey && !baseURLOverridden) {
    throw toolError(
      "SteelClient initialization",
      "STEEL_API_KEY is required. Set it in the environment, run `steel login`, or configure a custom Steel base URL for self-hosted usage."
    );
  }

  return {
    apiKey: resolvedApiKey,
    baseURL: normalizedBaseURL,
    baseURLOverridden,
    viewerBaseURL: resolveViewerBaseURL(normalizedBaseURL, baseURLOverridden),
  };
}

function getSessionFieldString(
  session: Record<string, unknown>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = session[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

export function resolveSessionId(session: Record<string, unknown>): string | undefined {
  return getSessionFieldString(session, ["id", "sessionId"]);
}

export function resolveSessionConnectURL(session: Record<string, unknown>): string | undefined {
  return getSessionFieldString(session, [
    "websocketUrl",
    "wsUrl",
    "connectUrl",
    "cdpUrl",
    "browserWSEndpoint",
    "wsEndpoint",
  ]);
}

export function buildSessionConnectURL(
  session: Record<string, unknown>,
  apiKey?: string | null
): string | undefined {
  const rawConnectURL = resolveSessionConnectURL(session);
  const sessionId = resolveSessionId(session);

  if (!rawConnectURL) {
    if (!sessionId || !apiKey) {
      return undefined;
    }
    return `wss://connect.steel.dev?apiKey=${encodeURIComponent(apiKey)}&sessionId=${encodeURIComponent(sessionId)}`;
  }

  try {
    const parsed = new URL(rawConnectURL);
    if (apiKey && !parsed.searchParams.get("apiKey")) {
      parsed.searchParams.set("apiKey", apiKey);
    }
    if (sessionId && !parsed.searchParams.get("sessionId")) {
      parsed.searchParams.set("sessionId", sessionId);
    }
    return parsed.toString();
  } catch {
    const params = new URLSearchParams();
    if (apiKey && !/(?:[?&])apiKey=/.test(rawConnectURL)) {
      params.set("apiKey", apiKey);
    }
    if (sessionId && !/(?:[?&])sessionId=/.test(rawConnectURL)) {
      params.set("sessionId", sessionId);
    }
    const query = params.toString();
    if (!query) {
      return rawConnectURL;
    }
    const separator = rawConnectURL.includes("?") ? "&" : "?";
    return `${rawConnectURL}${separator}${query}`;
  }
}

export function resolveSessionViewerURL(
  session: Record<string, unknown>,
  viewerBaseURL?: string
): string | undefined {
  const explicit = getSessionFieldString(session, [
    "sessionViewerUrl",
    "viewerUrl",
    "liveViewUrl",
    "debugUrl",
  ]);
  if (explicit) {
    return explicit;
  }

  const sessionId = resolveSessionId(session);
  if (!sessionId || !viewerBaseURL) {
    return undefined;
  }

  return `${viewerBaseURL.replace(/\/+$/, "")}/sessions/${sessionId}`;
}

export function sessionDetails(session: {
  id: string;
  sessionViewerUrl?: string | null;
}) {
  return {
    sessionId: session.id,
    sessionViewerUrl:
      typeof session.sessionViewerUrl === "string"
        ? session.sessionViewerUrl
        : "",
  };
}

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

function parseStringEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return undefined;
  }

  const trimmed = raw.trim();
  return trimmed || undefined;
}

function resolveSessionCreateOptionsFromEnv(): Partial<SessionCreateOptions> {
  const resolved: Partial<SessionCreateOptions> = {};
  const solveCaptcha = parseBooleanEnv("STEEL_SOLVE_CAPTCHA");
  const useProxy = parseBooleanEnv("STEEL_USE_PROXY");
  const proxyUrl = parseProxyUrlEnv("STEEL_PROXY_URL");
  const headless = parseBooleanEnv("STEEL_SESSION_HEADLESS");
  const persistProfile = parseBooleanEnv("STEEL_SESSION_PERSIST_PROFILE");
  const useCredentials = parseBooleanEnv("STEEL_SESSION_CREDENTIALS");
  const region = parseStringEnv("STEEL_SESSION_REGION");
  const profileId = parseStringEnv("STEEL_SESSION_PROFILE_ID");
  const namespace = parseStringEnv("STEEL_SESSION_NAMESPACE");

  if (solveCaptcha !== undefined) {
    resolved.solveCaptcha = solveCaptcha;
  }
  if (useProxy !== undefined) {
    resolved.useProxy = useProxy;
  }
  if (proxyUrl !== undefined) {
    resolved.proxyUrl = proxyUrl;
  }
  if (headless !== undefined) {
    resolved.headless = headless;
  }
  if (persistProfile !== undefined) {
    resolved.persistProfile = persistProfile;
  }
  if (useCredentials) {
    resolved.credentials = {};
  }
  if (region !== undefined) {
    resolved.region = region;
  }
  if (profileId !== undefined) {
    resolved.profileId = profileId;
  }
  if (namespace !== undefined) {
    resolved.namespace = namespace;
  }

  return resolved;
}

export class SteelClient {
  private static readonly DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

  private readonly client: Steel;
  private readonly apiKey: string | null;
  private readonly sessionTimeoutMs: number;
  private readonly sessionCreateOptions: Partial<SessionCreateOptions>;
  private readonly viewerBaseURL?: string;
  private currentSession: TrackedSession | null = null;
  private readonly sessions = new Map<string, TrackedSession>();
  private creatingSession: Promise<TrackedSession> | null = null;

  constructor(apiKey?: string, options: SteelClientOptions = {}) {
    const runtimeConfig = resolveSteelRuntimeConfig(
      options.apiKey ?? apiKey,
      options.baseURL
    );
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

    this.client = new Steel({
      steelAPIKey: runtimeConfig.apiKey,
      baseURL: runtimeConfig.baseURL,
    });
    this.apiKey = runtimeConfig.apiKey;
    this.viewerBaseURL = runtimeConfig.viewerBaseURL;
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

      const websocketUrl = buildSessionConnectURL(
        session as unknown as Record<string, unknown>,
        this.apiKey
      );
      if (!websocketUrl) {
        throw new Error("Steel session did not include a connect URL.");
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
    const sessionId =
      resolveSessionId(session as unknown as Record<string, unknown>) ?? session.id;

    return {
      id: sessionId,
      sessionViewerUrl:
        resolveSessionViewerURL(
          session as unknown as Record<string, unknown>,
          this.viewerBaseURL
        ) ?? "",
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
      computer: (body) => this.client.sessions.computer(sessionId, body),
      captchasStatus: () => this.client.sessions.captchas.status(sessionId),
      captchasSolve: () => this.client.sessions.captchas.solve(sessionId),
    };
  }

}
