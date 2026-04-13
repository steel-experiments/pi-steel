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
  url?: (() => Promise<string> | string) | string;
  evaluate?: <T>(fn: (...args: any[]) => T, ...args: any[]) => Promise<T>;
  page?: {
    evaluate?: <T>(fn: (...args: any[]) => T, ...args: any[]) => Promise<T>;
  };
};

type SchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
type PrimitiveSchemaType = Exclude<SchemaType, "object" | "array">;

type ExtractionSchema = {
  type: SchemaType;
  properties: Record<string, ExtractionSchema>;
  required: string[];
  items?: ExtractionSchema;
  selector?: string;
  attribute?: string;
  additionalProperties: boolean;
};

const ALLOWED_TYPES = new Set<SchemaType>([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

function asPlainObject(input: unknown, path: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`Schema at ${path} must be an object.`);
  }

  return input as Record<string, unknown>;
}

function normalizeBoolean(value: unknown, path: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  throw new Error(`Schema at ${path} must define a boolean value.`);
}

function normalizeString(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Schema at ${path} must define a string value.`);
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Schema at ${path} must not be empty.`);
  }
  return normalized;
}

function normalizeRequired(
  value: unknown,
  properties: Record<string, ExtractionSchema>,
  path: string
): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length !== value.filter((entry) => typeof entry === "string").length) {
    throw new Error(`Schema at ${path} must use an array of strings for required fields.`);
  }

  return value.filter((entry): entry is string => true);
}

function normalizeSchemaType(
  rawType: unknown,
  rawSchema: Record<string, unknown>,
  path: string
): SchemaType {
  const hasProperties =
    Object.prototype.hasOwnProperty.call(rawSchema, "properties");
  const hasItems = Object.prototype.hasOwnProperty.call(rawSchema, "items");

  if (rawType === undefined) {
    if (hasProperties) {
      return "object";
    }
    if (hasItems) {
      return "array";
    }

    throw new Error(
      `Schema at ${path} must define a type or include "properties"/"items" to infer object/array shape.`
    );
  }

  if (typeof rawType !== "string" || !ALLOWED_TYPES.has(rawType as SchemaType)) {
    throw new Error(`Schema at ${path} has unsupported type "${String(rawType)}".`);
  }

  return rawType as SchemaType;
}

function normalizeProperties(rawValue: unknown, path: string): Record<string, ExtractionSchema> {
  if (rawValue === undefined) {
    return {};
  }
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    throw new Error(`Schema at ${path} must use an object for properties.`);
  }

  const properties = rawValue as Record<string, unknown>;
  const normalized: Record<string, ExtractionSchema> = {};

  for (const [name, propertySchema] of Object.entries(properties)) {
    normalized[name] = normalizeSchema(propertySchema, `${path}.${name}`);
  }

  return normalized;
}

function normalizeSchema(rawSchema: unknown, path: string): ExtractionSchema {
  const schemaObject = asPlainObject(rawSchema, path);
  const type = normalizeSchemaType(schemaObject.type, schemaObject, path);

  const schema: ExtractionSchema = {
    type,
    properties: {},
    required: [],
    additionalProperties: true,
  };

  if (type === "object") {
    const properties = normalizeProperties(schemaObject.properties, `${path}.properties`);
    schema.properties = properties;
    schema.required = normalizeRequired(
      schemaObject.required,
      properties,
      `${path}.required`
    );
    schema.additionalProperties = normalizeBoolean(
      schemaObject.additionalProperties ?? true,
      `${path}.additionalProperties`
    );
    return schema;
  }

  if (type === "array") {
    schema.items = normalizeSchema(
      schemaObject.items,
      `${path}.items`
    );
    schema.additionalProperties = normalizeBoolean(
      schemaObject.additionalProperties ?? true,
      `${path}.additionalProperties`
    );
    return schema;
  }

  schema.selector = normalizeString(
    schemaObject.selector,
    `${path}.selector`
  );
  schema.attribute = normalizeString(
    schemaObject.attribute,
    `${path}.attribute`
  );
  schema.additionalProperties = normalizeBoolean(
    schemaObject.additionalProperties ?? true,
    `${path}.additionalProperties`
  );
  return schema;
}

