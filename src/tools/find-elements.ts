import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { sessionDetails as baseSessionDetails, type SteelClient } from "../steel-client.js";
import {
  emitProgress,
  throwIfAborted,
  withAbortSignal,
  withToolError,
  type ToolProgressUpdater,
} from "./tool-runtime.js";
import {
  blankPageError,
  isBlankPageUrl,
  readSessionUrl,
} from "./session-state.js";

type SessionLike = {
  id: string;
  sessionViewerUrl?: string | null;
  evaluate?: <T>(fn: (...args: any[]) => T, ...args: any[]) => Promise<T>;
  page?: {
    evaluate?: <T>(fn: (...args: any[]) => T, ...args: any[]) => Promise<T>;
  };
  url?: (() => Promise<string> | string) | string;
  getCurrentUrl?: () => Promise<string> | string;
};

type Candidate = {
  selector: string;
  text: string;
  tag: string;
  role: string | null;
  clickable: boolean;
  visible: boolean;
};

const MAX_RESULT_LIMIT = 25;

function normalizeLimit(rawLimit?: number): number {
  if (rawLimit === undefined) {
    return 10;
  }
  const parsed = Number(rawLimit);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("limit must be a positive integer.");
  }
  return Math.min(MAX_RESULT_LIMIT, Math.trunc(parsed));
}

function normalizeOptionalString(value?: string): string | null {
  if (value === undefined) {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  return normalized;
}

function sessionDetails(session: SessionLike, url: string) {
  return {
    ...baseSessionDetails(session),
    url,
  };
}

async function discoverElements(
  session: SessionLike,
  input: {
    query: string | null;
    tag: string | null;
    role: string | null;
    limit: number;
    clickableOnly: boolean;
  }
): Promise<Candidate[]> {
  const evaluate = session.evaluate ?? session.page?.evaluate;
  if (typeof evaluate !== "function") {
    throw new Error("Session does not support element discovery.");
  }

  const results = await evaluate((params: {
    query: string | null;
    tag: string | null;
    role: string | null;
    limit: number;
    clickableOnly: boolean;
  }) => {
    const toLower = (value: string | null | undefined): string =>
      String(value || "").toLowerCase();

    const normalize = (value: string | null | undefined): string =>
      String(value || "").replace(/\s+/g, " ").trim();

    const cssEscape = (value: string): string => {
      if ((window as unknown as { CSS?: { escape?: (v: string) => string } }).CSS?.escape) {
        return (window as unknown as { CSS: { escape: (v: string) => string } }).CSS.escape(value);
      }
      return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    };

    const isVisible = (element: Element): boolean => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        Number.parseFloat(style.opacity) > 0
      );
    };

    const isClickable = (element: Element): boolean => {
      const tag = element.tagName.toLowerCase();
      const role = element.getAttribute("role");
      if (["a", "button", "summary", "select"].includes(tag)) {
        return true;
      }
      if (tag === "input") {
        const input = element as HTMLInputElement;
        return input.type !== "hidden";
      }
      if (role === "button" || role === "link" || role === "menuitem") {
        return true;
      }
      if ((element as HTMLElement).onclick) {
        return true;
      }
      if (element.getAttribute("tabindex") !== null) {
        return true;
      }
      return false;
    };

    const buildSelector = (element: Element): string => {
      const tag = element.tagName.toLowerCase();
      const id = element.getAttribute("id");
      if (id && document.querySelectorAll(`#${cssEscape(id)}`).length === 1) {
        return `#${cssEscape(id)}`;
      }

      const testId = element.getAttribute("data-testid");
      if (testId) {
        return `${tag}[data-testid="${cssEscape(testId)}"]`;
      }

      const name = element.getAttribute("name");
      if (name) {
        return `${tag}[name="${cssEscape(name)}"]`;
      }

      const ariaLabel = element.getAttribute("aria-label");
      if (ariaLabel) {
        return `${tag}[aria-label="${cssEscape(ariaLabel)}"]`;
      }

      if (tag === "a") {
        const href = element.getAttribute("href");
        if (href) {
          return `a[href="${cssEscape(href)}"]`;
        }
      }

      const text = normalize(element.textContent);
      if (text) {
        return `text=${text.slice(0, 80)}`;
      }

      return tag;
    };

    const queryLower = toLower(params.query);
    const tagLower = toLower(params.tag);
    const roleLower = toLower(params.role);

    const source = Array.from(document.querySelectorAll("*"));
    const candidates = source
      .map((element) => {
        const tag = element.tagName.toLowerCase();
        const role = element.getAttribute("role");
        const text = normalize(element.textContent);
        const clickable = isClickable(element);
        const visible = isVisible(element);
        const searchBlob = toLower(
          `${text} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`
        );

        if (tagLower && tag !== tagLower) {
          return null;
        }
        if (roleLower && toLower(role) !== roleLower) {
          return null;
        }
        if (queryLower && !searchBlob.includes(queryLower)) {
          return null;
        }
        if (params.clickableOnly && !clickable) {
          return null;
        }
        if (!visible) {
          return null;
        }

        return {
          selector: buildSelector(element),
          text: text.slice(0, 200),
          tag,
          role,
          clickable,
          visible,
        };
      })
      .filter((item) => Boolean(item)) as Candidate[];

    return candidates.slice(0, params.limit);
  }, input);

  if (!Array.isArray(results)) {
    return [];
  }
  return results as Candidate[];
}

