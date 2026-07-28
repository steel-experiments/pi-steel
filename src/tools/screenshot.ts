import { promises as fs } from "node:fs";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  assertArtifact,
  createArtifactPath,
  persistBinaryArtifact,
} from "../artifacts.js";
import { sessionDetails as baseSessionDetails, type SteelClient } from "../steel-client.js";
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
  type BrowserTarget,
  type BrowserTargetInput,
} from "./target.js";

type SessionLike = {
  id: string;
  sessionViewerUrl?: string | null;
  evaluate?: <T>(fn: (...args: any[]) => T, ...args: any[]) => Promise<T>;
  waitForSelector?: (
    selector: string,
    options?: { state?: "attached" | "visible"; timeout?: number }
  ) => Promise<unknown>;
  screenshot?: (options?: Record<string, unknown>) => Promise<unknown>;
  locator?: (selector: string) => {
    screenshot?: (options?: Record<string, unknown>) => Promise<unknown>;
  };
  page?: {
    evaluate?: <T>(fn: (...args: any[]) => T, ...args: any[]) => Promise<T>;
    waitForSelector?: (
      selector: string,
      options?: { state?: "attached" | "visible"; timeout?: number }
    ) => Promise<unknown>;
    screenshot?: (options?: Record<string, unknown>) => Promise<unknown>;
    locator?: (selector: string) => {
      screenshot?: (options?: Record<string, unknown>) => Promise<unknown>;
    };
  };
  url?: (() => Promise<string> | string) | string;
};

type ClipRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const DEFAULT_FULL_PAGE = false;

function sessionDetails(session: SessionLike, url: string, selector: string | undefined, fullPage: boolean) {
  return {
    ...baseSessionDetails(session),
    url,
    selector: selector ?? null,
    fullPage,
  };
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

function resolveTimeoutMs(rawTimeout?: number): number {
  return resolveToolTimeoutMs(rawTimeout);
}

function normalizeFullPage(fullPage?: boolean): boolean {
  return fullPage === true;
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function makeArtifactPath(): Promise<string> {
  return createArtifactPath("screenshots", "steel-screenshot", "png");
}

async function getWaitForSelector(session: SessionLike): Promise<
  (selector: string, timeoutMs: number) => Promise<void>
> {
  if (typeof session.waitForSelector === "function") {
    return async (selector, timeoutMs) => {
      await session.waitForSelector?.(selector, { state: "visible", timeout: timeoutMs });
    };
  }

  if (typeof session.page?.waitForSelector === "function") {
    return async (selector, timeoutMs) => {
      await session.page?.waitForSelector?.(selector, { state: "visible", timeout: timeoutMs });
    };
  }

  return async () => {
    return;
  };
}

function getSessionScreenshot(
  session: SessionLike
): ((options: Record<string, unknown>) => Promise<unknown>) | undefined {
  if (typeof session.screenshot === "function") {
    return async (options: Record<string, unknown>) => {
      return session.screenshot?.(options);
    };
  }

  if (typeof session.page?.screenshot === "function") {
    return async (options: Record<string, unknown>) => {
      return session.page?.screenshot?.(options);
    };
  }

  return undefined;
}

function getSessionLocator(
  session: SessionLike,
  selector: string
): { screenshot?: (options: Record<string, unknown>) => Promise<unknown> } | undefined {
  if (typeof session.locator === "function") {
    return session.locator(selector);
  }

  if (typeof session.page?.locator === "function") {
    return session.page.locator(selector);
  }

  return undefined;
}

async function captureWithSelector(
  session: SessionLike,
  selector: string,
  targetPath: string,
  timeoutMs: number
): Promise<unknown> {
  const waitForSelector = await getWaitForSelector(session);
  await waitForSelector(selector, timeoutMs);

  const locator = getSessionLocator(session, selector);
  if (locator?.screenshot) {
    return locator.screenshot({ path: targetPath });
  }

  const evaluate = session.evaluate ?? session.page?.evaluate;
  if (typeof evaluate !== "function") {
    return false;
  }

  const clip = await evaluate((rawSelector: string): ClipRect | null => {
    const element = document.querySelector(rawSelector) as HTMLElement | null;
    if (!element) {
      return null;
    }

    const bounds = element.getBoundingClientRect();
    if (!bounds.width || !bounds.height) {
      return null;
    }

    return {
      x: Math.max(0, Math.floor(bounds.left)),
      y: Math.max(0, Math.floor(bounds.top)),
      width: Math.max(1, Math.ceil(bounds.width)),
      height: Math.max(1, Math.ceil(bounds.height)),
    };
  }, selector);

  if (!clip) {
    throw new Error(`No element matched selector: ${selector}`);
  }

  const screenshot = getSessionScreenshot(session);
  if (!screenshot) {
    return undefined;
  }

  return screenshot({
    path: targetPath,
    clip,
  });
}

async function captureFullPage(
  session: SessionLike,
  targetPath: string,
  fullPage: boolean
): Promise<unknown> {
  const screenshot = getSessionScreenshot(session);
  if (!screenshot) {
    throw new Error("Session does not support screenshot capture.");
  }

  return screenshot({
    path: targetPath,
    fullPage,
  });
}

function isBinaryLike(value: unknown): Buffer | Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof Buffer) {
    return value;
  }

  return null;
}

