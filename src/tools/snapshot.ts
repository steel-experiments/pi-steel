import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sessionDetails as baseSessionDetails, type SteelClient } from "../steel-client.js";
import {
  blankPageError,
  isBlankPageUrl,
  readSessionUrl,
} from "./session-state.js";
import {
  emitProgress,
  throwIfAborted,
  withAbortSignal,
  withToolError,
  type ToolProgressUpdater,
} from "./tool-runtime.js";

type SnapshotLocator = {
  ariaSnapshot?: (options?: { timeout?: number }) => Promise<string>;
};

type SessionLike = {
  id: string;
  sessionViewerUrl?: string | null;
  url?: (() => Promise<string> | string) | string;
  locator?: (selector: string) => SnapshotLocator;
  page?: {
    locator?: (selector: string) => SnapshotLocator;
  };
};

const DEFAULT_MAX_CHARS = 30_000;
const MAX_CHARS = 200_000;

function truncateSnapshot(snapshot: string, maxChars: number) {
  if (snapshot.length <= maxChars) {
    return { text: snapshot, truncated: false };
  }
  const marker = `\n\n[ARIA snapshot truncated from ${snapshot.length} characters]`;
  return {
    text: `${snapshot.slice(0, Math.max(0, maxChars - marker.length))}${marker}`,
    truncated: true,
  };
}

export function snapshotTool(client: SteelClient): ToolDefinition<any, any> {
  return {
    name: "steel_snapshot",
    label: "Accessibility Snapshot",
    description:
      "Read the current page as an ARIA accessibility tree. Use this before interacting so targets can be selected by role and accessible name.",
    parameters: Type.Object({
      maxChars: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_CHARS,
          description: `Maximum characters returned inline (default ${DEFAULT_MAX_CHARS})`,
        })
      ),
    }),

    async execute(
      _toolCallId: string,
      params: { maxChars?: number },
      signal: AbortSignal | undefined,
      onUpdate: ToolProgressUpdater,
      _ctx: ExtensionContext
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: object }> {
      return withToolError("steel_snapshot", async () => {
        throwIfAborted(signal);
        const maxChars = params.maxChars ?? DEFAULT_MAX_CHARS;
        const session = (await withAbortSignal(client.getOrCreateSession(), signal)) as SessionLike;
        const url = await readSessionUrl(session);
        if (isBlankPageUrl(url)) {
          throw blankPageError("snapshot page accessibility");
        }

        const locator = session.locator?.("body") ?? session.page?.locator?.("body");
        if (!locator?.ariaSnapshot) {
          throw new Error(
            "The installed Playwright version does not support accessibility snapshots."
          );
        }

        await emitProgress(onUpdate, "steel_snapshot", "Reading accessibility tree");
        const snapshot = await withAbortSignal(locator.ariaSnapshot(), signal);
        const limited = truncateSnapshot(snapshot, maxChars);

        return {
          content: [{ type: "text", text: limited.text }],
          details: {
            ...baseSessionDetails(session),
            url,
            maxChars,
            originalLength: snapshot.length,
            truncated: limited.truncated,
          },
        };
      }, signal);
    },
  };
}
