import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sessionDetails, type SteelClient } from "../steel-client.js";
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
import {
  describeTarget,
  getTargetLocator,
  resolveTarget,
  targetParameterProperties,
  type BrowserTargetInput,
} from "./target.js";

type WaitState = "attached" | "visible";

type SessionLike = {
  id: string;
  sessionViewerUrl?: string | null;
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

function compactCaptchaRecovery(summary: CaptchaRecoverySummary) {
  return {
    triggered: summary.triggered,
    retries: summary.retries,
    solveAttempts: summary.solveAttempts,
    statusChecks: summary.statusChecks,
    waitTimedOut: summary.waitTimedOut,
  };
}

function normalizeTimeout(timeoutMs?: number): number {
  return resolveToolTimeoutMs(timeoutMs);
}

export function clickTool(client: SteelClient): ToolDefinition<any, any> {
  return {
    name: "steel_click",
    label: "Click",
    description:
      "Click an element by CSS selector, ARIA role/name, or visible text. Prefer role/name after steel_snapshot.",
    parameters: Type.Object(
      {
        ...targetParameterProperties,
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
      params: BrowserTargetInput & { timeout?: number },
      signal: AbortSignal | undefined,
      onUpdate: ToolProgressUpdater,
      _ctx: ExtensionContext
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: object }> {
      return withToolError("steel_click", async () => {
        throwIfAborted(signal);
        const target = resolveTarget(params);
        const targetLabel = describeTarget(target);
        const timeoutMs = normalizeTimeout(params.timeout);

        await emitProgress(onUpdate, "steel_click", `Preparing click for ${targetLabel}`);
        const session = (await withAbortSignal(
          client.getOrCreateSession(),
          signal
        )) as SessionLike;
        await emitProgress(onUpdate, "steel_click", "Running click sequence");
        const captchaRecovery = await runWithCaptchaRecovery({
          session,
          context: "steel_click",
          actionLabel: `click ${targetLabel}`,
          onUpdate,
          signal,
          operation: async () => {
            throwIfAborted(signal);
            const locator = getTargetLocator(session, target);
            if (locator.waitFor) {
              await withAbortSignal(
                locator.waitFor({ state: "visible", timeout: timeoutMs }),
                signal
              );
            }
            if (locator.isVisible && !(await withAbortSignal(locator.isVisible(), signal))) {
              throw new Error(`Element is not visible: ${targetLabel}`);
            }
            if (locator.isEnabled && !(await withAbortSignal(locator.isEnabled(), signal))) {
              throw new Error(`Element is disabled: ${targetLabel}`);
            }
            if (!locator.click) {
              throw new Error(`Session does not support clicking ${targetLabel}.`);
            }
            await withAbortSignal(locator.click({ timeout: timeoutMs }), signal);
          },
        });
        await emitProgress(onUpdate, "steel_click", "Click succeeded");

        return {
          content: [{ type: "text", text: `Clicked ${targetLabel}` }],
          details: {
            ...sessionDetails(session),
            target,
            selector: target.kind === "selector" ? target.selector : null,
            timeoutMs,
            clicked: true,
            captchaRecovery: compactCaptchaRecovery(captchaRecovery),
          },
        };
      }, signal);
    },
  };
}
