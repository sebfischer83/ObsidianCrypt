/**
 * Privacy-preserving logger. Log fields can only be numbers, booleans or null – never free text – so file
 * contents, passwords, keys, tokens or decrypted manifests cannot end up in logs by accident.
 * Messages must be string literals (enforced by the type system). Paths are only logged through
 * {@link Logger.path} and only if the user explicitly enabled it.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

declare const redactedBrand: unique symbol;
export type RedactedPath = string & { readonly [redactedBrand]: true };

export type LogFields = Readonly<Record<string, number | boolean | null | RedactedPath>>;

/**
 * An interpolated template string has the wide type `string` and is rejected, so runtime data can not
 * be smuggled into a log message.
 */
export type StaticMessage<T extends string> = string extends T ? never : T;

export interface LogSink {
  write(level: LogLevel, message: string, fields: Record<string, unknown>): void;
}

export const consoleSink: LogSink = {
  write(level, message, fields) {
    const line = `[encrypted-sync] ${message}`;
    const extra = Object.keys(fields).length > 0 ? [fields] : [];
    if (level === "error") console.error(line, ...extra);
    else if (level === "warn") console.warn(line, ...extra);
    else if (level === "info") console.info(line, ...extra);
    else console.debug(line, ...extra);
  },
};

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export class Logger {
  constructor(
    private readonly sink: LogSink = consoleSink,
    public level: LogLevel = "info",
    /** Only with explicit user consent (debug setting). */
    public allowPaths = false,
  ) {}

  path(path: string): RedactedPath {
    return (this.allowPaths ? path : "<path>") as RedactedPath;
  }

  debug<T extends string>(message: StaticMessage<T>, fields: LogFields = {}): void {
    this.log("debug", message, fields);
  }

  info<T extends string>(message: StaticMessage<T>, fields: LogFields = {}): void {
    this.log("info", message, fields);
  }

  warn<T extends string>(message: StaticMessage<T>, fields: LogFields = {}): void {
    this.log("warn", message, fields);
  }

  error<T extends string>(message: StaticMessage<T>, fields: LogFields = {}): void {
    this.log("error", message, fields);
  }

  private log(level: LogLevel, message: string, fields: LogFields): void {
    if (ORDER[level] < ORDER[this.level]) return;
    this.sink.write(level, message, { ...fields });
  }
}

export const silentLogger = new Logger({ write: () => undefined }, "error");
