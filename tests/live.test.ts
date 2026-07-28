import { strict as assert } from "node:assert";
import { it } from "node:test";
import { SteelClient } from "../src/steel-client.js";

const hasCredentials = Boolean(
  process.env.STEEL_API_KEY?.trim() || process.env.STEEL_BASE_URL?.trim()
);

it(
  "creates, drives, snapshots, and releases a live Steel session",
  { skip: !hasCredentials, timeout: 120_000 },
  async () => {
    const client = new SteelClient(undefined, {
      baseURL: process.env.STEEL_BASE_URL,
      sessionTimeoutMs: 120_000,
    });

    try {
      const session = await client.getOrCreateSession();
      await session.goto("https://example.com", {
        waitUntil: "domcontentloaded",
      });
      assert.equal(await session.title(), "Example Domain");
      const snapshot = await session.page.locator("body").ariaSnapshot();
      assert.match(snapshot, /Example Domain/);
      assert.ok(session.id);
    } finally {
      await client.closeAllSessions();
    }
  }
);
