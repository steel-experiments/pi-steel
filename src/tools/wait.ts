import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sessionDetails as baseSessionDetails, type SteelClient } from "../steel-client.js";
import {
  emitProgress,
  sleepWithSignal,
  throwIfAborted,
  withAbortSignal,
  withToolError,
  type ToolProgressUpdater,
} from "./tool-runtime.js";
import {
  MAX_TOOL_TIMEOUT_MS,
  MIN_TOOL_TIMEOUT_MS,
  resolveToolTimeoutMs,
} from "./tool-settings.js";
import {
  describeTarget,
  getTargetLocator,
  resolveTarget,
  targetParameterProperties,
  type BrowserTargetInput,
  type TargetLocator,
} from "./target.js";

type WaitState = "attached" | "visible";
type SessionLike = {
  id: string;
  sessionViewerUrl?: string | null;
  waitForSelector?: (
    selector: string,
    options?: { state?: WaitState; timeout?: number }
  ) => Promise<unknown>;
  evaluate?: <T>(fn: (...args: any[]) => T, ...args: any[]) => Promise<T>;
  locator?: (selector: string) => TargetLocator;
  getByRole?: (role: never, options?: { name?: string; exact?: boolean }) => TargetLocator;
  getByText?: (text: string, options?: { exact?: boolean }) => TargetLocator;
  page?: {
    waitForSelector?: (
      selector: string,
      options?: { state?: WaitState; timeout?: number }
    ) => Promise<unknown>;
    evaluate?: <T>(fn: (...args: any[]) => T, ...args: any[]) => Promise<T>;
    locator?: (selector: string) => TargetLocator;
    getByRole?: (role: never, options?: { name?: string; exact?: boolean }) => TargetLocator;
    getByText?: (text: string, options?: { exact?: boolean }) => TargetLocator;
  };
  url?: (() => Promise<string> | string) | string;
};

const POLL_DELAY_MS = 100;

function sessionDetails(session: SessionLike, url: string) {
  return {
    ...baseSessionDetails(session),
    url,
  };
}

function normalizeSelector(rawSelector?: string): string {
  if (typeof rawSelector !== "string") {
    throw new Error("selector is required and must be a string.");
  }

  const trimmed = rawSelector.trim();
  if (!trimmed) {
    throw new Error("selector cannot be empty.");
  }

  return trimmed;
}

function resolveTimeout(rawTimeout?: number): number {
  return resolveToolTimeoutMs(rawTimeout);
}

function resolveState(rawState?: string): WaitState {
  if (rawState === "attached") {
    return "attached";
  }
  return "visible";
}

function getWaitFunction(session: SessionLike): ((selector: string, state: WaitState, timeoutMs: number, signal: AbortSignal | undefined) => Promise<void>) {
  if (typeof session.waitForSelector === "function") {
    return async (selector, state, timeoutMs, signal) => {
      throwIfAborted(signal);
      await withAbortSignal(
        session.waitForSelector?.(selector, { state, timeout: timeoutMs }) as Promise<unknown>,
        signal
      );
    };
  }

  if (typeof session.page?.waitForSelector === "function") {
    return async (selector, state, timeoutMs, signal) => {
      throwIfAborted(signal);
      await withAbortSignal(
        session.page?.waitForSelector?.(selector, { state, timeout: timeoutMs }) as Promise<unknown>,
        signal
      );
    };
  }

  const evaluate = session.evaluate ?? session.page?.evaluate;
  if (typeof evaluate !== "function") {
    throw new Error("Session does not support selector waiting.");
  }

  return async (selector, state, timeoutMs, signal) => {
    const deadline = Date.now() + timeoutMs;

    while (true) {
      throwIfAborted(signal);
      const isMatched = await withAbortSignal(
        evaluate(
        (input: { selector: string; state: WaitState }) => {
          const element = document.querySelector(input.selector);
          if (!element) {
            return false;
          }

          if (input.state === "attached") {
            return true;
          }

          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const isVisible =
            rect.width > 0 &&
            rect.height > 0 &&
            style.opacity !== "0" &&
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            Number.parseFloat(style.opacity) > 0;

          return isVisible;
        },
        { selector, state }
      ) as Promise<boolean>, signal);

      if (isMatched) {
        return;
      }

      if (Date.now() > deadline) {
        throw new Error("selector wait timed out");
      }

      await sleepWithSignal(Math.min(POLL_DELAY_MS, Math.max(10, deadline - Date.now())), signal);
    }
  };
}

async function readSessionUrl(session: SessionLike): Promise<string> {
  const direct = session.url;
  if (typeof direct === "string" && direct.trim()) {
    return direct;
  }

  if (typeof direct === "function") {
    const value = await direct.call(session);
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  const getter = (session as { getCurrentUrl?: () => Promise<string> | string }).getCurrentUrl;
  if (typeof getter === "function") {
    const value = await getter.call(session);
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return "unknown";
}

export function waitTool(client: SteelClient): ToolDefinition<any, any> {
  return {
    name: "steel_wait",
    label: "Wait",
    description:
      "Wait for an element by CSS selector, ARIA role/name, or visible text.",
    parameters: Type.Object({
      ...targetParameterProperties,
      timeout: Type.Optional(
        Type.Integer({
          minimum: MIN_TOOL_TIMEOUT_MS,
          maximum: MAX_TOOL_TIMEOUT_MS,
          description: "Maximum milliseconds to wait for selector state",
        })
      ),
      state: Type.Optional(
        Type.Union([Type.Literal("attached"), Type.Literal("visible")], {
          description: "Selector state to wait for",
        })
      ),
    }),

    async execute(
      _toolCallId: string,
      params: BrowserTargetInput & { timeout?: number; state?: WaitState },
      signal: AbortSignal | undefined,
      onUpdate: ToolProgressUpdater,
      _ctx: ExtensionContext
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: object }> {
      return withToolError("steel_wait", async () => {
        throwIfAborted(signal);
        const target = resolveTarget(params);
        const targetLabel = describeTarget(target);
        const timeoutMs = resolveTimeout(params.timeout);
        const state = resolveState(params.state);
        const session = (await withAbortSignal(client.getOrCreateSession(), signal)) as SessionLike;
        throwIfAborted(signal);
        const url = await readSessionUrl(session);

        await emitProgress(onUpdate, "steel_wait", `Waiting for ${targetLabel} with state ${state}`);

        try {
          const locator = getTargetLocator(session, target);
          if (!locator.waitFor) {
            throw new Error(`Session does not support waiting for ${targetLabel}.`);
          }
          await withAbortSignal(locator.waitFor({ state, timeout: timeoutMs }), signal);
        } catch (error) {
          const message = String(error instanceof Error ? error.message : "");
          if (/timed? ?out|timeout/i.test(message)) {
            throw new Error(`Timed out waiting for ${targetLabel} after ${timeoutMs}ms.`);
          }

          throw error instanceof Error
            ? error
            : new Error(`Failed to wait for ${targetLabel}`);
        }

        await emitProgress(onUpdate, "steel_wait", `Matched ${targetLabel}`);

        return {
          content: [{
            type: "text",
            text: `Target matched: ${targetLabel}`,
          }],
          details: {
            ...sessionDetails(session, url),
            target,
            selector: target.kind === "selector" ? target.selector : null,
            state,
            timeoutMs,
            success: true,
          },
        };
      }, signal);
    },
  };
}
