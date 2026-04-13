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

type ScrollDirection = "up" | "down";

type SessionLike = {
  id: string;
  sessionViewerUrl?: string | null;
  evaluate?: <T>(fn: (...args: any[]) => T, ...args: any[]) => Promise<T>;
  page?: {
    evaluate?: <T>(fn: (...args: any[]) => T, ...args: any[]) => Promise<T>;
  };
};

type ScrollResult = {
  before: number;
  after: number;
  maxScrollY: number;
  effectiveAmount: number;
  viewportHeight: number;
  contentHeight: number;
  targetType: "page" | "container";
  targetSelector: string | null;
};

const DEFAULT_SCROLL_AMOUNT = 800;
const MIN_SCROLL_AMOUNT = 50;
const MAX_SCROLL_AMOUNT = 5000;

function resolveDirection(rawDirection?: string): ScrollDirection {
  if (rawDirection === "up") {
    return "up";
  }
  if (rawDirection === "down") {
    return "down";
  }
  return "down";
}

function normalizeAmount(rawAmount?: number): number {
  if (rawAmount === undefined) {
    return DEFAULT_SCROLL_AMOUNT;
  }

  const parsed = Number(rawAmount);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("amount must be a positive number of pixels.");
  }

  const rounded = Math.trunc(parsed);
  return Math.max(MIN_SCROLL_AMOUNT, Math.min(rounded, MAX_SCROLL_AMOUNT));
}

function getSessionEvaluate(session: SessionLike): ((fn: (...args: any[]) => unknown, ...args: any[]) => Promise<unknown>) {
  if (typeof session.evaluate === "function") {
    return async (fn, ...args) => {
      return session.evaluate?.(fn, ...args);
    };
  }

  if (typeof session.page?.evaluate === "function") {
    return async (fn, ...args) => {
      return session.page?.evaluate?.(fn, ...args);
    };
  }

  throw new Error("Session does not support DOM evaluation.");
}

async function performScroll(
  session: SessionLike,
  direction: ScrollDirection,
  amount: number,
  selector?: string
): Promise<ScrollResult> {
  const evaluate = getSessionEvaluate(session);

  return evaluate(
    (input: {
      amount: number;
      direction: ScrollDirection;
      selector: string | null;
    }) => {
      const toSelector = (element: Element): string | null => {
        const tag = element.tagName.toLowerCase();
        const id = element.getAttribute("id");
        if (id) {
          return `#${id}`;
        }
        const testId = element.getAttribute("data-testid");
        if (testId) {
          return `${tag}[data-testid="${testId}"]`;
        }
        const name = element.getAttribute("name");
        if (name) {
          return `${tag}[name="${name}"]`;
        }
        const role = element.getAttribute("role");
        if (role) {
          return `${tag}[role="${role}"]`;
        }
        return tag;
      };

      const isScrollable = (element: Element): boolean => {
        const htmlElement = element as HTMLElement;
        const style = window.getComputedStyle(htmlElement);
        const overflowY = style.overflowY;
        const canOverflow = overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
        return canOverflow && htmlElement.scrollHeight > htmlElement.clientHeight + 4;
      };

      const isVisible = (element: Element): boolean => {
        const htmlElement = element as HTMLElement;
        const style = window.getComputedStyle(htmlElement);
        const rect = htmlElement.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number.parseFloat(style.opacity) > 0
        );
      };

      const findScrollableAncestor = (element: Element | null): Element | null => {
        let current = element;
        while (current) {
          if (isScrollable(current) && isVisible(current)) {
            return current;
          }
          current = current.parentElement;
        }
        return null;
      };

      const findBestScrollableContainer = (): Element | null => {
        const elements = Array.from(document.querySelectorAll("*"));
        let best: Element | null = null;
        let bestScore = -1;
        for (const element of elements) {
          if (!isScrollable(element) || !isVisible(element)) {
            continue;
          }
          const htmlElement = element as HTMLElement;
          const score = (htmlElement.scrollHeight - htmlElement.clientHeight) * Math.max(1, htmlElement.clientHeight);
          if (score > bestScore) {
            best = element;
            bestScore = score;
          }
        }
        return best;
      };

      const signedAmount = input.direction === "down" ? input.amount : -input.amount;

      const scrollElement = (element: HTMLElement, targetSelector: string | null): ScrollResult => {
        const before = Number(element.scrollTop || 0);
        const viewportHeight = Math.max(0, element.clientHeight);
        const contentHeight = Math.max(0, element.scrollHeight);
        const maxScrollY = Math.max(0, contentHeight - viewportHeight);
        const target = Math.max(0, Math.min(maxScrollY, before + signedAmount));
        element.scrollTo({ top: target, left: element.scrollLeft || 0 });
        return {
          before,
          after: Number(element.scrollTop || 0),
          maxScrollY,
          effectiveAmount: target - before,
          viewportHeight,
          contentHeight,
          targetType: "container",
          targetSelector,
        };
      };

      const explicitTarget = input.selector
        ? findScrollableAncestor(document.querySelector(input.selector))
        : null;
      if (explicitTarget) {
        return scrollElement(explicitTarget as HTMLElement, toSelector(explicitTarget));
      }

      const bodyHeight = document.body?.scrollHeight ?? 0;
      const docHeight = document.documentElement?.scrollHeight ?? 0;
      const contentHeight = Math.max(bodyHeight, docHeight, document.body?.offsetHeight ?? 0, document.documentElement?.offsetHeight ?? 0);
      const viewportHeight = Math.max(window.innerHeight, document.documentElement?.clientHeight ?? 0);
      const maxScrollY = Math.max(0, contentHeight - viewportHeight);
      const before = Number(window.scrollY || window.pageYOffset || 0);
      const target = Math.max(0, Math.min(maxScrollY, before + signedAmount));
      window.scrollTo({ top: target, left: window.pageXOffset || window.scrollX || 0 });
      const pageResult = {
        before,
        after: Number(window.scrollY || window.pageYOffset || 0),
        maxScrollY,
        effectiveAmount: target - before,
        viewportHeight,
        contentHeight,
        targetType: "page" as const,
        targetSelector: null,
      };

      if (pageResult.before !== pageResult.after || pageResult.contentHeight > pageResult.viewportHeight) {
        return pageResult;
      }

      const fallbackTarget = findBestScrollableContainer();
      if (fallbackTarget) {
        return scrollElement(fallbackTarget as HTMLElement, toSelector(fallbackTarget));
      }

      return pageResult;
    },
    { amount, direction, selector: selector ?? null }
  ) as Promise<ScrollResult>;
}

