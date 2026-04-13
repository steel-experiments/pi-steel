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

type ScrapeFormat = "html" | "markdown" | "text";

type SessionLike = {
  id: string;
  sessionViewerUrl?: string | null;
  content?: () => Promise<unknown>;
  evaluate?: <T>(fn: (...args: any[]) => T, ...args: any[]) => Promise<T>;
  page?: {
    content?: () => Promise<unknown>;
    evaluate?: <T>(fn: (...args: any[]) => T, ...args: any[]) => Promise<T>;
  };
  url?: (() => Promise<string> | string) | string;
  getCurrentUrl?: () => Promise<string> | string;
};

const ALLOWED_FORMATS: readonly ScrapeFormat[] = ["html", "markdown", "text"];
const DEFAULT_FORMAT: ScrapeFormat = "text";
const DEFAULT_MAX_CHARS = 12_000;
const MIN_MAX_CHARS = 1;
const MAX_MAX_CHARS = 200_000;

function resolveFormat(rawFormat?: string): ScrapeFormat {
  if (typeof rawFormat === "string" && ALLOWED_FORMATS.includes(rawFormat as ScrapeFormat)) {
    return rawFormat as ScrapeFormat;
  }

  return DEFAULT_FORMAT;
}

function readMaxCharsFromEnv(): number | null {
  const raw = process.env.STEEL_SCRAPE_MAX_CHARS;
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.min(MAX_MAX_CHARS, Math.trunc(parsed));
}

function resolveMaxChars(rawMaxChars?: number): number {
  if (rawMaxChars === undefined) {
    return readMaxCharsFromEnv() ?? DEFAULT_MAX_CHARS;
  }

  const parsed = Number(rawMaxChars);
  if (!Number.isFinite(parsed) || parsed < MIN_MAX_CHARS) {
    throw new Error(`maxChars must be an integer >= ${MIN_MAX_CHARS}.`);
  }
  return Math.min(MAX_MAX_CHARS, Math.trunc(parsed));
}

function normalizeSelector(selector?: string): string | undefined {
  if (selector === undefined) {
    return undefined;
  }

  const trimmed = selector.trim();
  if (!trimmed) {
    throw new Error("selector cannot be empty.");
  }

  return trimmed;
}

function sessionDetails(session: SessionLike, url: string, format: ScrapeFormat, selector: string | undefined) {
  return {
    ...baseSessionDetails(session),
    url,
    format,
    selector: selector ?? null,
  };
}

