import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { SteelClient } from "../steel-client.js";
import { runWithCaptchaRecovery, type CaptchaRecoverySummary } from "./captcha-guard.js";
import {
  emitProgress,
  throwIfAborted,
  withAbortSignal,
  withToolError,
  type ToolProgressUpdater,
} from "./tool-runtime.js";
import {
  MAX_TOOL_TIMEOUT_MS,
  resolveToolTimeoutMs,
} from "./tool-settings.js";

type WaitState = "attached" | "visible";

type SessionLike = {
  id: string;
  captchasStatus?: () => Promise<unknown>;
  captchasSolve?: () => Promise<unknown>;
  waitForSelector?: (
    selector: string,
    options?: { state?: WaitState; timeout?: number }
  ) => Promise<unknown>;
  click?: (selector: string, options?: { timeout?: number }) => Promise<unknown>;
  evaluate?: <T>(fn: (...args: any[]) => T, ...args: any[]) => Promise<T>;
  locator?: (selector: string) => {
    waitFor?: (options?: { state?: WaitState; timeout?: number }) => Promise<unknown>;
    isVisible?: () => Promise<boolean>;
    isEnabled?: () => Promise<boolean>;
    click?: (options?: { timeout?: number }) => Promise<unknown>;
  };
  page?: {
    waitForSelector?: (
      selector: string,
      options?: { state?: WaitState; timeout?: number }
    ) => Promise<unknown>;
    click?: (selector: string, options?: { timeout?: number }) => Promise<unknown>;
    locator?: (selector: string) => {
      waitFor?: (options?: { state?: WaitState; timeout?: number }) => Promise<unknown>;
      isVisible?: () => Promise<boolean>;
      isEnabled?: () => Promise<boolean>;
      click?: (options?: { timeout?: number }) => Promise<unknown>;
    };
    evaluate?: <T>(fn: (...args: any[]) => T, ...args: any[]) => Promise<T>;
  };
};

function sessionDetails(session: SessionLike) {
  return {
    sessionId: session.id,
    sessionViewerUrl: `https://app.steel.dev/sessions/${session.id}`,
  };
}

function compactCaptchaRecovery(summary: CaptchaRecoverySummary) {
  return {
    triggered: summary.triggered,
    retries: summary.retries,
    solveAttempts: summary.solveAttempts,
    statusChecks: summary.statusChecks,
    waitTimedOut: summary.waitTimedOut,
  };
}

function normalizeSelector(selector: string): string {
  const trimmed = selector.trim();
  if (!trimmed) {
    throw new Error("Selector cannot be empty.");
  }
  return trimmed;
}

function normalizeTimeout(timeoutMs?: number): number {
  return resolveToolTimeoutMs(timeoutMs);
}

function getLocator(
  session: SessionLike,
  selector: string
):
  | {
      waitFor?: (options?: { state?: WaitState; timeout?: number }) => Promise<unknown>;
      isVisible?: () => Promise<boolean>;
      isEnabled?: () => Promise<boolean>;
      click?: (options?: { timeout?: number }) => Promise<unknown>;
    }
  | undefined {
  if (typeof session.locator === "function") {
    return session.locator(selector);
  }

  if (typeof session.page?.locator === "function") {
    return session.page.locator(selector);
  }

  return undefined;
}

function supportsCssSelectorFallback(selector: string): boolean {
  const normalized = selector.trim();
  if (!normalized) {
    return false;
  }
  if (
    normalized.includes(">>") ||
    normalized.includes("text=") ||
    normalized.includes("xpath=") ||
    normalized.includes("nth=") ||
    normalized.includes(":has-text(") ||
    normalized.includes(":text(") ||
    normalized.includes(":contains(")
  ) {
    return false;
  }
  return true;
}

