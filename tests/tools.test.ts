import { strict as assert } from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import steelExtension from "../dist/index.js";
import { navigateTool } from "../dist/tools/navigate.js";
import { scrapeTool } from "../dist/tools/scrape.js";
import { screenshotTool } from "../dist/tools/screenshot.js";
import { pdfTool } from "../dist/tools/pdf.js";
import { clickTool } from "../dist/tools/click.js";
import { computerTool } from "../dist/tools/computer.js";
import { typeTool } from "../dist/tools/type.js";
import { fillFormTool } from "../dist/tools/fill-form.js";
import { waitTool } from "../dist/tools/wait.js";
import { extractTool } from "../dist/tools/extract.js";
import { findElementsTool } from "../dist/tools/find-elements.js";
import { scrollTool } from "../dist/tools/scroll.js";
import { pinSessionTool, releaseSessionTool } from "../dist/tools/session-control.js";
import { goBackTool, getUrlTool, getTitleTool } from "../dist/tools/navigation.js";
import type { SteelSessionMode } from "../dist/session-mode.js";

type MockToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
};

type MockTool = {
  name: string;
  parameters?: {
    type?: string;
    properties?: Record<string, unknown>;
    additionalProperties?: boolean;
  };
  execute: (
    _toolCallId: string,
    _params: Record<string, unknown>,
    _signal: AbortSignal,
    onUpdate: (update: string) => Promise<void>,
    _ctx: unknown
  ) => Promise<MockToolResult>;
};

type MockPiApi = {
  registerTool: (tool: MockTool) => void;
  on: (eventName: string, _handler: (...args: unknown[]) => unknown) => void;
  onShutdown: (handler: () => Promise<void> | void) => Promise<void>;
};

type MockSession = {
  id: string;
  [key: string]: unknown;
};

type MockClient = {
  getOrCreateSession: () => Promise<MockSession>;
  getCurrentSessionId?: () => string | null;
  hasActiveSession?: () => boolean;
  refreshSession?: (
    options?: { useProxy?: boolean; proxyUrl?: string | null }
  ) => Promise<MockSession>;
  isProxyConfigured?: () => boolean;
  closeAllSessions?: () => Promise<void>;
};

function createMockClient(session: MockSession): MockClient {
  return {
    getOrCreateSession: async () => session,
    getCurrentSessionId: () => session.id,
    hasActiveSession: () => true,
  };
}

function assertTextResult(result: MockToolResult): void {
  assert.ok(Array.isArray(result.content), "tool should return content array");
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  assert.equal(typeof result.content[0].text, "string");
  assert.ok(result.content[0].text.length > 0);
  assert.equal(typeof result.details, "object");
  assert.ok(result.details?.sessionId);
  assert.equal(typeof result.details?.sessionViewerUrl, "string");
}

