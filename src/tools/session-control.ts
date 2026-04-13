import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { SteelSessionMode } from "../session-mode.js";
import type { SteelClient } from "../steel-client.js";
import { withToolError, type ToolProgressUpdater } from "./tool-runtime.js";

export type SteelSessionController = {
  getDefaultSessionMode: () => SteelSessionMode;
  getSessionMode: () => SteelSessionMode;
  setSessionMode: (mode: SteelSessionMode) => void;
  closeSessions: (reason: string) => Promise<void>;
};

function buildPinMessage(sessionId: string | null): string {
  if (sessionId) {
    return `Enabled Steel session persistence for this Pi session. Current session: ${sessionId}.`;
  }

  return "Enabled Steel session persistence for this Pi session.";
}

function buildReleaseMessage(
  sessionId: string | null,
  nextMode: SteelSessionMode
): string {
  if (sessionId) {
    return `Released Steel session ${sessionId}. Runtime session mode reset to ${nextMode}.`;
  }

  return `No active Steel session to release. Runtime session mode reset to ${nextMode}.`;
}

export function pinSessionTool(
  client: SteelClient,
  controller: SteelSessionController
): ToolDefinition<any, any> {
  return {
    name: "steel_pin_session",
    label: "Pin Session",
    description: "Keep the current Steel browser session alive across prompts until explicitly released",
    parameters: Type.Object({}),

    async execute(
      _toolCallId: string,
      _params: {},
      _signal: AbortSignal | undefined,
      _onUpdate: ToolProgressUpdater,
      _ctx: ExtensionContext
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: object }> {
      return withToolError("steel_pin_session", async () => {
        const previousMode = controller.getSessionMode();
        controller.setSessionMode("session");
        const sessionId = client.getCurrentSessionId();

        return {
          content: [{ type: "text", text: buildPinMessage(sessionId) }],
          details: {
            previousMode,
            mode: "session",
            defaultMode: controller.getDefaultSessionMode(),
            sessionId,
            hasActiveSession: client.hasActiveSession(),
          },
        };
      });
    },
  };
}

export function releaseSessionTool(
  client: SteelClient,
  controller: SteelSessionController
): ToolDefinition<any, any> {
  return {
    name: "steel_release_session",
    label: "Release Session",
    description: "Close the current Steel browser session immediately and restore the default runtime session mode",
    parameters: Type.Object({}),

    async execute(
      _toolCallId: string,
      _params: {},
      _signal: AbortSignal | undefined,
      _onUpdate: ToolProgressUpdater,
      _ctx: ExtensionContext
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: object }> {
      return withToolError("steel_release_session", async () => {
        const previousMode = controller.getSessionMode();
        const defaultMode = controller.getDefaultSessionMode();
        const sessionId = client.getCurrentSessionId();

        await controller.closeSessions("steel_release_session");
        controller.setSessionMode(defaultMode);

        return {
          content: [{ type: "text", text: buildReleaseMessage(sessionId, defaultMode) }],
          details: {
            previousMode,
            mode: defaultMode,
            defaultMode,
            releasedSessionId: sessionId,
            hadActiveSession: Boolean(sessionId),
          },
        };
      });
    },
  };
}