export function scrollTool(client: SteelClient): ToolDefinition<any, any> {
  return {
    name: "steel_scroll",
    label: "Scroll",
    description: "Scroll the current page or a visible scroll container up or down",
    parameters: Type.Object({
      direction: Type.Optional(
        Type.Union([Type.Literal("up"), Type.Literal("down")], {
          description: "Direction to scroll",
        })
      ),
      amount: Type.Optional(
        Type.Integer({
          minimum: MIN_SCROLL_AMOUNT,
          maximum: MAX_SCROLL_AMOUNT,
          description: "Pixel amount for one scroll action",
        })
      ),
      selector: Type.Optional(
        Type.String({
          description: "Optional selector for an element inside the scroll target; useful for nested panes like lists, sidebars, or map results",
        })
      ),
    }),

    async execute(
      _toolCallId: string,
      params: { direction?: ScrollDirection; amount?: number; selector?: string },
      signal: AbortSignal | undefined,
      onUpdate: ToolProgressUpdater,
      _ctx: ExtensionContext
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: object }> {
      return withToolError("steel_scroll", async () => {
        throwIfAborted(signal);
        const direction = resolveDirection(params.direction);
        const amount = normalizeAmount(params.amount);
        const selector = typeof params.selector === "string" && params.selector.trim()
          ? params.selector.trim()
          : undefined;
        const session = (await withAbortSignal(
          client.getOrCreateSession(),
          signal
        )) as SessionLike;

        const targetLabel = selector ? ` near ${selector}` : "";
        await emitProgress(onUpdate, "steel_scroll", `Preparing scroll ${direction} by ${amount}px${targetLabel}`);
        const result = await withAbortSignal(
          performScroll(session, direction, amount, selector),
          signal
        );

        if (result.contentHeight <= result.viewportHeight) {
          throw new Error("Page is not scrollable: content fits within viewport.");
        }

        if (result.before === result.after) {
          const edge = direction === "down" ? "bottom" : "top";
          throw new Error(`No scroll movement occurred; already at ${edge}.`);
        }

        await emitProgress(onUpdate, "steel_scroll", `Scroll movement: ${Math.abs(result.effectiveAmount)}px`);
        return {
          content: [{
            type: "text",
            text: `Scrolled ${direction} by ${Math.abs(result.effectiveAmount)}px.`,
          }],
          details: {
            ...sessionDetails(session),
            direction,
            requestedAmount: amount,
            requestedSelector: selector ?? null,
            effectiveAmount: Math.abs(result.effectiveAmount),
            before: result.before,
            after: result.after,
            maxScrollY: result.maxScrollY,
            targetType: result.targetType,
            targetSelector: result.targetSelector,
            bounds: {
              atTop: result.after <= 0,
              atBottom: result.after >= result.maxScrollY,
            },
          },
        };
      }, signal);
    },
  };
}
