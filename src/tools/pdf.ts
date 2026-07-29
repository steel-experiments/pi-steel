import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  assertArtifact,
  createArtifactPath,
  persistBinaryArtifact,
} from "../artifacts.js";
import { sessionDetails as baseSessionDetails, type SteelClient } from "../steel-client.js";
import {
  emitProgress,
  throwIfAborted,
  withAbortSignal,
  withToolError,
  type ToolProgressUpdater,
} from "./tool-runtime.js";

type SessionLike = {
  id: string;
  sessionViewerUrl?: string | null;
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

const DEFAULT_PDF_OPTIONS = {
  printBackground: true,
  preferCSSPageSize: true,
};

function sessionDetails(session: SessionLike, url: string) {
  return {
    ...baseSessionDetails(session),
    url,
  };
}

async function makeArtifactPath(): Promise<string> {
  return createArtifactPath("pdfs", "steel-pdf", "pdf");
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
        await persistBinaryArtifact(targetPath, pdfResult);
        const artifactFile = await assertArtifact(targetPath);

        return {
          content: [{
            type: "text",
            text: `PDF saved: ${artifactFile.absolutePath}`,
          }],
          details: {
            ...sessionDetails(session, url),
            filePath: artifactFile.absolutePath,
            artifact: {
              type: "pdf",
              mimeType: "application/pdf",
              path: artifactFile.absolutePath,
              fileName: artifactFile.fileName,
              sizeBytes: artifactFile.sizeBytes,
              createdAt: new Date().toISOString(),
            },
            options,
          },
        };
      }, signal);
    },
  };
}
