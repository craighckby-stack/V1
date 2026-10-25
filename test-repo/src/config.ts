/**
 * Config module — refactoring opportunities:
 * - Magic numbers for defaults
 * - Missing type annotations
 * - Repeated validation logic
 * - Mutable global config that could be immutable
 */

export interface Config {
  port: number;
  host: string;
  logLevel: string;
  maxConnections: number;
  timeoutMs: number;
}

export const DEFAULT_PORT = 3000;
export const DEFAULT_HOST = "localhost";
export const DEFAULT_LOG_LEVEL = "info";
export const DEFAULT_MAX_CONNECTIONS = 100;
export const DEFAULT_TIMEOUT_MS = 5000;

const defaultConfig: Config = {
  port: DEFAULT_PORT,
  host: DEFAULT_HOST,
  logLevel: DEFAULT_LOG_LEVEL,
  maxConnections: DEFAULT_MAX_CONNECTIONS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
};

let currentConfig: Config = { ...defaultConfig };

/**
 * Get the current configuration.
 * Returns a copy to prevent external mutation.
 */
export function getConfig(): Config {
  return { ...currentConfig };
}

/**
 * Update the configuration with partial values.
 * Could use Object.assign or spread.
 */
export function updateConfig(partial: Partial<Config>): Config {
  currentConfig = { ...currentConfig, ...partial };
  return getConfig();
}

/**
 * Reset configuration to defaults.
 */
export function resetConfig(): Config {
  currentConfig = { ...defaultConfig };
  return getConfig();
}

/**
 * Validate a config object.
 * Repeated if/else — could use a validation schema.
 */
export function validateConfig(config: Config): string[] {
  const errors: string[] = [];
  if (config.port < 1 || config.port > 65535) {
    errors.push("port must be between 1 and 65535");
  }
  if (config.host.length === 0) {
    errors.push("host cannot be empty");
  }
  if (config.maxConnections < 1) {
    errors.push("maxConnections must be at least 1");
  }
  if (config.timeoutMs < 100) {
    errors.push("timeoutMs must be at least 100");
  }
  return errors;
}
