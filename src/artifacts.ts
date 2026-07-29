import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type ArtifactKind = "screenshots" | "pdfs" | "scrapes";

function configuredArtifactRoot(): string {
  const explicit = process.env.STEEL_ARTIFACT_DIR?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }

  const cacheHome = process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), ".cache");
  return path.join(cacheHome, "steel", "pi");
}

export async function createArtifactPath(
  kind: ArtifactKind,
  prefix: string,
  extension: string
): Promise<string> {
  const directory = path.join(configuredArtifactRoot(), kind);
  await fs.mkdir(directory, { recursive: true });
  const safeId = randomUUID().slice(0, 8);
  return path.join(directory, `${prefix}-${Date.now()}-${safeId}.${extension}`);
}

export async function persistBinaryArtifact(
  filePath: string,
  payload: unknown
): Promise<void> {
  if (!(payload instanceof Uint8Array) && !(payload instanceof Buffer)) {
    return;
  }
  await fs.writeFile(filePath, Buffer.from(payload));
}

export async function assertArtifact(filePath: string): Promise<{
  absolutePath: string;
  fileName: string;
  sizeBytes: number;
}> {
  const stats = await fs.stat(filePath);
  return {
    absolutePath: filePath,
    fileName: path.basename(filePath),
    sizeBytes: stats.size,
  };
}
