import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { SteelClient } from "../steel-client.js";
import {
  emitProgress,
  throwIfAborted,
  withAbortSignal,
  withToolError,
  type ToolProgressUpdater,
} from "./tool-runtime.js";

type SessionLike = {
  id: string;
  pdf?: (options?: {
    path?: string;
    printBackground?: boolean;
    preferCSSPageSize?: boolean;
  }) => Promise<unknown>;
  page?: {
    pdf?: (options?: {
      path?: string;
      printBackground?: boolean;
      preferCSSPageSize?: boolean;
    }) => Promise<unknown>;
  };
  url?: (() => Promise<string> | string) | string;
};

const RELATIVE_PDF_DIR = path.join(".artifacts", "pdfs");
const DEFAULT_PDF_OPTIONS = {
  printBackground: true,
  preferCSSPageSize: true,
};

function sessionDetails(session: SessionLike, url: string) {
  return {
    sessionId: session.id,
    sessionViewerUrl: `https://app.steel.dev/sessions/${session.id}`,
    url,
  };
}

function artifactDirectory(): string {
  return path.resolve(process.cwd(), RELATIVE_PDF_DIR);
}

function toArtifactDisplayPath(filePath: string): string {
  const relativePath = path.relative(process.cwd(), filePath);
  if (!relativePath || relativePath.startsWith("..")) {
    return path.basename(filePath);
  }
  return relativePath;
}

async function makeArtifactPath(): Promise<string> {
  const dir = artifactDirectory();
  await fs.mkdir(dir, { recursive: true });
  const safeId = randomUUID().slice(0, 8);
  return path.join(dir, `steel-pdf-${Date.now()}-${safeId}.pdf`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isBinaryLike(value: unknown): Buffer | Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof Buffer) {
    return value;
  }

  return null;
}

async function writeBinaryArtifact(filePath: string, payload: unknown): Promise<void> {
  const binary = isBinaryLike(payload);
  if (!binary) {
    return;
  }

  await fs.writeFile(filePath, Buffer.from(binary));
}

async function readSessionUrl(session: SessionLike): Promise<string> {
  const direct = session.url;
  if (typeof direct === "string" && direct.trim()) {
    return direct;
  }

  if (typeof direct === "function") {
    const value = await direct.call(session);
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

async function generatePdf(session: SessionLike, filePath: string): Promise<unknown> {
  const pdfCall = session.pdf ?? session.page?.pdf;
  if (typeof pdfCall !== "function") {
    throw new Error("Session does not support PDF generation.");
  }

  const options = { path: filePath, ...DEFAULT_PDF_OPTIONS };

  if (pdfCall === session.pdf) {
    return session.pdf?.(options);
  }

  return session.page?.pdf?.(options);
}

export function pdfTool(client: SteelClient): ToolDefinition<any, any> {
  return {
    name: "steel_pdf",
    label: "PDF",
    description: "Capture the current page as a PDF artifact",
    parameters: Type.Object({
      printBackground: Type.Optional(
        Type.Boolean({
          description: "Whether to include page background graphics in the PDF",
        })
      ),
      preferCSSPageSize: Type.Optional(
        Type.Boolean({
          description: "Whether to use page-defined CSS size when available",
        })
      ),
    }),

    async execute(
      _toolCallId: string,
      params: {
        printBackground?: boolean;
        preferCSSPageSize?: boolean;
      },
      signal: AbortSignal | undefined,
      onUpdate: ToolProgressUpdater,
      _ctx: ExtensionContext
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: object }> {
      return withToolError("steel_pdf", async () => {
        throwIfAborted(signal);
        await emitProgress(onUpdate, "steel_pdf", "Preparing PDF artifact path");

        const session = (await withAbortSignal(
          client.getOrCreateSession(),
          signal
        )) as SessionLike;
        throwIfAborted(signal);
        const url = await readSessionUrl(session);
        const targetPath = await makeArtifactPath();
        const options = {
          printBackground:
            params.printBackground !== undefined
              ? params.printBackground
              : DEFAULT_PDF_OPTIONS.printBackground,
          preferCSSPageSize:
            params.preferCSSPageSize !== undefined
              ? params.preferCSSPageSize
              : DEFAULT_PDF_OPTIONS.preferCSSPageSize,
        };

        const pdfOptions = {
          ...options,
          path: targetPath,
        };

        await emitProgress(onUpdate, "steel_pdf", "Generating PDF now");
        const pdfResult = await (async () => {
          const pdfCall = session.pdf ?? session.page?.pdf;
          if (typeof pdfCall !== "function") {
            throw new Error("Session does not support PDF generation.");
          }

          if (pdfCall === session.pdf) {
            return session.pdf?.(pdfOptions);
          }

          return session.page?.pdf?.(pdfOptions);
        })();

        await emitProgress(onUpdate, "steel_pdf", `Writing PDF to ${targetPath}`);
        await writeBinaryArtifact(targetPath, pdfResult);

        if (!(await fileExists(targetPath))) {
          throw new Error("PDF artifact was not written to disk.");
        }

        const stats = await fs.stat(targetPath);
        const fileName = path.basename(targetPath);
        const displayPath = toArtifactDisplayPath(targetPath);

        return {
          content: [{
            type: "text",
            text: `PDF saved: ${fileName}`,
          }],
          details: {
            ...sessionDetails(session, url),
            artifact: {
              type: "pdf",
              mimeType: "application/pdf",
              path: displayPath,
              fileName,
              sizeBytes: stats.size,
              createdAt: new Date().toISOString(),
            },
            options,
          },
        };
      }, signal);
    },
  };
}