function enforceStrictMode(schema: ExtractionSchema): ExtractionSchema {
  if (schema.type === "object") {
    const properties: Record<string, ExtractionSchema> = {};
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      properties[key] = enforceStrictMode(propertySchema);
    }
    return {
      ...schema,
      additionalProperties: false,
      properties,
    };
  }

  if (schema.type === "array") {
    return {
      ...schema,
      items: schema.items ? enforceStrictMode(schema.items) : undefined,
    };
  }

  return { ...schema };
}

function readSessionUrl(session: SessionLike): Promise<string> {
  const direct = session.url;
  if (typeof direct === "string" && direct.trim()) {
    return Promise.resolve(direct);
  }

  if (typeof direct === "function") {
    return Promise.resolve(direct.call(session)).then((value) => {
      if (typeof value === "string" && value.trim()) {
        return value;
      }
      return "unknown";
    });
  }

  const getter = (session as { getCurrentUrl?: () => Promise<string> | string }).getCurrentUrl;
  if (typeof getter === "function") {
    return Promise.resolve(getter.call(session)).then((value) => {
      if (typeof value === "string" && value.trim()) {
        return value;
      }
      return "unknown";
    });
  }

  return Promise.resolve("unknown");
}

function sessionDetails(session: SessionLike, url: string, scopeSelector: string | null) {
  return {
    sessionId: session.id,
    sessionViewerUrl: `https://app.steel.dev/sessions/${session.id}`,
    url,
    scopeSelector,
  };
}

function buildPrompt(summary: string, instructions: string | undefined): string {
  const instructionLine = instructions ? `\nInstructions: ${instructions}` : "";
  return `Extract structured JSON from the page following this schema contract.${instructionLine}\n${summary}`;
}

function summarizeSchema(schema: ExtractionSchema, path: string): string[] {
  const lines: string[] = [];
  const children = [];
  const requiredSet = new Set(schema.required);

  if (schema.type === "object") {
    lines.push(`${path}: object`);
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      const childPath = `${path}.${key}`;
      children.push(...summarizeSchema(
        propertySchema,
        `${childPath}${requiredSet.has(key) ? " (required)" : ""}`
      ));
    }
  } else if (schema.type === "array") {
    lines.push(`${path}: array`);
    if (schema.items) {
      lines.push(...summarizeSchema(schema.items, `${path}[]`));
    }
  } else {
    const selectorPart = schema.selector ? ` selector=${schema.selector}` : "";
    const attributePart = schema.attribute ? ` attr=${schema.attribute}` : "";
    lines.push(`${path}: ${schema.type}${selectorPart}${attributePart}`);
  }

  return [...lines, ...children];
}

function toPathPart(name: string): string {
  return name.includes(".") ? `["${name}"]` : `.${name}`;
}

function pushError(errors: string[], path: string, message: string): void {
  errors.push(`${path}: ${message}`);
}

function validateExtraction(value: unknown, schema: ExtractionSchema, path: string, errors: string[]): void {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      pushError(errors, path, "expected object");
      return;
    }

    const record = value as Record<string, unknown>;
    const valueKeys = Object.keys(record);

    if (!schema.additionalProperties) {
      for (const key of valueKeys) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
          pushError(errors, `${path}${toPathPart(key)}`, "unexpected property");
        }
      }
    }

    for (const required of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(record, required)) {
        pushError(errors, `${path}${toPathPart(required)}`, "missing required value");
      }
    }

    for (const [key, childSchema] of Object.entries(schema.properties)) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) {
        continue;
      }
      validateExtraction(record[key], childSchema, `${path}${toPathPart(key)}`, errors);
    }

    return;
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      pushError(errors, path, "expected array");
      return;
    }
    if (!schema.items) {
      return;
    }
    for (let i = 0; i < value.length; i++) {
      validateExtraction(value[i], schema.items, `${path}[${i}]`, errors);
    }
    return;
  }

  if (schema.type === "string") {
    if (typeof value !== "string") {
      pushError(errors, path, "expected string");
    }
    return;
  }

  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      pushError(errors, path, "expected finite number");
      return;
    }
    if (schema.type === "integer" && !Number.isInteger(value)) {
      pushError(errors, path, "expected integer");
    }
    return;
  }

  if (schema.type === "boolean") {
    if (typeof value !== "boolean") {
      pushError(errors, path, "expected boolean");
    }
    return;
  }

  if (value !== null) {
    pushError(errors, path, "expected null");
  }
}

