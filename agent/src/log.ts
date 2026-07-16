// Structured console logger. Not pino — this project only needs readable,
// greppable, timestamped lines for demo footage and troubleshooting, and
// pino would be one more dependency to manage against this stack's history
// of version-mismatch surprises. Every line is a single JSON-friendly
// object printed as text, so it's easy to eyeball live and still parseable
// if someone pipes it through `jq` later.

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogMeta = Record<string, unknown>;

function timestamp(): string {
  return new Date().toISOString();
}

function formatMeta(meta?: LogMeta): string {
  if (!meta || Object.keys(meta).length === 0) return "";
  const parts = Object.entries(meta).map(([key, value]) => {
    const rendered = typeof value === "bigint" ? value.toString() : value;
    return `${key}=${JSON.stringify(rendered)}`;
  });
  return " " + parts.join(" ");
}

function write(level: LogLevel, scope: string, message: string, meta?: LogMeta): void {
  const line = `[${timestamp()}] [${level.toUpperCase()}] [${scope}] ${message}${formatMeta(meta)}`;
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
}

/** Creates a logger prefixed with `scope` (e.g. "keeper", "cli:verify"). */
export function createLogger(scope: string): Logger {
  return {
    debug: (message, meta) => write("debug", scope, message, meta),
    info: (message, meta) => write("info", scope, message, meta),
    warn: (message, meta) => write("warn", scope, message, meta),
    error: (message, meta) => write("error", scope, message, meta),
  };
}
