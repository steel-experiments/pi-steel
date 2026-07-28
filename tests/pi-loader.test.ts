import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

it("loads the compiled package through Pi's extension loader", async () => {
  const isolatedDirectory = await mkdtemp(path.join(os.tmpdir(), "steel-pi-loader-"));
  try {
    const resourceLoader = new DefaultResourceLoader({
      cwd: isolatedDirectory,
      agentDir: isolatedDirectory,
      additionalExtensionPaths: [
        path.resolve(import.meta.dirname, "../dist/index.js"),
      ],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });

    await resourceLoader.reload();
    const result = resourceLoader.getExtensions();
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    assert.ok(result.extensions[0]?.tools.has("steel_navigate"));
    assert.ok(result.extensions[0]?.tools.has("steel_snapshot"));
    assert.ok(result.extensions[0]?.tools.has("steel_release_session"));
  } finally {
    await rm(isolatedDirectory, { recursive: true, force: true });
  }
});