function trimAndNormalizeText(raw: string | null | undefined): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw.replace(/\u00a0/g, " ").trim();
}

async function extractWithBrowser(
  session: SessionLike,
  schema: ExtractionSchema,
  scopeSelector: string | null
): Promise<unknown> {
  const evaluate = session.evaluate ?? session.page?.evaluate;
  if (typeof evaluate !== "function") {
    throw new Error("Session does not support DOM-based extraction.");
  }

  return evaluate(
    (input: { schema: ExtractionSchema; scopeSelector: string | null }): unknown => {
      const cleanText = (value: string | null): string => {
        if (typeof value !== "string") {
          return "";
        }
        return value.replace(/\u00a0/g, " ").trim();
      };

      const resolveScope = (scope: string | null): ParentNode => {
        if (!scope) {
          return document;
        }
        const root = document.querySelector(scope);
        if (!root) {
          return document;
        }
        return root;
      };

      const coercePrimitive = (source: string, schemaType: "string" | "number" | "integer" | "boolean" | "null"): string | number | boolean | null => {
        const normalized = cleanText(source);

        if (schemaType === "string") {
          return normalized;
        }

        if (schemaType === "boolean") {
          const value = normalized.toLowerCase();
          if (["true", "1", "yes", "on"].includes(value)) {
            return true;
          }
          if (["false", "0", "no", "off"].includes(value)) {
            return false;
          }
          return Boolean(normalized);
        }

        if (schemaType === "number" || schemaType === "integer") {
          const sanitized = normalized.replace(/[^0-9.-]/g, "");
          const parsed = Number.parseFloat(sanitized);
          if (!Number.isFinite(parsed)) {
            return NaN as unknown as boolean;
          }
          if (schemaType === "integer") {
            return Number.isInteger(parsed) ? parsed : NaN as unknown as boolean;
          }
          return parsed;
        }

        return null;
      };

      const findBySelector = (ctx: ParentNode, selector: string | undefined): ParentNode[] => {
        if (!selector) {
          return [ctx];
        }
        if (!("querySelectorAll" in ctx)) {
          return [];
        }

        return Array.from(ctx.querySelectorAll(selector)) as ParentNode[];
      };

      const readPrimitiveValue = (
        ctx: ParentNode,
        targetSchema: ExtractionSchema
      ): string | number | boolean | null | undefined => {
        const selector = targetSchema.selector;
        const attr = targetSchema.attribute;
        const candidates = findBySelector(ctx, selector);
        if (!candidates[0] || !(candidates[0] instanceof Element)) {
          return undefined;
        }

        const element = candidates[0] as Element & { value?: unknown };
        if (attr) {
          const attributeValue = element.getAttribute(attr);
          if (attributeValue === null) {
            return undefined;
          }
          const casted = coercePrimitive(attributeValue, targetSchema.type as PrimitiveSchemaType);
          return typeof casted === "number" && !Number.isFinite(casted)
            ? undefined
            : casted;
        }

        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          const casted = coercePrimitive(
            String((element as HTMLInputElement).value ?? ""),
            targetSchema.type as PrimitiveSchemaType
          );
          return typeof casted === "number" && !Number.isFinite(casted)
            ? undefined
            : casted;
        }

        const casted = coercePrimitive(
          element.textContent ?? "",
          targetSchema.type as PrimitiveSchemaType
        );
        return typeof casted === "number" && !Number.isFinite(casted)
          ? undefined
          : casted;
      };

      const extract = (ctx: ParentNode, currentSchema: ExtractionSchema): unknown => {
        if (currentSchema.type === "object") {
          const base = currentSchema.selector ? findBySelector(ctx, currentSchema.selector)[0] : ctx;
          if (!base || !(base instanceof Element) && base !== document) {
            return undefined;
          }

          const result: Record<string, unknown> = {};
          for (const [key, childSchema] of Object.entries(currentSchema.properties)) {
            const childValue = extract(base, childSchema);
            if (childValue !== undefined) {
              result[key] = childValue;
            }
          }
          return result;
        }

        if (currentSchema.type === "array") {
          if (!currentSchema.items) {
            return [];
          }

          const nodes = currentSchema.selector ? findBySelector(ctx, currentSchema.selector) : [];
          if (nodes.length === 0) {
            return [];
          }

          const extracted = [];
          for (const node of nodes) {
            if (node instanceof Element) {
              const value = extract(node, currentSchema.items);
              extracted.push(value);
            }
          }
          return extracted;
        }

        const value = readPrimitiveValue(ctx, currentSchema);
        return value;
      };

      const root = resolveScope(input.scopeSelector);
      return extract(root, input.schema);
    },
    { schema, scopeSelector }
  );
}

