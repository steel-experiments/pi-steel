type SessionGetter = (() => Promise<string> | string) | string;

export type SessionStateLike = {
  url?: SessionGetter;
  title?: SessionGetter;
  getCurrentUrl?: () => Promise<string> | string;
};

export async function readSessionUrl(session: SessionStateLike): Promise<string> {
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

  if (typeof session.getCurrentUrl === "function") {
    const value = await session.getCurrentUrl.call(session);
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return "unknown";
}

export async function readSessionTitle(session: SessionStateLike): Promise<string> {
  const direct = session.title;
  if (typeof direct === "string" && direct.trim()) {
    return direct;
  }

  if (typeof direct === "function") {
    const value = await direct.call(session);
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return "unknown";
}

export function isBlankPageUrl(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  return normalized === "about:blank" || normalized === "about:srcdoc";
}

export function freshSessionHint(): string {
  return "This usually means Pi started a fresh Steel session. Navigate to a page first, or run Pi with STEEL_SESSION_MODE=session to keep the same browser across prompts.";
}

export function blankPageError(action: string): Error {
  return new Error(`Cannot ${action} because the current page is about:blank. ${freshSessionHint()}`);
}

export function describeBlankPage(url: string): string {
  return `Current URL: ${url} (fresh Steel session; navigate first or use STEEL_SESSION_MODE=session for cross-prompt continuity)`;
}

