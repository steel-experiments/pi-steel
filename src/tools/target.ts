import { Type } from "typebox";

export type BrowserTargetInput = {
  selector?: string;
  role?: string;
  name?: string;
  targetText?: string;
  exact?: boolean;
};

export type BrowserTarget =
  | { kind: "selector"; selector: string }
  | { kind: "role"; role: string; name?: string; exact: boolean }
  | { kind: "text"; text: string; exact: boolean };

export type TargetLocator = {
  waitFor?: (options?: {
    state?: "attached" | "visible";
    timeout?: number;
  }) => Promise<unknown>;
  isVisible?: () => Promise<boolean>;
  isEnabled?: () => Promise<boolean>;
  click?: (options?: { timeout?: number }) => Promise<unknown>;
  fill?: (value: string, options?: { timeout?: number }) => Promise<unknown>;
  pressSequentially?: (
    value: string,
    options?: { delay?: number; timeout?: number }
  ) => Promise<unknown>;
  screenshot?: (options?: { path?: string; timeout?: number }) => Promise<unknown>;
};

type LocatorFactory = {
  locator?: (selector: string) => TargetLocator;
  getByRole?: (
    role: never,
    options?: { name?: string; exact?: boolean }
  ) => TargetLocator;
  getByText?: (text: string, options?: { exact?: boolean }) => TargetLocator;
  waitForSelector?: (
    selector: string,
    options?: { state?: "attached" | "visible"; timeout?: number }
  ) => Promise<unknown>;
  click?: (selector: string, options?: { timeout?: number }) => Promise<unknown>;
  fill?: (selector: string, value: string) => Promise<unknown>;
  type?: (
    selector: string,
    value: string,
    options?: { delay?: number }
  ) => Promise<unknown>;
};

type TargetSession = LocatorFactory & {
  page?: LocatorFactory;
};

export const targetParameterProperties = {
  selector: Type.Optional(
    Type.String({ description: "CSS or Playwright selector for the target element" })
  ),
  role: Type.Optional(
    Type.String({
      description: "ARIA role for semantic targeting, such as button, link, or textbox",
    })
  ),
  name: Type.Optional(
    Type.String({ description: "Accessible name used with role targeting" })
  ),
  targetText: Type.Optional(
    Type.String({ description: "Visible text used for semantic targeting" })
  ),
  exact: Type.Optional(
    Type.Boolean({
      description: "Require an exact accessible-name or text match (default false)",
    })
  ),
};

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function resolveTarget(input: BrowserTargetInput): BrowserTarget {
  const selector = nonEmpty(input.selector);
  const role = nonEmpty(input.role);
  const name = nonEmpty(input.name);
  const text = nonEmpty(input.targetText);
  const methods = [selector ? "selector" : null, role ? "role" : null, text ? "text" : null].filter(
    Boolean
  );

  if (methods.length === 0) {
    throw new Error("Provide one target: selector, role, or text.");
  }
  if (methods.length > 1) {
    throw new Error("Provide only one target method: selector, role, or text.");
  }
  if (name && !role) {
    throw new Error("name can only be used with role targeting.");
  }

  if (selector) {
    return { kind: "selector", selector };
  }
  if (role) {
    return { kind: "role", role, ...(name ? { name } : {}), exact: input.exact ?? false };
  }
  return { kind: "text", text: text!, exact: input.exact ?? false };
}

export function describeTarget(target: BrowserTarget): string {
  if (target.kind === "selector") {
    return `selector ${target.selector}`;
  }
  if (target.kind === "role") {
    return target.name
      ? `role ${target.role} named "${target.name}"`
      : `role ${target.role}`;
  }
  return `text "${target.text}"`;
}

export function getTargetLocator(
  session: TargetSession,
  target: BrowserTarget
): TargetLocator {
  const page = session.page ?? session;

  if (target.kind === "selector") {
    const locator = session.locator?.(target.selector) ?? page.locator?.(target.selector);
    if (locator) {
      return locator;
    }

    const legacy = session.waitForSelector || session.click || session.fill || session.type
      ? session
      : page;
    if (legacy.waitForSelector || legacy.click || legacy.fill || legacy.type) {
      return {
        waitFor: legacy.waitForSelector
          ? (options) => legacy.waitForSelector!(target.selector, options)
          : undefined,
        click: legacy.click
          ? (options) => legacy.click!(target.selector, options)
          : undefined,
        fill: legacy.fill
          ? (value) => legacy.fill!(target.selector, value)
          : undefined,
        pressSequentially: legacy.type
          ? (value, options) =>
              legacy.type!(target.selector, value, { delay: options?.delay })
          : undefined,
      };
    }
  } else if (target.kind === "role") {
    const locator = page.getByRole?.(target.role as never, {
      ...(target.name ? { name: target.name } : {}),
      exact: target.exact,
    });
    if (locator) {
      return locator;
    }
  } else {
    const locator = page.getByText?.(target.text, { exact: target.exact });
    if (locator) {
      return locator;
    }
  }

  throw new Error(`Session does not support ${describeTarget(target)} targeting.`);
}
