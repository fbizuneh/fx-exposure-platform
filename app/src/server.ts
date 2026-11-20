// Entry point: `npm run start`. Reads the settings, starts the runtime, and stops cleanly on SIGTERM or SIGINT.
import { ConfigInvalid, loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { startRuntime } from "./runtime.ts";

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (err instanceof ConfigInvalid) {
    console.error(JSON.stringify({ level: "error", msg: "cannot start", problems: err.problems }));
    process.exit(2);
  }
  throw err;
}
const log = createLogger(config.logLevel);

let runtime;
try {
  runtime = await startRuntime(config, log);
} catch (err) {
  log.error("cannot start", { error: err });
  process.exit(1);
}

let stopping = false;
const stop = (signal: string) => {
  if (stopping) process.exit(1); // a second signal stops at once
  stopping = true;
  log.info("stopping", { signal });
  void runtime.shutdown(20_000).then(() => process.exit(0), (err) => { log.error("shutdown failed", { error: err }); process.exit(1); });
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
