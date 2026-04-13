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

type SessionLike = {
  id: string;
  sessionViewerUrl?: string | null;
  goBack?: () => Promise<unknown> | unknown;
  back?: () => Promise<unknown> | unknown;
  url?: (() => Promise<string> | string) | string;
  title?: (() => Promise<string> | string) | string;
};

async function readSessionUrl(session: SessionLike): Promise<string> {
  const current = session.url;

  if (typeof current === "string") {
    return current;
  }

  if (typeof current === "function") {
    const value = await current.call(session);
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

async function readSessionTitle(session: SessionLike): Promise<string> {
  const current = session.title;

  if (typeof current === "function") {
    const value = await current.call(session);
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return "unknown";
}

export function goBackTool(client: SteelClient): ToolDefinition<any, any> {
  return {
    name: "steel_go_back",
    label: "Go Back",
    description: "Navigate back in browser history",
    parameters: Type.Object({}),

    async execute(
      _toolCallId: string,
      _params: {},
      signal: AbortSignal | undefined,
      onUpdate: ToolProgressUpdater,
      _ctx: ExtensionContext
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: object }> {
      return withToolError("steel_go_back", async () => {
        throwIfAborted(signal);
        await emitProgress(onUpdate, "steel_go_back", "Preparing history navigation");

        const session = (await withAbortSignal(
          client.getOrCreateSession(),
          signal
        )) as SessionLike;
        const previousUrl = await readSessionUrl(session);
        const goBack = session.goBack ?? session.back;

        if (typeof goBack !== "function") {
          throw new Error("Session does not support browser history navigation.");
        }

        await emitProgress(onUpdate, "steel_go_back", "Returning to previous page");
        await withAbortSignal(Promise.resolve(goBack.call(session)), signal);
        const currentUrl = await readSessionUrl(session);
        await emitProgress(onUpdate, "steel_go_back", `Returned to ${currentUrl}`);

        return {
          content: [{
            type: "text",
            text: `Navigated back to ${currentUrl}`,
          }],
          details: {
            ...sessionDetails(session),
            previousUrl,
            url: currentUrl,
          },
        };
      }, signal);
    },
  };
}

export function getUrlTool(client: SteelClient): ToolDefinition<any, any> {
  return {
    name: "steel_get_url",
    label: "Get URL",
    description: "Get current page URL",
    parameters: Type.Object({}),

    async execute(
      _toolCallId: string,
      _params: {},
      signal: AbortSignal | undefined,
      onUpdate: ToolProgressUpdater,
      _ctx: ExtensionContext
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: object }> {
      return withToolError("steel_get_url", async () => {
        throwIfAborted(signal);
        await emitProgress(onUpdate, "steel_get_url", "Reading current URL");
        const session = (await withAbortSignal(
          client.getOrCreateSession(),
          signal
        )) as SessionLike;
        const url = await readSessionUrl(session);

        return {
          content: [{ type: "text", text: `Current URL: ${url}` }],
          details: {
            ...sessionDetails(session),
            url,
          },
        };
      }, signal);
    },
  };
}

export function getTitleTool(client: SteelClient): ToolDefinition<any, any> {
  return {
    name: "steel_get_title",
    label: "Get Title",
    description: "Get current page title",
    parameters: Type.Object({}),

    async execute(
      _toolCallId: string,
      _params: {},
      signal: AbortSignal | undefined,
      onUpdate: ToolProgressUpdater,
      _ctx: ExtensionContext
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: object }> {
      return withToolError("steel_get_title", async () => {
        throwIfAborted(signal);
        await emitProgress(onUpdate, "steel_get_title", "Reading current page title");
        const session = (await withAbortSignal(
          client.getOrCreateSession(),
          signal
        )) as SessionLike;
        const title = await readSessionTitle(session);

        return {
          content: [{ type: "text", text: `Current title: ${title}` }],
          details: {
            ...sessionDetails(session),
            title,
          },
        };
      }, signal);
    },
  };
}