async function waitForTarget(
  session: SessionLike,
  selector: string,
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<void> {
  throwIfAborted(signal);
  const locator = getLocator(session, selector);
  if (locator?.waitFor) {
    await withAbortSignal(
      locator.waitFor({ state: "visible", timeout: timeoutMs }),
      signal
    );
    return;
  }

  if (typeof session.waitForSelector === "function") {
    await withAbortSignal(
      session.waitForSelector(selector, { state: "visible", timeout: timeoutMs }),
      signal
    );
    return;
  }

  if (typeof session.page?.waitForSelector === "function") {
    await withAbortSignal(
      session.page.waitForSelector(selector, { state: "visible", timeout: timeoutMs }),
      signal
    );
  }
}

async function ensureClickable(
  session: SessionLike,
  selector: string,
  signal: AbortSignal | undefined
): Promise<void> {
  throwIfAborted(signal);
  const locator = getLocator(session, selector);
  if (locator) {
    if (typeof locator.isVisible === "function") {
      const visible = await withAbortSignal(locator.isVisible(), signal);
      if (!visible) {
        throw new Error(`Element is not visible: ${selector}`);
      }
    }
    if (typeof locator.isEnabled === "function") {
      const enabled = await withAbortSignal(locator.isEnabled(), signal);
      if (!enabled) {
        throw new Error(`Element is disabled and cannot be clicked: ${selector}`);
      }
    }
    return;
  }

  if (!supportsCssSelectorFallback(selector)) {
    return;
  }

  const evaluate = session.evaluate ?? session.page?.evaluate;
  if (typeof evaluate !== "function") {
    return;
  }

  const result = await withAbortSignal(
    evaluate(
    (input: { selector: string }) => {
      const element = document.querySelector(input.selector) as HTMLElement | null;
      if (!element) {
        return { found: false, clickable: false, disabled: false };
      }
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number.parseFloat(style.opacity) > 0;
      const disabled =
        (element as HTMLInputElement).disabled === true ||
        element.getAttribute("aria-disabled") === "true";
      const clickable = visible && !disabled && style.pointerEvents !== "none";
      return { found: true, clickable, disabled };
    },
    { selector }
  ),
    signal
  );

  if (!result || typeof result !== "object") {
    return;
  }

  const found = Boolean((result as Record<string, unknown>).found);
  const clickable = Boolean((result as Record<string, unknown>).clickable);
  const disabled = Boolean((result as Record<string, unknown>).disabled);
  if (!found) {
    throw new Error(`No element matched selector: ${selector}`);
  }
  if (disabled) {
    throw new Error(`Element is disabled and cannot be clicked: ${selector}`);
  }
  if (!clickable) {
    throw new Error(`Element is not clickable: ${selector}`);
  }
}

async function invokeClick(
  session: SessionLike,
  selector: string,
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<void> {
  throwIfAborted(signal);
  const locator = getLocator(session, selector);
  if (locator?.click) {
    await withAbortSignal(locator.click({ timeout: timeoutMs }), signal);
    return;
  }

  if (typeof session.click === "function") {
    await withAbortSignal(session.click(selector, { timeout: timeoutMs }), signal);
    return;
  }

  if (typeof session.page?.click === "function") {
    await withAbortSignal(
      session.page.click(selector, { timeout: timeoutMs }),
      signal
    );
    return;
  }

  const pageEvaluate = session.evaluate ?? session.page?.evaluate;
  if (typeof pageEvaluate === "function" && supportsCssSelectorFallback(selector)) {
    const clicked = await withAbortSignal(
      pageEvaluate(
        (input: { selector: string }) => {
          const element = document.querySelector(input.selector) as HTMLElement | null;
          if (!element) {
            return false;
          }
          element.click();
          return true;
        },
        { selector }
      ),
      signal
    );

    if (clicked) {
      return;
    }
  }

  throw new Error("Session does not support click operations.");
}

export function clickTool(client: SteelClient): ToolDefinition<any, any> {
  return {
    name: "steel_click",
    label: "Click",
    description: "Click an element in the page",
    parameters: Type.Object(
      {
        selector: Type.String({ description: "CSS selector of the element to click" }),
        timeout: Type.Optional(
          Type.Integer({
            minimum: 100,
            maximum: MAX_TOOL_TIMEOUT_MS,
            description: "Maximum milliseconds to wait for the element",
          })
        ),
      }
    ),

    async execute(
      _toolCallId: string,
      params: { selector: string; timeout?: number },
      signal: AbortSignal | undefined,
      onUpdate: ToolProgressUpdater,
      _ctx: ExtensionContext
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: object }> {
      return withToolError("steel_click", async () => {
        throwIfAborted(signal);
        const selector = normalizeSelector(params.selector);
        const timeoutMs = normalizeTimeout(params.timeout);

        await emitProgress(onUpdate, "steel_click", `Preparing click for ${selector}`);
        const session = (await withAbortSignal(
          client.getOrCreateSession(),
          signal
        )) as SessionLike;
        await emitProgress(onUpdate, "steel_click", "Running click sequence");
        const captchaRecovery = await runWithCaptchaRecovery({
          session,
          context: "steel_click",
          actionLabel: `click ${selector}`,
          onUpdate,
          signal,
          operation: async () => {
            throwIfAborted(signal);
            await waitForTarget(session, selector, timeoutMs, signal);
            throwIfAborted(signal);
            await ensureClickable(session, selector, signal);
            throwIfAborted(signal);
            await invokeClick(session, selector, timeoutMs, signal);
          },
        });
        await emitProgress(onUpdate, "steel_click", "Click succeeded");

        return {
          content: [{ type: "text", text: `Clicked element ${selector}` }],
          details: {
            ...sessionDetails(session),
            selector,
            timeoutMs,
            clicked: true,
            captchaRecovery: compactCaptchaRecovery(captchaRecovery),
          },
        };
      }, signal);
    },
  };
}
