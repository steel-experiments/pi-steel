import { strict as assert } from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  buildSessionConnectURL,
  SteelClient,
  resolveSessionConnectURL,
  resolveSessionId,
  resolveSessionViewerURL,
  sessionDetails,
} from "../dist/steel-client.js";

const ENV_KEYS = [
  "STEEL_API_KEY",
  "STEEL_CONFIG_DIR",
  "STEEL_BASE_URL",
  "STEEL_BROWSER_API_URL",
  "STEEL_LOCAL_API_URL",
  "STEEL_API_URL",
  "STEEL_SOLVE_CAPTCHA",
  "STEEL_USE_PROXY",
  "STEEL_PROXY_URL",
  "STEEL_SESSION_HEADLESS",
  "STEEL_SESSION_PERSIST_PROFILE",
  "STEEL_SESSION_CREDENTIALS",
  "STEEL_SESSION_REGION",
  "STEEL_SESSION_PROFILE_ID",
  "STEEL_SESSION_NAMESPACE",
  "STEEL_SESSION_TIMEOUT_MS",
] as const;

const ORIGINAL_ENV = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]])
);

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("SteelClient runtime resolution", () => {
  it("reads API key from Steel config when env is unset", async () => {
    const configDir = await mkdtemp(path.join(os.tmpdir(), "pi-steel-config-"));
    try {
      await writeFile(
        path.join(configDir, "config.json"),
        JSON.stringify({ apiKey: "config-key" }),
        "utf-8"
      );
      delete process.env.STEEL_API_KEY;
      process.env.STEEL_CONFIG_DIR = configDir;

      const client = new SteelClient();

      assert.equal((client as unknown as { apiKey: string | null }).apiKey, "config-key");
      assert.equal(
        ((client as unknown as { client: { steelAPIKey: string | null } }).client.steelAPIKey),
        "config-key"
      );
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it("accepts local browser api url from Steel config and strips trailing /v1", async () => {
    const configDir = await mkdtemp(path.join(os.tmpdir(), "pi-steel-config-"));
    try {
      await writeFile(
        path.join(configDir, "config.json"),
        JSON.stringify({ browser: { apiUrl: "http://127.0.0.1:3000/v1" } }),
        "utf-8"
      );
      delete process.env.STEEL_API_KEY;
      process.env.STEEL_CONFIG_DIR = configDir;

      const client = new SteelClient();
      const internal = (client as unknown as { client: { baseURL: string }; apiKey: string | null });

      assert.equal(internal.apiKey, null);
      assert.equal(internal.client.baseURL, "http://127.0.0.1:3000");
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it("maps session defaults from env into session create options", () => {
    process.env.STEEL_API_KEY = "env-key";
    process.env.STEEL_SESSION_HEADLESS = "true";
    process.env.STEEL_SESSION_PERSIST_PROFILE = "true";
    process.env.STEEL_SESSION_CREDENTIALS = "true";
    process.env.STEEL_SESSION_REGION = "iad";
    process.env.STEEL_SESSION_PROFILE_ID = "profile-123";
    process.env.STEEL_SESSION_NAMESPACE = "ops";

    const client = new SteelClient();
    const options = (client as unknown as {
      sessionCreateOptions: Record<string, unknown>;
    }).sessionCreateOptions;

    assert.equal(options.headless, true);
    assert.equal(options.persistProfile, true);
    assert.deepEqual(options.credentials, {});
    assert.equal(options.region, "iad");
    assert.equal(options.profileId, "profile-123");
    assert.equal(options.namespace, "ops");
  });
});

describe("session normalization helpers", () => {
  it("resolves flexible session id and connect url keys", () => {
    assert.equal(resolveSessionId({ sessionId: "sess-1" }), "sess-1");
    assert.equal(resolveSessionConnectURL({ cdpUrl: "wss://connect.example/ws" }), "wss://connect.example/ws");
  });

  it("injects missing apiKey and sessionId into connect URLs", () => {
    assert.equal(
      buildSessionConnectURL(
        { id: "sess-1", websocketUrl: "wss://connect.steel.dev/" },
        "test-key"
      ),
      "wss://connect.steel.dev/?apiKey=test-key&sessionId=sess-1"
    );
    assert.equal(
      buildSessionConnectURL(
        { id: "sess-1" },
        "test-key"
      ),
      "wss://connect.steel.dev?apiKey=test-key&sessionId=sess-1"
    );
  });

  it("prefers explicit viewer url and falls back to viewer base when needed", () => {
    assert.equal(
      resolveSessionViewerURL({ viewerUrl: "https://viewer.example/session/1" }, "https://app.steel.dev"),
      "https://viewer.example/session/1"
    );
    assert.equal(
      resolveSessionViewerURL({ debugUrl: "https://debug.example/session/1" }, "https://app.steel.dev"),
      "https://debug.example/session/1"
    );
    assert.equal(
      resolveSessionViewerURL({ id: "sess-1" }, "https://app.steel.dev"),
      "https://app.steel.dev/sessions/sess-1"
    );
  });

  it("preserves normalized viewer data in session details", () => {
    assert.deepEqual(
      sessionDetails({ id: "sess-1", sessionViewerUrl: "https://viewer.example/session/1" }),
      {
        sessionId: "sess-1",
        sessionViewerUrl: "https://viewer.example/session/1",
      }
    );
  });
});
