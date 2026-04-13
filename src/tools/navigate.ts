import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { sessionDetails, type SteelClient } from "../steel-client.js";
import {
  emitProgress,
  throwIfAborted,
  withAbortSignal,
  withToolError,
  type ToolProgressUpdater,
} from "./tool-runtime.js";

type WaitUntil = "load" | "domcontentloaded" | "networkidle";

type SessionLike = {
  id: string;
  sessionViewerUrl?: string | null;
  goto?: (
    url: string,
    options?: { waitUntil?: WaitUntil }
  ) => Promise<unknown> | unknown;
};

const ALLOWED_WAIT_UNTIL: readonly WaitUntil[] = ["load", "domcontentloaded", "networkidle"];
const DEFAULT_WAIT_UNTIL: WaitUntil = "networkidle";
const FALLBACK_WAIT_UNTILS: readonly WaitUntil[] = ["domcontentloaded", "load"];
const DEFAULT_NAVIGATION_RETRIES = 1;
const NAVIGATE_CONTEXT = "steel_navigate";

type SessionRefreshOptions = {
  useProxy?: boolean;
  proxyUrl?: string | null;
};

type SessionRefreshClient = {
  refreshSession?: (options?: SessionRefreshOptions) => Promise<SessionLike>;
  isProxyConfigured?: () => boolean;
};

function resolveWaitUntil(waitUntil?: string): WaitUntil {
  if (waitUntil !== undefined && ALLOWED_WAIT_UNTIL.includes(waitUntil as WaitUntil)) {
    return waitUntil as WaitUntil;
  }
  return DEFAULT_WAIT_UNTIL;
}

function normalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error("URL cannot be empty.");
  }

  const hasSchemeWithAuthority = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed);
  const hasSchemeWithoutAuthority = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed);
  const looksLikeHostWithPort = /^[^/\s:]+:\d+(?:[/?#]|$)/.test(trimmed);
  const normalized = trimmed.startsWith("//")
    ? `https:${trimmed}`
    : hasSchemeWithAuthority || (hasSchemeWithoutAuthority && !looksLikeHostWithPort)
      ? trimmed
      : `https://${trimmed}`;

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Only http and https URLs are supported.");
    }
    return parsed.toString();
  } catch (error) {
    throw new Error(`Invalid URL: ${String(error instanceof Error ? error.message : "invalid URL")}`);
  }
}

function normalizeRetryCount(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_NAVIGATION_RETRIES;
  }

  const value = raw.trim();
  if (!value) {
    return DEFAULT_NAVIGATION_RETRIES;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_NAVIGATION_RETRIES;
  }

  return Math.min(parsed, 3);
}

function isTimeoutError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error || "");
  return /timed? ?out|timeout/i.test(message);
}

function isNetworkError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error || "");
  return /ERR_|ECONN|ENOTFOUND|EAI_AGAIN|DNS|network/i.test(message);
}

function isTunnelConnectionError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error || "");
  return /ERR_TUNNEL_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED/i.test(message);
}

function buildWaitStrategy(preferred: WaitUntil): WaitUntil[] {
  const ordered = [preferred, ...FALLBACK_WAIT_UNTILS];
  const deduped: WaitUntil[] = [];
  for (const value of ordered) {
    if (!deduped.includes(value)) {
      deduped.push(value);
    }
  }
  return deduped;
}

