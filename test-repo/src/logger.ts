/**
 * Logger module — refactoring opportunities:
 * - Magic strings for log levels
 * - Missing type annotations
 * - Console.log calls that could be wrapped for testability
 * - No log level filtering
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLogLevel: LogLevel = "info";

/**
 * Set the minimum log level.
 * Missing return type.
 */
export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

/**
 * Check if a message should be logged at the current level.
 */
export function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLogLevel];
}

/**
 * Format a log message with timestamp and level.
 * The timestamp format is magic — could be a constant.
 */
export function formatMessage(level: LogLevel, message: string): string {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
}

/**
 * Log a debug message.
 */
export function debug(message: string): void {
  if (shouldLog("debug")) {
    console.debug(formatMessage("debug", message));
  }
}

/**
 * Log an info message.
 */
export function info(message: string): void {
  if (shouldLog("info")) {
    console.info(formatMessage("info", message));
  }
}

/**
 * Log a warning message.
 */
export function warn(message: string): void {
  if (shouldLog("warn")) {
    console.warn(formatMessage("warn", message));
  }
}

/**
 * Log an error message.
 */
export function error(message: string): void {
  if (shouldLog("error")) {
    console.error(formatMessage("error", message));
  }
}