function createUpdatesCollector() {
  const updates: string[] = [];
  const onUpdate = async (update: string) => {
    updates.push(update);
  };
  return { updates, onUpdate };
}

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const original = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }

  try {
    return fn();
  } finally {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

async function executeTool(tool: MockTool, params: Record<string, unknown>, session: MockSession): Promise<{
  result: MockToolResult;
  updates: string[];
}> {
  const client = createMockClient(session);
  const toolWithClient = (tool as unknown) as MockTool;
  const actual = {
    navigate: navigateTool,
    scrape: scrapeTool,
    screenshot: screenshotTool,
    pdf: pdfTool,
    click: clickTool,
    computer: computerTool,
    type: typeTool,
    fillForm: fillFormTool,
    wait: waitTool,
    extract: extractTool,
    findElements: findElementsTool,
    scroll: scrollTool,
    goBack: goBackTool,
    getUrl: getUrlTool,
    getTitle: getTitleTool,
  } as Record<string, unknown>;

  const boundTool =
    toolWithClient === actual.navigate
      ? navigateTool(client as unknown as never)
      : toolWithClient === actual.scrape
        ? scrapeTool(client as unknown as never)
        : toolWithClient === actual.screenshot
          ? screenshotTool(client as unknown as never)
          : toolWithClient === actual.pdf
            ? pdfTool(client as unknown as never)
            : toolWithClient === actual.click
              ? clickTool(client as unknown as never)
              : toolWithClient === actual.computer
                ? computerTool(client as unknown as never)
              : toolWithClient === actual.type
                ? typeTool(client as unknown as never)
                : toolWithClient === actual.fillForm
                  ? fillFormTool(client as unknown as never)
                  : toolWithClient === actual.wait
                    ? waitTool(client as unknown as never)
                    : toolWithClient === actual.extract
                      ? extractTool(client as unknown as never)
                      : toolWithClient === actual.findElements
                        ? findElementsTool(client as unknown as never)
                      : toolWithClient === actual.scroll
                        ? scrollTool(client as unknown as never)
                        : toolWithClient === actual.goBack
                          ? goBackTool(client as unknown as never)
                          : toolWithClient === actual.getUrl
                            ? getUrlTool(client as unknown as never)
                            : toolWithClient === actual.getTitle
                              ? getTitleTool(client as unknown as never)
                              : undefined;

  assert.ok(boundTool, `Unable to bind mock client for tool ${toolWithClient.name}`);

  const { updates, onUpdate } = createUpdatesCollector();
  const result = await boundTool!.execute("call-001", params, new AbortController().signal, onUpdate, null);
  return { result, updates };
}

describe("Tool registration contracts", () => {
  const expectedTools = [
    "steel_navigate",
    "steel_scrape",
    "steel_screenshot",
    "steel_pdf",
    "steel_click",
    "steel_computer",
    "steel_find_elements",
    "steel_type",
    "steel_fill_form",
    "steel_wait",
    "steel_extract",
    "steel_scroll",
    "steel_go_back",
    "steel_get_url",
    "steel_get_title",
    "steel_pin_session",
    "steel_release_session",
  ];

  const requiredTopLevelParams: Record<string, string[]> = {
    steel_navigate: ["url"],
    steel_scrape: [],
    steel_screenshot: [],
    steel_pdf: [],
    steel_click: ["selector"],
    steel_computer: ["action"],
    steel_find_elements: [],
    steel_type: ["selector", "text"],
    steel_fill_form: ["fields"],
    steel_wait: ["selector"],
    steel_extract: ["schema"],
    steel_scroll: [],
    steel_go_back: [],
    steel_get_url: [],
    steel_get_title: [],
    steel_pin_session: [],
    steel_release_session: [],
  };

  it("registers all tools in expected order", async () => {
    const tools = withEnv("STEEL_API_KEY", "test-key", () => {
      const registeredTools: MockTool[] = [];
      steelExtension({
        registerTool: (tool: MockTool) => {
          registeredTools.push(tool);
        },
        on: () => {
          return;
        },
        onShutdown: async () => {
          return;
        },
      } as never);
      return registeredTools;
    });

    assert.deepEqual(
      tools.map((tool) => tool.name),
      expectedTools,
      "tool registration order changed"
    );

    for (const tool of tools) {
      const expectedFields = requiredTopLevelParams[tool.name];
      assert.equal(tool.name in requiredTopLevelParams, true);
      assert.equal(tool.parameters?.type, "object");
      const properties = tool.parameters?.properties ?? {};
      for (const key of expectedFields) {
        assert.ok(Object.prototype.hasOwnProperty.call(properties, key), `${tool.name} missing required schema field ${key}`);
      }
      assert.ok(tool.execute instanceof Function);
    }
  });

  it("registers runtime cleanup hooks for turn, agent, and session boundaries", () => {
    const registeredEvents = withEnv("STEEL_API_KEY", "test-key", () =>
      withEnv("STEEL_SESSION_MODE", undefined, () => {
        const eventNames: string[] = [];
        steelExtension({
          registerTool: () => {
            return;
          },
          on: (eventName: string) => {
            eventNames.push(eventName);
          },
          onShutdown: async () => {
            return;
          },
        } as MockPiApi as never);
        return eventNames;
      })
    );

    assert.deepEqual(registeredEvents, [
      "turn_end",
      "agent_end",
      "session_before_switch",
      "session_shutdown",
    ]);
  });

  it("registers explicit session control tools", async () => {
    let mode: SteelSessionMode = "agent";
    let closeCalls = 0;
    const client: MockClient = {
      getOrCreateSession: async () => ({ id: "session-1" }),
      getCurrentSessionId: () => "session-1",
      hasActiveSession: () => true,
      closeAllSessions: async () => {
        closeCalls += 1;
      },
    };

    const controller = {
      getDefaultSessionMode: () => "agent" as const,
      getSessionMode: () => mode,
      setSessionMode: (nextMode: SteelSessionMode) => {
        mode = nextMode;
      },
      closeSessions: async () => {
        closeCalls += 1;
      },
    };

    const pin = pinSessionTool(client as never, controller);
    const release = releaseSessionTool(client as never, controller);

    const pinResult = await pin.execute(
      "call-001",
      {},
      new AbortController().signal,
      async () => {},
      null
    );

    assert.equal(mode, "session");
    assert.match(pinResult.content[0].text, /Enabled Steel session persistence/i);
    assert.match(pinResult.content[0].text, /Current session: session-1/i);
    assert.equal(pinResult.details?.mode, "session");

    const releaseResult = await release.execute(
      "call-002",
      {},
      new AbortController().signal,
      async () => {},
      null
    );

    assert.equal(mode, "agent");
    assert.equal(closeCalls, 1);
    assert.match(releaseResult.content[0].text, /Released Steel session session-1/i);
    assert.equal(releaseResult.details?.mode, "agent");
  });

  it("executes navigation tool with normalized URL and response contract", async () => {
    const session: MockSession = {
      id: "session-1",
      goto: async () => {},
    };
    const { result } = await executeTool(navigateTool as unknown as MockTool, { url: "example.com" }, session);

    assertTextResult(result);
    assert.equal(result.details?.url, "https://example.com/");
    assert.equal(result.details?.waitUntil, "networkidle");
  });

  it("accepts uppercase HTTP scheme without corrupting the target URL", async () => {
    const calls: string[] = [];
    const session: MockSession = {
      id: "session-1",
      goto: async (url: string) => {
        calls.push(url);
      },
    };

    const { result } = await executeTool(
      navigateTool as unknown as MockTool,
      { url: "HTTP://example.com/path" },
      session
    );

    assertTextResult(result);
    assert.equal(calls[0], "http://example.com/path");
    assert.equal(result.details?.url, "http://example.com/path");
  });

  it("accepts host:port input and normalizes to https", async () => {
    const calls: string[] = [];
    const session: MockSession = {
      id: "session-1",
      goto: async (url: string) => {
        calls.push(url);
      },
    };

    const { result } = await executeTool(
      navigateTool as unknown as MockTool,
      { url: "localhost:3000/login" },
      session
    );

    assertTextResult(result);
    assert.equal(calls[0], "https://localhost:3000/login");
    assert.equal(result.details?.url, "https://localhost:3000/login");
  });

  it("rejects non-http URL schemes", async () => {
    const client = createMockClient({
      id: "session-1",
      goto: async () => {},
    });
    const tool = navigateTool(client as never);

    await assert.rejects(
      () =>
        tool.execute(
          "call-001",
          { url: "ftp://example.com" },
          new AbortController().signal,
          async () => {},
          null
        ),
      /Only http and https URLs are supported/,
      "expected non-http scheme to be rejected"
    );
  });

  it("retries tunnel failures with a fresh session before succeeding", async () => {
    const previousRetries = process.env.STEEL_NAVIGATE_RETRY_COUNT;
    process.env.STEEL_NAVIGATE_RETRY_COUNT = "0";
    try {
      const sessions: MockSession[] = [
        {
          id: "session-1",
          goto: async () => {
            throw new Error("page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://example.com");
          },
        },
        {
          id: "session-2",
          goto: async () => {},
        },
      ];

      let refreshCalls = 0;
      const client: MockClient = {
        getOrCreateSession: async () => sessions[0],
        refreshSession: async () => {
          refreshCalls += 1;
          return sessions[1];
        },
        isProxyConfigured: () => true,
      };

      const tool = navigateTool(client as never);
      const result = await tool.execute(
        "call-001",
        { url: "https://example.com" },
        new AbortController().signal,
        async () => {},
        null
      );

      assertTextResult(result as unknown as MockToolResult);
      assert.equal((result.details as Record<string, unknown>).sessionId, "session-2");
      const recovery = (result.details as Record<string, unknown>).tunnelRecovery as
        | Record<string, unknown>
        | null;
      assert.equal(recovery?.mode, "fresh_session");
      assert.equal(refreshCalls, 1);
    } finally {
      process.env.STEEL_NAVIGATE_RETRY_COUNT = previousRetries;
    }
  });

  it("falls back to no-proxy session after repeated tunnel failures", async () => {
    const previousRetries = process.env.STEEL_NAVIGATE_RETRY_COUNT;
    process.env.STEEL_NAVIGATE_RETRY_COUNT = "0";
    try {
      const sessions: MockSession[] = [
        {
          id: "session-1",
          goto: async () => {
            throw new Error("page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://example.com");
          },
        },
        {
          id: "session-2",
          goto: async () => {
            throw new Error("page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://example.com");
          },
        },
        {
          id: "session-3",
          goto: async () => {},
        },
      ];

      const refreshOptions: Array<{ useProxy?: boolean; proxyUrl?: string | null } | undefined> = [];
      let refreshIndex = 0;
      const client: MockClient = {
        getOrCreateSession: async () => sessions[0],
        refreshSession: async (options) => {
          refreshOptions.push(options);
          refreshIndex += 1;
          return sessions[refreshIndex];
        },
        isProxyConfigured: () => true,
      };

      const tool = navigateTool(client as never);
      const result = await tool.execute(
        "call-001",
        { url: "https://example.com" },
        new AbortController().signal,
        async () => {},
        null
      );

      assertTextResult(result as unknown as MockToolResult);
      assert.equal((result.details as Record<string, unknown>).sessionId, "session-3");
      const recovery = (result.details as Record<string, unknown>).tunnelRecovery as
        | Record<string, unknown>
        | null;
      assert.equal(recovery?.mode, "no_proxy");
      assert.equal(refreshOptions.length, 2);
      assert.equal(refreshOptions[1]?.useProxy, false);
      assert.equal(refreshOptions[1]?.proxyUrl, null);
    } finally {
      process.env.STEEL_NAVIGATE_RETRY_COUNT = previousRetries;
    }
  });

  it("executes scrape tool and returns extracted text", async () => {
    const session: MockSession = {
      id: "session-1",
      content: async () => "<html><body><h1>Title</h1></body></html>",
      evaluate: async (_fn: unknown, input: unknown) => {
        assert.equal(typeof input, "object");
        return "Title";
      },
    };
    const { result } = await executeTool(scrapeTool as unknown as MockTool, { format: "text" }, session);

    assertTextResult(result);
    assert.equal(result.content[0].text, "Title");
    assert.equal(result.details?.format, "text");
  });

  it("truncates scrape output when maxChars is exceeded", async () => {
    const longText = "A".repeat(400);
    const session: MockSession = {
      id: "session-1",
      content: async () => "<html><body>ignored</body></html>",
      evaluate: async (_fn: unknown, input: unknown) => {
        assert.equal(typeof input, "object");
        return longText;
      },
    };

    const { result } = await executeTool(
      scrapeTool as unknown as MockTool,
      { format: "text", maxChars: 200 },
      session
    );

    assertTextResult(result);
    assert.equal(result.details?.truncated, true);
    assert.equal(result.details?.originalContentLength, longText.length);
    assert.equal(result.details?.maxChars, 200);
    assert.ok((result.content[0].text ?? "").includes("[truncated "));
    assert.ok((result.content[0].text ?? "").length <= 200);
  });

  it("supports short scrape excerpts below 200 characters", async () => {
    const longText = "B".repeat(400);
    const session: MockSession = {
      id: "session-1",
      content: async () => "<html><body>ignored</body></html>",
      evaluate: async (_fn: unknown, input: unknown) => {
        assert.equal(typeof input, "object");
        return longText;
      },
    };

    const { result } = await executeTool(
      scrapeTool as unknown as MockTool,
      { format: "text", maxChars: 150 },
      session
    );

    assertTextResult(result);
    assert.equal(result.details?.maxChars, 150);
    assert.equal(result.details?.truncated, true);
    assert.ok((result.content[0].text ?? "").length <= 150);
  });

  it("captures screenshot artifact and returns artifact path", async () => {
    const session: MockSession = {
      id: "session-1",
      url: "https://page.example/",
      screenshot: async () => Buffer.from("png-bytes"),
    };

    const { result } = await executeTool(screenshotTool as unknown as MockTool, { fullPage: true }, session);
    assertTextResult(result);

    const filePath = result.details?.filePath;
    assert.equal(typeof filePath, "string");
    assert.ok(path.basename(filePath as string).startsWith("steel-screenshot-"));
    assert.equal(path.extname(filePath as string), ".png");
    await rm(filePath as string);
  });

  it("generates PDF artifact and returns artifact metadata", async () => {
    const session: MockSession = {
      id: "session-1",
      url: "https://page.example/",
      pdf: async () => Buffer.from("pdf-bytes"),
    };

    const { result } = await executeTool(pdfTool as unknown as MockTool, {}, session);
    assertTextResult(result);
    assert.match(result.content[0].text, /^PDF saved: \.artifacts\/pdfs\/steel-pdf-/);

    const filePath = result.details?.filePath;
    assert.equal(typeof filePath, "string");
    assert.ok(path.basename(filePath as string).startsWith("steel-pdf-"));
    assert.equal(path.extname(filePath as string), ".pdf");

    const absoluteFilePath = result.details?.absoluteFilePath;
    assert.equal(typeof absoluteFilePath, "string");
    assert.ok(path.isAbsolute(absoluteFilePath as string));

    const artifact = result.details?.artifact as Record<string, unknown> | undefined;
    assert.ok(artifact);
    assert.equal(artifact?.type, "pdf");
    assert.equal(artifact?.mimeType, "application/pdf");
    const artifactPath = artifact?.path;
    assert.equal(typeof artifactPath, "string");
    assert.equal(artifactPath, filePath);
    await rm(artifactPath as string);
  });

  it("executes click tool when element is clickable", async () => {
    const calls: string[] = [];
    const session: MockSession = {
      id: "session-1",
      waitForSelector: async (selector) => {
        calls.push(`wait:${selector}`);
      },
      evaluate: async () => ({ found: true, visible: true, clickable: true, disabled: false }),
      click: async (selector) => {
        calls.push(`click:${selector}`);
      },
    };

    const { result } = await executeTool(clickTool as unknown as MockTool, { selector: "#btn" }, session);
    assertTextResult(result);
    assert.equal(calls[0], "wait:#btn");
    assert.equal(calls[1], "click:#btn");
    assert.equal(result.details?.selector, "#btn");
  });

  it("executes click tool with Playwright text selectors via locator", async () => {
    const calls: string[] = [];
    const session: MockSession = {
      id: "session-1",
      locator: (selector: string) => ({
        waitFor: async () => {
          calls.push(`wait:${selector}`);
        },
        isVisible: async () => true,
        isEnabled: async () => true,
        click: async () => {
          calls.push(`click:${selector}`);
        },
      }),
    };

    const { result } = await executeTool(
      clickTool as unknown as MockTool,
      { selector: "text=Signup" },
      session
    );

    assertTextResult(result);
    assert.equal(calls[0], "wait:text=Signup");
    assert.equal(calls[1], "click:text=Signup");
  });

  it("retries click via captcha recovery when overlay blocks pointer events", async () => {
    const previousWait = process.env.STEEL_CAPTCHA_WAIT_MS;
    const previousPoll = process.env.STEEL_CAPTCHA_POLL_INTERVAL_MS;
    const previousRetries = process.env.STEEL_CAPTCHA_MAX_RETRIES;
    process.env.STEEL_CAPTCHA_WAIT_MS = "1000";
    process.env.STEEL_CAPTCHA_POLL_INTERVAL_MS = "250";
    process.env.STEEL_CAPTCHA_MAX_RETRIES = "1";

    try {
      let clickAttempts = 0;
      let statusChecks = 0;
      const session: MockSession = {
        id: "session-1",
        waitForSelector: async () => {},
        evaluate: async () => ({
          found: true,
          visible: true,
          clickable: true,
          disabled: false,
        }),
        click: async () => {
          clickAttempts += 1;
          if (clickAttempts === 1) {
            throw new Error("subtree intercepts pointer events");
          }
        },
        captchasStatus: async () => {
          statusChecks += 1;
          if (statusChecks === 1) {
            return [{ isSolvingCaptcha: false, tasks: [{}] }];
          }
          return [{ isSolvingCaptcha: false, tasks: [] }];
        },
        captchasSolve: async () => ({ success: true, message: "captcha solve requested" }),
      };

      const { result } = await executeTool(
        clickTool as unknown as MockTool,
        { selector: "#btn" },
        session
      );

      assertTextResult(result);
      assert.equal(clickAttempts, 2);
      const captchaRecovery = result.details?.captchaRecovery as Record<string, unknown>;
      assert.equal(captchaRecovery?.triggered, true);
      assert.equal(captchaRecovery?.retries, 1);
      assert.equal(captchaRecovery?.solveAttempts, 1);
      assert.ok(Number(captchaRecovery?.statusChecks) >= 1);
    } finally {
      process.env.STEEL_CAPTCHA_WAIT_MS = previousWait;
      process.env.STEEL_CAPTCHA_POLL_INTERVAL_MS = previousPoll;
      process.env.STEEL_CAPTCHA_MAX_RETRIES = previousRetries;
    }
  });

  it("executes computer action and persists screenshot artifact", async () => {
    const session: MockSession = {
      id: "session-1",
      computer: async () => ({
        base64_image: Buffer.from("png-bytes").toString("base64"),
        output: "clicked",
      }),
    };

    const { result } = await executeTool(
      computerTool as unknown as MockTool,
      {
        action: "click_mouse",
        button: "left",
        coordinates: [100, 220],
        screenshot: true,
      },
      session
    );

    assertTextResult(result);
    assert.equal(result.details?.action, "click_mouse");
    const filePath = result.details?.filePath;
    assert.equal(typeof filePath, "string");
    assert.ok(path.basename(filePath as string).startsWith("steel-computer-"));
    assert.equal(path.extname(filePath as string), ".png");
    await rm(filePath as string);
  });

  it("types text into field after clearing and returns field metadata", async () => {
    const session: MockSession = {
      id: "session-1",
      waitForSelector: async () => {},
      evaluate: async () => ({ found: true, editable: true }),
      fill: async () => {},
    };

    const { result } = await executeTool(typeTool as unknown as MockTool, { selector: "input[name=user]", text: "Alice" }, session);
    assertTextResult(result);
    assert.equal(result.details?.selector, "input[name=user]");
    assert.equal(result.details?.clear, true);
    assert.equal(result.details?.textLength, 5);
  });

  it("preserves literal escape characters in steel_type input text", async () => {
    let filledValue = "";
    const session: MockSession = {
      id: "session-1",
      waitForSelector: async () => {},
      evaluate: async () => ({ found: true, editable: true }),
      fill: async (_selector, text) => {
        filledValue = text;
      },
    };

    const { result } = await executeTool(
      typeTool as unknown as MockTool,
      { selector: "input[name=user]", text: "C\\new" },
      session
    );

    assertTextResult(result);
    assert.equal(filledValue, "C\\new");
    assert.equal(result.details?.textLength, 5);
  });

  it("fills multiple form fields with partial success details", async () => {
    const filled: string[] = [];
    const session: MockSession = {
      id: "session-1",
      waitForSelector: async (selector) => {
        if (selector === ".missing") {
          throw new Error("No element matched selector: .missing");
        }
      },
      evaluate: async (_selector: string) => ({ found: true, editable: true }),
      fill: async (selector) => {
        filled.push(selector);
      },
    };

    const { result } = await executeTool(
      fillFormTool as unknown as MockTool,
      {
        fields: [
          { selector: "#a", value: "1" },
          { selector: ".missing", value: "2" },
          { selector: "#b", value: "3" },
        ],
      },
      session
    );

    assertTextResult(result);
    assert.equal(filled[0], "#a");
    assert.equal(filled[1], "#b");
    assert.equal(result.details?.successCount, 2);
    assert.equal(result.details?.total, 3);
  });

  it("preserves literal escape characters in steel_fill_form values", async () => {
    const values: string[] = [];
    const session: MockSession = {
      id: "session-1",
      waitForSelector: async () => {},
      evaluate: async () => true,
      fill: async (_selector, value) => {
        values.push(value);
      },
    };

    const { result } = await executeTool(
      fillFormTool as unknown as MockTool,
      {
        fields: [{ selector: "#a", value: "A\\tB" }],
      },
      session
    );

    assertTextResult(result);
    assert.equal(values[0], "A\\tB");
  });

  it("waits for selector with state and timeout contract", async () => {
    const session: MockSession = {
      id: "session-1",
      waitForSelector: async () => {},
      url: "https://waiting.example/",
    };

    const { result } = await executeTool(waitTool as unknown as MockTool, { selector: "#ready", timeout: 1000 }, session);
    assertTextResult(result);
    assert.equal(result.details?.selector, "#ready");
    assert.equal(result.details?.timeoutMs, 1000);
  });

  it("extracts structured data and validates contract", async () => {
    const session: MockSession = {
      id: "session-1",
      url: "https://extract.example/",
      evaluate: async () => ({ title: "Hello", version: 1 }),
    };

    const schema = {
      type: "object" as const,
      properties: {
        title: { type: "string" },
        version: { type: "number" },
      },
      required: ["title", "version"],
      additionalProperties: false,
    };

    const { result } = await executeTool(
      extractTool as unknown as MockTool,
      {
        schema,
        instructions: "extract title and version",
        strict: true,
      },
      session
    );

    assertTextResult(result);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.title, "Hello");
    assert.equal(parsed.version, 1);
    assert.equal(result.details?.schemaEnforced, true);
  });

  it("finds candidate selectors for interactive elements", async () => {
    const session: MockSession = {
      id: "session-1",
      url: "https://find.example/",
      evaluate: async () => [
        {
          selector: "a[href='/signup']",
          text: "Sign up",
          tag: "a",
          role: null,
          clickable: true,
          visible: true,
        },
      ],
    };

    const { result } = await executeTool(
      findElementsTool as unknown as MockTool,
      { query: "sign up", limit: 5 },
      session
    );

    assertTextResult(result);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(Array.isArray(parsed), true);
    assert.equal(parsed[0].selector, "a[href='/signup']");
    assert.equal(result.details?.count, 1);
  });

  it("scrolls page and reports movement bounds", async () => {
    const session: MockSession = {
      id: "session-1",
      evaluate: async () => ({
        before: 0,
        after: 700,
        maxScrollY: 1200,
        effectiveAmount: 700,
        viewportHeight: 500,
        contentHeight: 1400,
        targetType: "page",
        targetSelector: null,
      }),
    };

    const { result } = await executeTool(scrollTool as unknown as MockTool, { direction: "down", amount: 700 }, session);
    assertTextResult(result);
    assert.equal(result.details?.effectiveAmount, 700);
    assert.equal(result.details?.direction, "down");
    assert.equal(result.details?.targetType, "page");
  });

  it("scrolls a nested container when selector is provided", async () => {
    const session: MockSession = {
      id: "session-1",
      evaluate: async () => ({
        before: 120,
        after: 720,
        maxScrollY: 2400,
        effectiveAmount: 600,
        viewportHeight: 640,
        contentHeight: 3040,
        targetType: "container",
        targetSelector: 'div[role="feed"]',
      }),
    };

    const { result } = await executeTool(
      scrollTool as unknown as MockTool,
      { direction: "down", amount: 600, selector: 'div[role="feed"]' },
      session
    );

    assertTextResult(result);
    assert.equal(result.details?.requestedSelector, 'div[role="feed"]');
    assert.equal(result.details?.targetType, "container");
    assert.equal(result.details?.targetSelector, 'div[role="feed"]');
    assert.equal(result.details?.effectiveAmount, 600);
  });

  it("reads page history and title/url details", async () => {
    const historySession: MockSession = {
      id: "session-1",
      url: "https://history.example/",
      goBack: async () => {},
    };

    const { result: goBackResult } = await executeTool(goBackTool as unknown as MockTool, {}, historySession);
    assertTextResult(goBackResult);
    assert.equal(goBackResult.details?.url, "https://history.example/");

    const urlSession: MockSession = {
      id: "session-1",
      url: async () => "https://current.example/",
    };

    const { result: urlResult } = await executeTool(getUrlTool as unknown as MockTool, {}, urlSession);
    assertTextResult(urlResult);
    assert.equal(urlResult.content[0].text, "Current URL: https://current.example/");

    const titleSession: MockSession = {
      id: "session-1",
      title: () => "Current Title",
    };

    const { result: titleResult } = await executeTool(getTitleTool as unknown as MockTool, {}, titleSession);
    assertTextResult(titleResult);
    assert.equal(titleResult.content[0].text, "Current title: Current Title");
  });

  it("recovers go_back when history navigation completes after a timeout", async () => {
    let currentUrl = "https://news.ycombinator.com/";
    const session: MockSession = {
      id: "session-1",
      url: async () => currentUrl,
      goBack: async () => {
        currentUrl = "https://example.com/";
        throw new Error('page.goBack: Timeout 30000ms exceeded. Call log: waiting for navigation until "load"');
      },
    };

    const { result } = await executeTool(goBackTool as unknown as MockTool, {}, session);
    assertTextResult(result);
    assert.equal(result.content[0].text, "Navigated back to https://example.com/");
    assert.equal(result.details?.previousUrl, "https://news.ycombinator.com/");
    assert.equal(result.details?.url, "https://example.com/");
    assert.equal(result.details?.timeoutRecovered, true);
  });

  it("reports about:blank as a fresh session in get_url", async () => {
    const session: MockSession = {
      id: "session-1",
      url: "about:blank",
    };

    const { result } = await executeTool(getUrlTool as unknown as MockTool, {}, session);
    assertTextResult(result);
    assert.match(result.content[0].text, /fresh Steel session/i);
    assert.equal(result.details?.url, "about:blank");
    assert.equal(result.details?.isFreshSession, true);
  });

  it("fails get_title on about:blank with continuity guidance", async () => {
    const client = createMockClient({
      id: "session-1",
      url: "about:blank",
      title: async () => "",
    });
    const tool = getTitleTool(client as never);

    await assert.rejects(
      () =>
        tool.execute(
          "call-001",
          {},
          new AbortController().signal,
          async () => {},
          null
        ),
      /about:blank.*STEEL_SESSION_MODE=session/i
    );
  });

  it("fails scrape on about:blank with continuity guidance", async () => {
    const client = createMockClient({
      id: "session-1",
      url: "about:blank",
      content: async () => "<html><head></head><body></body></html>",
    });
    const tool = scrapeTool(client as never);

    await assert.rejects(
      () =>
        tool.execute(
          "call-001",
          { format: "text" },
          new AbortController().signal,
          async () => {},
          null
        ),
      /about:blank.*STEEL_SESSION_MODE=session/i
    );
  });

  it("fails find_elements on about:blank with continuity guidance", async () => {
    const client = createMockClient({
      id: "session-1",
      url: "about:blank",
      evaluate: async () => [],
    });
    const tool = findElementsTool(client as never);

    await assert.rejects(
      () =>
        tool.execute(
          "call-001",
          {},
          new AbortController().signal,
          async () => {},
          null
        ),
      /about:blank.*STEEL_SESSION_MODE=session/i
    );
  });

  it("fails on selector validation errors", async () => {
    const client = createMockClient({ id: "session-1" });
    const tool = clickTool(client as never);

    await assert.rejects(
      () =>
        tool.execute(
          "call-001",
          { selector: "" },
          new AbortController().signal,
          async () => {},
          null
        ),
      /Selector cannot be empty/,
      "expected selector validation failure"
    );
  });

  it("fails on timeout validation errors", async () => {
    const client = createMockClient({ id: "session-1" });
    const tool = waitTool(client as never);

    await assert.rejects(
      () =>
        tool.execute(
          "call-001",
          { selector: "#item", timeout: 0 },
          new AbortController().signal,
          async () => {},
          null
        ),
      /timeout must be a positive number/,
      "expected timeout validation failure"
    );
  });

  it("fails extraction when schema validation rejects result", async () => {
    const client = createMockClient({
      id: "session-1",
      evaluate: async () => ({ version: 1 }),
    });
    const tool = extractTool(client as never);

    const schema = {
      type: "object" as const,
      properties: {
        title: { type: "string" },
      },
      required: ["title"],
      additionalProperties: false,
    };

    await assert.rejects(
      () =>
        tool.execute(
          "call-001",
          { schema },
          new AbortController().signal,
          async () => {},
          null
        ),
      /Extraction result does not match requested schema/,
      "expected extraction validation failure"
    );
  });

  it("cancels wait tool when abort signal fires", async () => {
    const client = createMockClient({
      id: "session-1",
      waitForSelector: async () => {
        await new Promise(() => {});
      },
    });
    const tool = waitTool(client as never);
    const controller = new AbortController();

    const pending = tool.execute(
      "call-001",
      { selector: "#slow", timeout: 60_000 },
      controller.signal,
      async () => {},
      null
    );
    setTimeout(() => controller.abort(), 10);

    await assert.rejects(
      () => pending,
      /cancelled/i,
      "expected cancellation to abort wait tool execution"
    );
  });
});
