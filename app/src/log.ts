// One JSON object per line on standard output. Log identifiers and counts, never row contents, amounts, file text or credentials.
export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET = /^(password|passwd|secret|token|authorization|cookie|api[_-]?key)$/i;

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

function clean(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return { message: value.message, stack: value.stack };
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET.test(k) ? "[redacted]" : clean(v, depth + 1)]));
}

export function createLogger(level: Level, write: (line: string) => void = (l) => process.stdout.write(l + "\n"), now: () => Date = () => new Date()): Logger {
  const at = (l: Level) => (msg: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[l] < ORDER[level]) return;
    write(JSON.stringify({ time: now().toISOString(), level: l, msg, ...(clean(fields) as object) }));
  };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}
