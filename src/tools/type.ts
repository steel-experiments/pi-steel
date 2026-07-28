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

type FieldActionState = {
  found: boolean;
  editable: boolean;
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

async function ensureField(session: SessionLike, selector: string, timeoutMs: number): Promise<FieldActionState> {
  if (typeof session.waitForSelector === "function") {
    await session.waitForSelector(selector, { state: "visible", timeout: timeoutMs });
  } else if (typeof session.page?.waitForSelector === "function") {
    await session.page.waitForSelector(selector, { state: "visible", timeout: timeoutMs });
  }

  const evaluate = session.evaluate ?? session.page?.evaluate;
  if (typeof evaluate !== "function") {
    return { found: true, editable: true };
  }

  return evaluate((rawSelector: string) => {
    const element = document.querySelector(rawSelector) as HTMLElement | null;
    if (!element) {
      return { found: false, editable: false };
    }

    const tag = element.tagName.toLowerCase();
    const isInputLike =
      tag === "input" ||
      tag === "textarea" ||
      element.isContentEditable;

    const htmlInput = element as HTMLInputElement;
    const editable = isInputLike && htmlInput.readOnly !== true;
    const disabled =
      (element as HTMLInputElement).disabled === true ||
      element.getAttribute("aria-disabled") === "true";

    return { found: true, editable: editable && !disabled };
  }, selector);
}

async function setValue(session: SessionLike, selector: string, text: string): Promise<void> {
  if (typeof session.fill === "function") {
    await session.fill(selector, text);
    return;
  }

  if (typeof session.page?.fill === "function") {
    await session.page.fill(selector, text);
    return;
  }

  const locator =
    typeof session.locator === "function"
      ? session.locator(selector)
      : session.page?.locator?.(selector);

  const locatorFill = locator?.fill;
  if (typeof locatorFill === "function") {
    await locatorFill.call(locator, text);
    return;
  }

  const evaluate = session.evaluate ?? session.page?.evaluate;
  if (typeof evaluate !== "function") {
    throw new Error("Session does not support setting input values.");
  }

  const result = await evaluate((input: { selector: string; value: string }) => {
    const element = document.querySelector(input.selector) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!element) {
      return false;
    }

    element.focus();
    element.value = input.value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, { selector, value: text });

  if (!result) {
    throw new Error(`Element not found: ${selector}`);
  }
}

async function typeValue(session: SessionLike, selector: string, text: string): Promise<void> {
  if (typeof session.type === "function") {
    await session.type(selector, text);
    return;
  }

  if (typeof session.page?.type === "function") {
    await session.page.type(selector, text);
    return;
  }

  const locator =
    typeof session.locator === "function"
      ? session.locator(selector)
      : session.page?.locator?.(selector);

  const locatorType = locator?.type;
  if (typeof locatorType === "function") {
    await locatorType.call(locator, text);
    return;
  }

  await setValue(session, selector, text);
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
