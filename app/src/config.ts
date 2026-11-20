// The runtime's settings, read once from the environment at start-up (decision 0023).
export interface Config {
  readonly databaseUrl: string;
  readonly port: number;
  readonly migrateOnStart: boolean;
  readonly timerEnabled: boolean;
  readonly deliveryIntervalSeconds: number;
  readonly cycleCheckIntervalSeconds: number;
  readonly timezone: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
}

export class ConfigInvalid extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`the settings are not valid: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/** Reads and checks every setting; all problems are reported together. */
export function loadConfig(env: Env): Config {
  const problems: string[] = [];
  const text = (name: string): string | undefined => {
    const v = env[name];
    return v === undefined || v.trim() === "" ? undefined : v.trim();
  };
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const v = text(name);
    if (v === undefined) return fallback;
    if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) {
      problems.push(`${name} must be a whole number from ${min} to ${max}`);
      return fallback;
    }
    return Number(v);
  };
  const flag = (name: string, fallback: boolean): boolean => {
    const v = text(name);
    if (v === undefined) return fallback;
    if (v === "true") return true;
    if (v === "false") return false;
    problems.push(`${name} must be true or false`);
    return fallback;
  };

  const databaseUrl = text("DATABASE_URL");
  if (databaseUrl === undefined) problems.push("DATABASE_URL is required");
  else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) problems.push("DATABASE_URL must start with postgres:// or postgresql://");

  const timezone = text("PLATFORM_TIMEZONE") ?? "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
  } catch {
    problems.push(`PLATFORM_TIMEZONE is not a known time zone: ${timezone}`);
  }

  const level = text("LOG_LEVEL") ?? "info";
  if (!["debug", "info", "warn", "error"].includes(level)) problems.push("LOG_LEVEL must be debug, info, warn or error");

  const config: Config = {
    databaseUrl: databaseUrl ?? "",
    port: integer("PORT", 8080, 0, 65535),
    migrateOnStart: flag("MIGRATE_ON_START", true),
    timerEnabled: flag("TIMER_ENABLED", true),
    deliveryIntervalSeconds: integer("DELIVERY_INTERVAL_SECONDS", 5, 1, 3600),
    cycleCheckIntervalSeconds: integer("CYCLE_CHECK_INTERVAL_SECONDS", 60, 1, 86400),
    timezone,
    logLevel: level as Config["logLevel"],
  };
  if (problems.length > 0) throw new ConfigInvalid(problems);
  return config;
}