export function extractTool(client: SteelClient): ToolDefinition<any, any> {
  return {
    name: "steel_extract",
    label: "Extract",
    description: "Extract structured values from page content using a JSON Schema contract",
    parameters: Type.Object({
      schema: Type.Object({}, { additionalProperties: true, description: "JSON-Schema-like extraction contract." }),
      instructions: Type.Optional(
        Type.String({ description: "Optional extraction guidance used to disambiguate field selection." })
      ),
      scopeSelector: Type.Optional(
        Type.String({ description: "Optional CSS selector that scopes extraction to a container." })
      ),
      strict: Type.Optional(
        Type.Boolean({ description: "Reject properties not defined in schema (default true)." })
      ),
    }),

    async execute(
      _toolCallId: string,
      params: {
        schema: Record<string, unknown>;
        instructions?: string;
        scopeSelector?: string;
        strict?: boolean;
      },
      signal: AbortSignal | undefined,
      onUpdate: ToolProgressUpdater,
      _ctx: ExtensionContext
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: object }> {
      return withToolError("steel_extract", async () => {
        throwIfAborted(signal);
        const scopeSelector = normalizeString(params.scopeSelector, "scopeSelector") ?? null;
        const strict = params.strict ?? true;
        await emitProgress(onUpdate, "steel_extract", "Preparing structured extraction");

        const normalizedSchema = normalizeSchema(params.schema, "schema");
        const enforcedSchema = strict ? enforceStrictMode(normalizedSchema) : normalizedSchema;
        const prompt = buildPrompt(
          summarizeSchema(enforcedSchema, "result").join("\n"),
          params.instructions
        );

        const session = (await withAbortSignal(
          client.getOrCreateSession(),
          signal
        )) as SessionLike;
        throwIfAborted(signal);
        const url = await readSessionUrl(session);

        await emitProgress(onUpdate, "steel_extract", `Preparing prompt with ${prompt.split("\n").length} lines`);
        const extracted = await withAbortSignal(
          extractWithBrowser(session, enforcedSchema, scopeSelector),
          signal
        );

        const validationErrors: string[] = [];
        validateExtraction(extracted, enforcedSchema, "result", validationErrors);
        if (validationErrors.length > 0) {
          throw new Error(
            `Extraction result does not match requested schema:\n${validationErrors
              .map((error) => `- ${error}`)
              .join("\n")}`
          );
        }

        await emitProgress(onUpdate, "steel_extract", "Extraction validated");
        return {
          content: [{
            type: "text",
            text: JSON.stringify(extracted, null, 2),
          }],
          details: {
            ...sessionDetails(session, url, scopeSelector),
            schemaEnforced: strict,
            prompt,
          },
        };
      }, signal);
    },
  };
}