async function navigateWithRecovery(
  session: SessionLike,
  options: {
    targetUrl: string;
    waitUntil: WaitUntil;
    onUpdate: ToolProgressUpdater;
    signal: AbortSignal | undefined;
  }
): Promise<WaitUntil> {
  const { targetUrl, waitUntil, onUpdate, signal } = options;
  throwIfAborted(signal);
  if (!session.goto) {
    throw new Error("Session does not support navigation.");
  }

  const retryCount = normalizeRetryCount(process.env.STEEL_NAVIGATE_RETRY_COUNT);
  const waitStrategy = buildWaitStrategy(waitUntil);
  let lastError: unknown = null;

  for (let waitIndex = 0; waitIndex < waitStrategy.length; waitIndex += 1) {
    throwIfAborted(signal);
    const waitMode = waitStrategy[waitIndex];
    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
      throwIfAborted(signal);
      try {
        await emitProgress(
          onUpdate,
          NAVIGATE_CONTEXT,
          `Navigating with ${waitMode} (attempt ${attempt + 1}/${retryCount + 1})`
        );
        await withAbortSignal(
          Promise.resolve(session.goto(targetUrl, { waitUntil: waitMode })),
          signal
        );
        return waitMode;
      } catch (error: unknown) {
        throwIfAborted(signal);
        lastError = error;
        const canRetryNetwork = attempt < retryCount && isNetworkError(error);
        if (canRetryNetwork) {
          await emitProgress(
            onUpdate,
            NAVIGATE_CONTEXT,
            `Network issue detected; retrying ${waitMode}`
          );
          continue;
        }
        if (
          waitIndex < waitStrategy.length - 1 &&
          isTimeoutError(error)
        ) {
          await emitProgress(
            onUpdate,
            NAVIGATE_CONTEXT,
            `Timeout on ${waitMode}; falling back to ${waitStrategy[waitIndex + 1]}`
          );
        }
        break;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Navigation failed");
}

async function refreshNavigationSession(
  client: SteelClient,
  options?: SessionRefreshOptions
): Promise<SessionLike | null> {
  const refresh = (client as unknown as SessionRefreshClient).refreshSession;
  if (typeof refresh !== "function") {
    return null;
  }
  return refresh(options);
}

function shouldTryNoProxyFallback(client: SteelClient): boolean {
  const isProxyConfigured = (client as unknown as SessionRefreshClient)
    .isProxyConfigured;
  if (typeof isProxyConfigured !== "function") {
    return false;
  }
  return isProxyConfigured();
}

export function navigateTool(client: SteelClient): ToolDefinition<any, any> {
  return {
    name: "steel_navigate",
    label: "Navigate",
    description: "Navigate to a URL in the browser",
    parameters: Type.Object({
      url: Type.String({ description: "The URL to navigate to" }),
      waitUntil: Type.Optional(
        Type.Union([
          Type.Literal("load"),
          Type.Literal("domcontentloaded"),
          Type.Literal("networkidle"),
        ], { description: "When to consider navigation complete" })
      ),
    }),

    async execute(
      _toolCallId: string,
      params: { url: string; waitUntil?: WaitUntil },
      signal: AbortSignal | undefined,
      onUpdate: ToolProgressUpdater,
      _ctx: ExtensionContext
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: object }> {
      return withToolError("steel_navigate", async () => {
        throwIfAborted(signal);
        const targetUrl = normalizeUrl(params.url);
        const waitUntil = resolveWaitUntil(params.waitUntil);

        await emitProgress(onUpdate, NAVIGATE_CONTEXT, `Preparing navigation to ${targetUrl}`);
        await emitProgress(onUpdate, NAVIGATE_CONTEXT, `Waiting for browser session`);

        let session = (await withAbortSignal(
          client.getOrCreateSession(),
          signal
        )) as SessionLike;
        let usedWaitUntil: WaitUntil;
        let recoveryMode: "none" | "fresh_session" | "no_proxy" = "none";

        try {
          usedWaitUntil = await navigateWithRecovery(session, {
            targetUrl,
            waitUntil,
            onUpdate,
            signal,
          });
        } catch (error: unknown) {
          throwIfAborted(signal);
          if (!isTunnelConnectionError(error)) {
            throw error;
          }

          await emitProgress(
            onUpdate,
            NAVIGATE_CONTEXT,
            "Tunnel connection failed; recreating browser session and retrying"
          );
          const freshSession = await withAbortSignal(
            refreshNavigationSession(client),
            signal
          );
          if (!freshSession) {
            throw error;
          }
          session = freshSession;

          try {
            usedWaitUntil = await navigateWithRecovery(session, {
              targetUrl,
              waitUntil,
              onUpdate,
              signal,
            });
            recoveryMode = "fresh_session";
          } catch (freshError: unknown) {
            throwIfAborted(signal);
            if (
              !isTunnelConnectionError(freshError) ||
              !shouldTryNoProxyFallback(client)
            ) {
              throw freshError;
            }

            await emitProgress(
              onUpdate,
              NAVIGATE_CONTEXT,
              "Tunnel failure persisted; retrying once with proxy disabled"
            );
            const noProxySession = await withAbortSignal(
              refreshNavigationSession(client, {
                useProxy: false,
                proxyUrl: null,
              }),
              signal
            );
            if (!noProxySession) {
              throw freshError;
            }
            session = noProxySession;
            usedWaitUntil = await navigateWithRecovery(session, {
              targetUrl,
              waitUntil,
              onUpdate,
              signal,
            });
            recoveryMode = "no_proxy";
          }
        }
        await emitProgress(onUpdate, NAVIGATE_CONTEXT, `Navigation complete to ${targetUrl}`);

        return {
          content: [{
            type: "text",
            text: `Successfully navigated to ${targetUrl}`,
          }],
          details: {
            ...sessionDetails(session),
            requestedUrl: params.url,
            url: targetUrl,
            waitUntil: usedWaitUntil,
            requestedWaitUntil: waitUntil,
            tunnelRecovery:
              recoveryMode === "none"
                ? null
                : {
                    attempted: true,
                    mode: recoveryMode,
            },
          },
        };
      }, signal);
    },
  };
}