export function findElementsTool(client: SteelClient): ToolDefinition<any, any> {
  return {
    name: "steel_find_elements",
    label: "Find Elements",
    description: "Discover likely interactive elements and selector candidates",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: "Optional text query to filter by visible label/text" })
      ),
      tag: Type.Optional(
        Type.String({ description: "Optional exact tag name filter (e.g. button, a, input)" })
      ),
      role: Type.Optional(
        Type.String({ description: "Optional exact ARIA role filter (e.g. button, link)" })
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_RESULT_LIMIT,
          description: "Max number of candidates to return",
        })
      ),
      clickableOnly: Type.Optional(
        Type.Boolean({ description: "When true, include only likely interactive elements" })
      ),
    }),

    async execute(
      _toolCallId: string,
      params: {
        query?: string;
        tag?: string;
        role?: string;
        limit?: number;
        clickableOnly?: boolean;
      },
      signal: AbortSignal | undefined,
      onUpdate: ToolProgressUpdater,
      _ctx: ExtensionContext
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: object }> {
      return withToolError("steel_find_elements", async () => {
        throwIfAborted(signal);
        const query = normalizeOptionalString(params.query);
        const tag = normalizeOptionalString(params.tag);
        const role = normalizeOptionalString(params.role);
        const limit = normalizeLimit(params.limit);
        const clickableOnly = params.clickableOnly ?? true;

        await emitProgress(onUpdate, "steel_find_elements", "Discovering page elements");
        const session = (await withAbortSignal(
          client.getOrCreateSession(),
          signal
        )) as SessionLike;
        throwIfAborted(signal);
        const url = await readSessionUrl(session);
        if (isBlankPageUrl(url)) {
          throw blankPageError("discover page elements");
        }
        const candidates = await withAbortSignal(
          discoverElements(session, {
            query,
            tag,
            role,
            limit,
            clickableOnly,
          }),
          signal
        );

        await emitProgress(
          onUpdate,
          "steel_find_elements",
          `Found ${candidates.length} candidate element(s)`
        );

        return {
          content: [{ type: "text", text: JSON.stringify(candidates, null, 2) }],
          details: {
            ...sessionDetails(session, url),
            query,
            tag,
            role,
            limit,
            clickableOnly,
            count: candidates.length,
          },
        };
      }, signal);
    },
  };
}