function extractFallbackText(rawHtml: string): string {
  return rawHtml
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<[^>]*>/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanInnerText(raw: string): string {
  return raw
    .replace(/\u00a0/g, " ")
    .replace(/\r?\n{3,}/g, "\n\n")
    .trim();
}

function truncateContent(raw: string, maxChars: number): {
  text: string;
  truncated: boolean;
  originalLength: number;
} {
  const originalLength = raw.length;
  if (originalLength <= maxChars) {
    return {
      text: raw,
      truncated: false,
      originalLength,
    };
  }

  const omitted = originalLength - maxChars;
  const marker = `\n\n[truncated ${omitted} chars]`;
  const headLength = Math.max(0, maxChars - marker.length);
  return {
    text: `${raw.slice(0, headLength)}${marker}`,
    truncated: true,
    originalLength,
  };
}

async function extractWithBrowserEvaluate(
  session: SessionLike,
  format: ScrapeFormat,
  selector: string | undefined
): Promise<string> {
  const evaluate = session.evaluate ?? session.page?.evaluate;
  if (typeof evaluate !== "function") {
    throw new Error("Session does not support DOM extraction.");
  }

  const payload = await evaluate((input: { selector: string | null; format: ScrapeFormat }) => {
    const getRoot = () => {
      if (!input.selector) {
        return document.documentElement;
      }

      return document.querySelector(input.selector);
    };

    const root = getRoot();
    if (!root) {
      return null as unknown as string;
    }

    const baseText = (): string => {
      const text = (root as HTMLElement).innerText || root.textContent || "";
      return text.replace(/\u00a0/g, " ").replace(/\r?\n{3,}/g, "\n\n").trim();
    };

    const markdownFromNode = (node: Node, depth = 0): string => {
      if (node.nodeType === Node.TEXT_NODE) {
        return (node.textContent || "").replace(/\u00a0/g, " ");
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        return "";
      }

      const element = node as Element;
      const tag = element.tagName.toLowerCase();
      const pad = "  ".repeat(depth);

      const childText = Array.from(element.childNodes)
        .map((child) => markdownFromNode(child, depth + 1))
        .join("");

      switch (tag) {
        case "h1":
          return `\n# ${clean(childText)}\n\n`;
        case "h2":
          return `\n## ${clean(childText)}\n\n`;
        case "h3":
          return `\n### ${clean(childText)}\n\n`;
        case "h4":
          return `\n#### ${clean(childText)}\n\n`;
        case "h5":
          return `\n##### ${clean(childText)}\n\n`;
        case "h6":
          return `\n###### ${clean(childText)}\n\n`;
        case "p":
        case "article":
        case "section":
          return `${clean(childText)}\n\n`;
        case "blockquote":
          return `\n${clean(childText).replace(/\n/g, "\n> ")}\n\n`;
        case "pre":
          return `\n\`\`\`\n${(element.textContent || "").replace(/\n+$/, "")}\n\`\`\`\n\n`;
        case "code":
          return `\`${clean(childText)}\``;
        case "strong":
        case "b":
          return `**${clean(childText)}**`;
        case "em":
        case "i":
          return `*${clean(childText)}*`;
        case "a": {
          const href = (element as HTMLAnchorElement).getAttribute("href") || "";
          return `[${clean(childText)}](${href})`;
        }
        case "img": {
          const src = (element as HTMLImageElement).getAttribute("src") || "";
          const alt = (element as HTMLImageElement).getAttribute("alt") || "";
          return `![${alt}](${src})`;
        }
        case "ul":
          return (
            Array.from(element.children)
              .filter((item) => item.tagName.toLowerCase() === "li")
              .map((item) => `${pad}- ${clean(markdownFromNode(item).trim())}`)
              .join("\n") + "\n\n"
          );
        case "ol":
          return (
            Array.from(element.children)
              .filter((item) => item.tagName.toLowerCase() === "li")
              .map((item, index) => `${pad}${index + 1}. ${clean(markdownFromNode(item).trim())}`)
              .join("\n") + "\n\n"
          );
        case "li":
          return childText.trim();
        case "div":
        case "main":
        case "header":
        case "footer":
        case "nav":
        case "aside":
          return `${clean(childText)}\n`;
        case "br":
          return "\n";
        default:
          return childText;
      }
    };

    const clean = (value: string): string =>
      value
        .replace(/\n{3,}/g, "\n\n")
        .replace(/\s+\n/g, "\n")
        .trim();

    if (input.format === "html") {
      return (root as HTMLElement).outerHTML;
    }

    if (input.format === "text") {
      return baseText();
    }

    if (input.format === "markdown") {
      return clean(markdownFromNode(root).trim());
    }

    return clean(root.textContent || "");
  }, { selector: selector ?? null, format });

  if (payload === null) {
    throw new Error(selector
      ? `No element matched selector: ${selector}`
      : "Could not extract page HTML from the browser.");
  }

  if (typeof payload !== "string") {
    throw new Error("Scrape operation returned an unexpected payload.");
  }

  return payload;
}

async function scrapeContent(
  session: SessionLike,
  format: ScrapeFormat,
  selector: string | undefined
): Promise<string> {
  if (!selector && format === "html" && typeof session.content === "function") {
    const pageHtml = await session.content();
    if (typeof pageHtml === "string") {
      return pageHtml;
    }
  }

  if (!selector && format === "html" && typeof session.page?.content === "function") {
    const pageHtml = await session.page.content();
    if (typeof pageHtml === "string") {
      return pageHtml;
    }
  }

  try {
    const value = await extractWithBrowserEvaluate(session, format, selector);
    if (typeof value === "string") {
      return value;
    }
  } catch (error) {
    if (format !== "text") {
      throw error;
    }
  }

  const maybeHtml = await (() => {
    if (typeof session.content === "function") {
      return session.content();
    }

    if (typeof session.page?.content === "function") {
      return session.page.content();
    }

    return Promise.resolve(undefined);
  })();

  if (typeof maybeHtml === "string") {
    return extractFallbackText(maybeHtml);
  }

  throw new Error("Session does not support scrape content extraction.");
}

export function scrapeTool(client: SteelClient): ToolDefinition<any, any> {
  return {
    name: "steel_scrape",
    label: "Scrape",
    description: "Extract readable current page content. Use text by default for answering questions, markdown when structure matters, and html only for DOM/debugging cases.",
    parameters: Type.Object({
      format: Type.Optional(
        Type.Union(
          [Type.Literal("html"), Type.Literal("markdown"), Type.Literal("text")],
          { description: "Output format. Prefer text for concise reading, markdown to preserve headings/lists/links, and html only when raw DOM markup is specifically needed." }
        )
      ),
      selector: Type.Optional(
        Type.String({ description: "Optional CSS selector to scope extraction to a specific element before converting to the requested output format" })
      ),
      maxChars: Type.Optional(
        Type.Integer({
          minimum: MIN_MAX_CHARS,
          maximum: MAX_MAX_CHARS,
          description: `Maximum characters to return after conversion to text/markdown/html (default: ${DEFAULT_MAX_CHARS}, env override: STEEL_SCRAPE_MAX_CHARS)`,
        })
      ),
    }),

    async execute(
      _toolCallId: string,
      params: { format?: ScrapeFormat; selector?: string; maxChars?: number },
      signal: AbortSignal | undefined,
      onUpdate: ToolProgressUpdater,
      _ctx: ExtensionContext
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: object }> {
      return withToolError("steel_scrape", async () => {
        throwIfAborted(signal);
        const format = resolveFormat(params.format);
        const selector = normalizeSelector(params.selector);
        const maxChars = resolveMaxChars(params.maxChars);
        const target = selector ? ` (selector ${selector})` : " (full page)";

        await emitProgress(onUpdate, "steel_scrape", `Preparing ${format} scrape for${target}`);
        const session = (await withAbortSignal(
          client.getOrCreateSession(),
          signal
        )) as SessionLike;
        throwIfAborted(signal);
        const url = await readSessionUrl(session);
        if (isBlankPageUrl(url)) {
          throw blankPageError("scrape page content");
        }
        await emitProgress(onUpdate, "steel_scrape", "Running extraction");
        const result = await withAbortSignal(
          scrapeContent(session, format, selector),
          signal
        );
        const cleanedResult = format === "text" ? cleanInnerText(result) : result;
        const limitedResult = truncateContent(cleanedResult, maxChars);
        if (limitedResult.truncated) {
          await emitProgress(
            onUpdate,
            "steel_scrape",
            `Scrape output truncated to ${maxChars} chars`
          );
        }
        await emitProgress(onUpdate, "steel_scrape", "Scrape complete");

        return {
          content: [{ type: "text", text: limitedResult.text }],
          details: {
            ...sessionDetails(session, url, format, selector),
            maxChars,
            contentLength: limitedResult.text.length,
            originalContentLength: limitedResult.originalLength,
            truncated: limitedResult.truncated,
          },
        };
      }, signal);
    },
  };
}
