import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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
import { scrollTool } from "./tools/scroll.js";
import { typeTool } from "./tools/type.js";
import { waitTool } from "./tools/wait.js";

type SteelSessionMode = "turn" | "agent" | "session";

function resolveSessionMode(): SteelSessionMode {
  const rawValue = process.env.STEEL_SESSION_MODE?.trim().toLowerCase();
  if (!rawValue) {
    return "agent";
  }

  if (rawValue === "turn" || rawValue === "agent" || rawValue === "session") {
    return rawValue;
  }

  console.warn(
    `[steel] unsupported STEEL_SESSION_MODE="${rawValue}", falling back to "agent"`
  );
  return "agent";
}

export default function steelExtension(pi: ExtensionAPI): void {
  const steelClient = new SteelClient();
  const sessionMode = resolveSessionMode();
  let closingSessions: Promise<void> | null = null;

  const closeSessions = async (reason: string) => {
    if (!closingSessions) {
      closingSessions = (async () => {
        try {
          await steelClient.closeAllSessions();
        } catch (error: unknown) {
          // Cleanup failures should not break the main agent response path.
          console.warn(`[steel] session cleanup failed (${reason})`, error);
        } finally {
          closingSessions = null;
        }
      })();
    }

    await closingSessions;
  };

  const tools = [
    navigateTool(steelClient),
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
  ];

  for (const tool of tools) {
    pi.registerTool(tool);
  }

  if (sessionMode === "turn") {
    pi.on("turn_end", async () => {
      await closeSessions("turn_end");
    });
  }

  if (sessionMode === "agent") {
    pi.on("agent_end", async () => {
      await closeSessions("agent_end");
    });
  }

  // Defensive cleanup for interactive session switches/forks.
  pi.on("session_before_switch", async () => {
    await closeSessions("session_before_switch");
  });

  pi.on("session_shutdown", async () => {
    await closeSessions("session_shutdown");
  });

  const shutdownApi = pi as ExtensionAPI & {
    onShutdown?: (handler: () => Promise<void> | void) => void;
  };
  shutdownApi.onShutdown?.(async () => {
    await closeSessions("onShutdown");
  });
}