async function persistScreenshotBuffer(
  targetPath: string,
  value: unknown
): Promise<void> {
  await persistBinaryArtifact(targetPath, isBinaryLike(value));
}

async function writeArtifact(targetPath: string, sessionResult: unknown): Promise<void> {
  if (await fileExists(targetPath)) {
    return;
  }

  await persistScreenshotBuffer(targetPath, sessionResult);

  if (!(await fileExists(targetPath))) {
    throw new Error(`Screenshot not written to expected path: ${targetPath}`);
  }
}

export function screenshotTool(client: SteelClient): ToolDefinition<any, any> {
  return {
    name: "steel_screenshot",
    label: "Screenshot",
    description:
      "Capture the current page or a target element selected by CSS, ARIA role/name, or visible text.",
    parameters: Type.Object({
      fullPage: Type.Optional(
        Type.Boolean({ description: "Capture full page screenshot instead of viewport-only" })
      ),
      ...targetParameterProperties,
      timeout: Type.Optional(
        Type.Integer({
          minimum: 100,
          maximum: MAX_TOOL_TIMEOUT_MS,
          description: "Timeout for waiting on selector when selector mode is used",
        })
      ),
    }),

    async execute(
      _toolCallId: string,
      params: BrowserTargetInput & {
        fullPage?: boolean;
        timeout?: number;
      },
      signal: AbortSignal | undefined,
      onUpdate: ToolProgressUpdater,
      _ctx: ExtensionContext
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: object }> {
      return withToolError("steel_screenshot", async () => {
        throwIfAborted(signal);
        const hasTarget = Boolean(
          params.selector || params.role || params.targetText || params.name
        );
        const target: BrowserTarget | undefined = hasTarget
          ? resolveTarget(params)
          : undefined;
        const targetLabel = target ? describeTarget(target) : undefined;
        const selector = target?.kind === "selector" ? target.selector : undefined;
        const fullPage = normalizeFullPage(params.fullPage);
        const timeoutMs = resolveTimeoutMs(params.timeout);
        const captureLabel = targetLabel ? ` ${targetLabel}` : " visible page";

        await emitProgress(onUpdate, "steel_screenshot", `Preparing capture for${captureLabel}`);
        const session = (await withAbortSignal(
          client.getOrCreateSession(),
          signal
        )) as SessionLike;
        throwIfAborted(signal);
        const url = await readSessionUrl(session);
        const targetPath = await makeArtifactPath();
        let screenshotResult: unknown;

        if (target) {
          await emitProgress(onUpdate, "steel_screenshot", `Capturing ${targetLabel}`);
          const locator = getTargetLocator(session, target);
          if (locator.waitFor) {
            await withAbortSignal(
              locator.waitFor({ state: "visible", timeout: timeoutMs }),
              signal
            );
          }
          if (!locator.screenshot) {
            throw new Error(`Session does not support screenshots for ${targetLabel}.`);
          }
          screenshotResult = await withAbortSignal(
            locator.screenshot({ path: targetPath, timeout: timeoutMs }),
            signal
          );
        } else {
          await emitProgress(onUpdate, "steel_screenshot", fullPage ? "Capturing full-page screenshot" : "Capturing viewport screenshot");
          screenshotResult = await captureFullPage(session, targetPath, fullPage);
        }

        await emitProgress(onUpdate, "steel_screenshot", `Persisting image to ${targetPath}`);
        await writeArtifact(targetPath, screenshotResult);
        const artifactFile = await assertArtifact(targetPath);
        const contentText = targetLabel
          ? `Captured screenshot of ${targetLabel}: ${artifactFile.absolutePath}`
          : fullPage
            ? `Captured full-page screenshot: ${artifactFile.absolutePath}`
            : `Captured viewport screenshot: ${artifactFile.absolutePath}`;

        return {
          content: [{ type: "text", text: contentText }],
          details: {
            ...sessionDetails(session, url, selector, fullPage),
            target: target ?? null,
            filePath: artifactFile.absolutePath,
            fileName: artifactFile.fileName,
            sizeBytes: artifactFile.sizeBytes,
            timeoutMs,
          },
        };
      }, signal);
    },
  };
}
