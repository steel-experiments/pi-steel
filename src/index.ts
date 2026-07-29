import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { resolveSessionMode, type SteelSessionMode } from "./session-mode.js";
import { SteelClient } from "./steel-client.js";
import { clickTool } from "./tools/click.js";
import { computerTool } from "./tools/computer.js";
import { extractTool } from "./tools/extract.js";
import { findElementsTool } from "./tools/find-elements.js";
import { fillFormTool } from "./tools/fill-form.js";
import { getTitleTool, getUrlTool, goBackTool } from "./tools/navigation.js";
import { navigateTool } from "./tools/navigate.js";
import { pdfTool } from "./tools/pdf.js";
import { scrapeTool } from "./tools/scrape.js";
import { screenshotTool } from "./tools/screenshot.js";
import { snapshotTool } from "./tools/snapshot.js";
import { scrollTool } from "./tools/scroll.js";
import { pinSessionTool, releaseSessionTool } from "./tools/session-control.js";
import { typeTool } from "./tools/type.js";
import { waitTool } from "./tools/wait.js";

export default function steelExtension(pi: ExtensionAPI): void {
  const steelClient = new SteelClient();
  const defaultSessionMode = resolveSessionMode();
  let sessionMode = defaultSessionMode;
  let closingSessions: Promise<void> | null = null;

  const closeSessions = async (reason: string) => {
    if (!closingSessions) {
      closingSessions = (async () => {
        try {
          await steelClient.closeAllSessions();
        } finally {
          closingSessions = null;
        }
      })();
    }

    await closingSessions;
  };

  const closeSessionsSafely = async (reason: string) => {
    try {
      await closeSessions(reason);
    } catch (error) {
      // Lifecycle cleanup must not replace the agent's primary response.
      console.warn(`[steel] session cleanup failed (${reason})`, error);
    }
  };

  const sessionController = {
    getDefaultSessionMode: () => defaultSessionMode,
    getSessionMode: () => sessionMode,
    setSessionMode: (mode: SteelSessionMode) => {
      sessionMode = mode;
    },
    closeSessions,
  };

  const tools = [
    navigateTool(steelClient),
    snapshotTool(steelClient),
    scrapeTool(steelClient),
    screenshotTool(steelClient),
    pdfTool(steelClient),
    clickTool(steelClient),
    computerTool(steelClient),
    findElementsTool(steelClient),
    typeTool(steelClient),
    fillFormTool(steelClient),
    waitTool(steelClient),
    extractTool(steelClient),
    scrollTool(steelClient),
    goBackTool(steelClient),
    getUrlTool(steelClient),
    getTitleTool(steelClient),
    pinSessionTool(steelClient, sessionController),
    releaseSessionTool(steelClient, sessionController),
  ];

  for (const tool of tools) {
    pi.registerTool(tool);
  }

  pi.on("turn_end", async () => {
    if (sessionMode === "turn") {
      await closeSessionsSafely("turn_end");
    }
  });

  pi.on("agent_end", async () => {
    if (sessionMode === "agent") {
      await closeSessionsSafely("agent_end");
    }
  });

  // Defensive cleanup for interactive session switches/forks.
  pi.on("session_before_switch", async () => {
    await closeSessionsSafely("session_before_switch");
  });

  pi.on("session_shutdown", async () => {
    await closeSessionsSafely("session_shutdown");
  });

  const shutdownApi = pi as ExtensionAPI & {
    onShutdown?: (handler: () => Promise<void> | void) => void;
  };
  shutdownApi.onShutdown?.(async () => {
    await closeSessionsSafely("onShutdown");
  });
}
