export type SteelSessionMode = "turn" | "agent" | "session";

export function resolveSessionMode(): SteelSessionMode {
  const rawValue = process.env.STEEL_SESSION_MODE?.trim().toLowerCase();
  if (!rawValue) {
    return "session";
  }

  if (rawValue === "turn" || rawValue === "agent" || rawValue === "session") {
    return rawValue;
  }

  console.warn(
    `[steel] unsupported STEEL_SESSION_MODE="${rawValue}", falling back to "session"`
  );
  return "session";
}

