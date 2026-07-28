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

type SessionLike = {
  id: string;
  sessionViewerUrl?: string | null;
  captchasStatus?: () => Promise<unknown>;
  captchasSolve?: () => Promise<unknown>;
  waitForSelector?: (
    selector: string,
    options?: { state?: "attached" | "visible"; timeout?: number }
  ) => Promise<unknown>;
  fill?: (selector: string, text: string) => Promise<unknown>;
  type?: (selector: string, text: string, options?: { delay?: number }) => Promise<unknown>;
  evaluate?: <T>(fn: (...args: any[]) => T, ...args: any[]) => Promise<T>;
  locator?: (selector: string) => {
    fill?: (text: string) => Promise<unknown>;
    type?: (text: string, options?: { delay?: number }) => Promise<unknown>;
    waitFor?: (options?: { state?: "attached" | "visible"; timeout?: number }) => Promise<unknown>;
  };
  page?: {
    waitForSelector?: (
      selector: string,
      options?: { state?: "attached" | "visible"; timeout?: number }
    ) => Promise<unknown>;
    fill?: (selector: string, text: string) => Promise<unknown>;
    type?: (selector: string, text: string, options?: { delay?: number }) => Promise<unknown>;
    evaluate?: <T>(fn: (...args: any[]) => T, ...args: any[]) => Promise<T>;
    locator?: (selector: string) => {
      fill?: (text: string) => Promise<unknown>;
      type?: (text: string, options?: { delay?: number }) => Promise<unknown>;
      waitFor?: (options?: { state?: "attached" | "visible"; timeout?: number }) => Promise<unknown>;
    };
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

export function typeTool(client: SteelClient): ToolDefinition<any, any> {
  return {
    name: "steel_type",
    label: "Type",
    description:
      "Enter text into a field by CSS selector, ARIA role/name, or visible text. Prefer role/name after steel_snapshot.",
    parameters: Type.Object(
      {
        ...targetParameterProperties,
        text: Type.String({ description: "Text to type into the field" }),
        clear: Type.Optional(Type.Boolean({ description: "Whether to clear the field before typing" })),
        timeout: Type.Optional(
          Type.Integer({
            minimum: 100,
            maximum: MAX_TOOL_TIMEOUT_MS,
            description: "Maximum milliseconds to wait for the input",
          })
        ),
      }
    ),

    async execute(
      _toolCallId: string,
      params: BrowserTargetInput & {
        text: string;
        clear?: boolean;
        timeout?: number;
      },
      signal: AbortSignal | undefined,
      onUpdate: ToolProgressUpdater,
      _ctx: ExtensionContext
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: object }> {
      return withToolError("steel_type", async () => {
        throwIfAborted(signal);
        const target = resolveTarget(params);
        const targetLabel = describeTarget(target);
        const timeoutMs = normalizeTimeout(params.timeout);
        const text = params.text;
        const shouldClear = params.clear ?? true;

        await emitProgress(onUpdate, "steel_type", `Preparing input for ${targetLabel}`);
        const session = (await withAbortSignal(
          client.getOrCreateSession(),
          signal
        )) as SessionLike;
        await emitProgress(onUpdate, "steel_type", "Running field input sequence");
        const captchaRecovery = await runWithCaptchaRecovery({
          session,
          context: "steel_type",
          actionLabel: `type into ${targetLabel}`,
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
            if (locator.isEnabled && !(await withAbortSignal(locator.isEnabled(), signal))) {
              throw new Error(`Element is disabled: ${targetLabel}`);
            }
            await emitProgress(
              onUpdate,
              "steel_type",
              shouldClear ? "Clearing existing value" : "Typing into field"
            );
            if (shouldClear) {
              if (!locator.fill) {
                throw new Error(`Session does not support filling ${targetLabel}.`);
              }
              await withAbortSignal(locator.fill(text, { timeout: timeoutMs }), signal);
            } else {
              if (locator.pressSequentially) {
                await withAbortSignal(
                  locator.pressSequentially(text, { timeout: timeoutMs }),
                  signal
                );
              } else if (locator.fill) {
                await withAbortSignal(locator.fill(text, { timeout: timeoutMs }), signal);
              } else {
                throw new Error(`Session does not support typing into ${targetLabel}.`);
              }
            }
          },
        });
        await emitProgress(onUpdate, "steel_type", `Input applied to ${targetLabel}`);

        return {
          content: [{ type: "text", text: `Typed into ${targetLabel}` }],
          details: {
            ...sessionDetails(session),
            target,
            selector: target.kind === "selector" ? target.selector : null,
            timeoutMs,
            clear: shouldClear,
            textLength: text.length,
            captchaRecovery: compactCaptchaRecovery(captchaRecovery),
          },
        };
      }, signal);
    },
  };
}
