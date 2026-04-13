import {
  emitProgress,
  isAbortError,
  sleepWithSignal,
  throwIfAborted,
  type ToolProgressUpdater,
} from "./tool-runtime.js";

const CAPTCHA_WAIT_MS_ENV = "STEEL_CAPTCHA_WAIT_MS";
const CAPTCHA_MAX_RETRIES_ENV = "STEEL_CAPTCHA_MAX_RETRIES";
const CAPTCHA_POLL_INTERVAL_MS_ENV = "STEEL_CAPTCHA_POLL_INTERVAL_MS";

const DEFAULT_CAPTCHA_WAIT_MS = 45_000;
const DEFAULT_CAPTCHA_MAX_RETRIES = 1;
const DEFAULT_CAPTCHA_POLL_INTERVAL_MS = 1_500;

const MIN_CAPTCHA_WAIT_MS = 1_000;
const MAX_CAPTCHA_WAIT_MS = 180_000;
const MIN_CAPTCHA_POLL_INTERVAL_MS = 250;
const MAX_CAPTCHA_POLL_INTERVAL_MS = 10_000;
const MAX_CAPTCHA_RETRIES = 3;

type CaptchaStatusEntry = {
  isSolvingCaptcha?: boolean;
  tasks?: unknown;
};

export type CaptchaAwareSession = {
  id: string;
  captchasStatus?: () => Promise<unknown>;
  captchasSolve?: () => Promise<unknown>;
};

export type CaptchaRecoverySummary = {
  triggered: boolean;
  retries: number;
  solveAttempts: number;
  statusChecks: number;
  waitTimedOut: boolean;
};

type CaptchaRecoveryOptions<T> = {
  session: CaptchaAwareSession;
  context: string;
  actionLabel: string;
  onUpdate: ToolProgressUpdater;
  operation: () => Promise<T>;
  signal?: AbortSignal;
  shouldRetry?: (error: unknown) => boolean;
};

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

function resolveCaptchaWaitMs(): number {
  const parsed = parsePositiveInt(process.env[CAPTCHA_WAIT_MS_ENV]);
  if (parsed === null) {
    return DEFAULT_CAPTCHA_WAIT_MS;
  }
  return Math.max(MIN_CAPTCHA_WAIT_MS, Math.min(parsed, MAX_CAPTCHA_WAIT_MS));
}

function resolveCaptchaMaxRetries(): number {
  const parsed = parsePositiveInt(process.env[CAPTCHA_MAX_RETRIES_ENV]);
  if (parsed === null) {
    return DEFAULT_CAPTCHA_MAX_RETRIES;
  }
  return Math.max(0, Math.min(parsed, MAX_CAPTCHA_RETRIES));
}

function resolveCaptchaPollIntervalMs(): number {
  const parsed = parsePositiveInt(process.env[CAPTCHA_POLL_INTERVAL_MS_ENV]);
  if (parsed === null) {
    return DEFAULT_CAPTCHA_POLL_INTERVAL_MS;
  }
  return Math.max(
    MIN_CAPTCHA_POLL_INTERVAL_MS,
    Math.min(parsed, MAX_CAPTCHA_POLL_INTERVAL_MS)
  );
}

function normalizeErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message.toLowerCase();
  }
  if (typeof error === "string") {
    return error.toLowerCase();
  }
  return String(error ?? "").toLowerCase();
}

export function isCaptchaInterferenceError(error: unknown): boolean {
  const message = normalizeErrorText(error);
  return (
    message.includes("captcha") ||
    message.includes("hcaptcha") ||
    message.includes("recaptcha") ||
    message.includes("intercepts pointer events")
  );
}

function normalizeCaptchaStatusEntries(value: unknown): CaptchaStatusEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (entry): entry is CaptchaStatusEntry =>
      typeof entry === "object" && entry !== null
  );
}

function hasActiveCaptcha(entries: CaptchaStatusEntry[]): boolean {
  for (const entry of entries) {
    if (entry.isSolvingCaptcha) {
      return true;
    }
    if (Array.isArray(entry.tasks) && entry.tasks.length > 0) {
      return true;
    }
  }
  return false;
}

