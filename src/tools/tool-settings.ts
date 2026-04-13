const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const TOOL_TIMEOUT_ENV = "STEEL_TOOL_TIMEOUT_MS";
export const MIN_TOOL_TIMEOUT_MS = 100;
export const MAX_TOOL_TIMEOUT_MS = 120_000;

let cachedDefaultToolTimeoutMs: number | null = null;

function parsePositiveInt(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }

  const value = raw.trim();
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

export function getDefaultToolTimeoutMs(): number {
  if (cachedDefaultToolTimeoutMs !== null) {
    return cachedDefaultToolTimeoutMs;
  }

  const parsed = parsePositiveInt(process.env[TOOL_TIMEOUT_ENV]);
  if (parsed === null) {
    cachedDefaultToolTimeoutMs = DEFAULT_TOOL_TIMEOUT_MS;
    return cachedDefaultToolTimeoutMs;
  }

  cachedDefaultToolTimeoutMs = Math.max(
    MIN_TOOL_TIMEOUT_MS,
    Math.min(parsed, MAX_TOOL_TIMEOUT_MS)
  );
  return cachedDefaultToolTimeoutMs;
}

export function resolveToolTimeoutMs(rawTimeout: number | undefined): number {
  if (rawTimeout === undefined) {
    return getDefaultToolTimeoutMs();
  }

  const parsed = Number(rawTimeout);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("timeout must be a positive number in milliseconds.");
  }

  const rounded = Math.max(MIN_TOOL_TIMEOUT_MS, Math.trunc(parsed));
  return Math.min(rounded, MAX_TOOL_TIMEOUT_MS);
}