async function tryReadCaptchaStatus(
  session: CaptchaAwareSession,
  summary: CaptchaRecoverySummary,
  signal: AbortSignal | undefined
): Promise<CaptchaStatusEntry[]> {
  throwIfAborted(signal);
  if (typeof session.captchasStatus !== "function") {
    return [];
  }
  const status = await session.captchasStatus();
  summary.statusChecks += 1;
  return normalizeCaptchaStatusEntries(status);
}

async function runCaptchaRecoveryStep(
  session: CaptchaAwareSession,
  context: string,
  actionLabel: string,
  onUpdate: ToolProgressUpdater,
  summary: CaptchaRecoverySummary,
  signal: AbortSignal | undefined
): Promise<void> {
  throwIfAborted(signal);
  const waitMs = resolveCaptchaWaitMs();
  const pollIntervalMs = resolveCaptchaPollIntervalMs();
  const deadline = Date.now() + waitMs;

  let statusEntries: CaptchaStatusEntry[] = [];
  try {
    statusEntries = await tryReadCaptchaStatus(session, summary, signal);
  } catch (error: unknown) {
    if (isAbortError(error)) {
      throw error;
    }
    await emitProgress(
      onUpdate,
      context,
      `Captcha status check failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`
    );
  }

  if (statusEntries.length > 0) {
    await emitProgress(
      onUpdate,
      context,
      `Captcha status detected for ${statusEntries.length} page(s)`
    );
  } else {
    await emitProgress(
      onUpdate,
      context,
      "No explicit captcha status returned; attempting solve anyway"
    );
  }

  if (typeof session.captchasSolve === "function") {
    throwIfAborted(signal);
    summary.solveAttempts += 1;
    try {
      const solveResult = await session.captchasSolve();
      const message =
        typeof solveResult === "object" &&
        solveResult !== null &&
        "message" in solveResult &&
        typeof (solveResult as { message?: unknown }).message === "string"
          ? (solveResult as { message: string }).message
          : "captcha solve requested";
      await emitProgress(onUpdate, context, `Captcha solve call: ${message}`);
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw error;
      }
      await emitProgress(
        onUpdate,
        context,
        `Captcha solve call failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`
      );
    }
  } else {
    await emitProgress(
      onUpdate,
      context,
      "Session does not expose captchas.solve; proceeding with retry"
    );
  }

  while (Date.now() < deadline && typeof session.captchasStatus === "function") {
    throwIfAborted(signal);
    await sleepWithSignal(pollIntervalMs, signal);
    try {
      statusEntries = await tryReadCaptchaStatus(session, summary, signal);
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw error;
      }
      await emitProgress(
        onUpdate,
        context,
        `Captcha status polling failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`
      );
      break;
    }

    if (!hasActiveCaptcha(statusEntries)) {
      await emitProgress(onUpdate, context, "Captcha state cleared; retrying action");
      return;
    }
  }

  if (typeof session.captchasStatus === "function") {
    summary.waitTimedOut = true;
    await emitProgress(
      onUpdate,
      context,
      `Captcha wait reached ${waitMs}ms; retrying ${actionLabel}`
    );
  }
}

export async function runWithCaptchaRecovery<T>(
  options: CaptchaRecoveryOptions<T>
): Promise<CaptchaRecoverySummary> {
  const {
    session,
    context,
    actionLabel,
    onUpdate,
    operation,
    signal,
    shouldRetry = isCaptchaInterferenceError,
  } = options;

  const maxRetries = resolveCaptchaMaxRetries();
  const summary: CaptchaRecoverySummary = {
    triggered: false,
    retries: 0,
    solveAttempts: 0,
    statusChecks: 0,
    waitTimedOut: false,
  };

  let attempt = 0;
  while (true) {
    throwIfAborted(signal);
    try {
      await operation();
      return summary;
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw error;
      }
      throwIfAborted(signal);
      const retriable = shouldRetry(error);
      if (!retriable || attempt >= maxRetries) {
        throw error;
      }

      summary.triggered = true;
      summary.retries += 1;
      await emitProgress(
        onUpdate,
        context,
        `Captcha-related blocker detected while trying to ${actionLabel}`
      );
      await runCaptchaRecoveryStep(
        session,
        context,
        actionLabel,
        onUpdate,
        summary,
        signal
      );
      attempt += 1;
    }
  }
}
