export interface GitHubRateInput {
  status?: number;
  remainingHeader: string | null;
  resetHeader: string | null;
  retryAfterHeader: string | null;
  isAuthenticated: boolean;
  nowMs?: number;
}

export interface CooldownDecision {
  waitMs: number;
  reason?: string;
  shouldRetry: boolean;
  fatalError?: string;
}

const MAX_AUTO_WAIT_MS = 120_000;

/**
 * Computes pacing and rate-limit recovery cooldowns for GitHub REST API requests.
 */
export function computeGitHubCooldown(input: GitHubRateInput): CooldownDecision {
  const now = input.nowMs ?? Date.now();
  const remaining =
    input.remainingHeader && input.remainingHeader.trim() !== ''
      ? Number(input.remainingHeader)
      : null;
  const resetEpochSec =
    input.resetHeader && input.resetHeader.trim() !== '' ? Number(input.resetHeader) : null;
  const retryAfterSec =
    input.retryAfterHeader && input.retryAfterHeader.trim() !== ''
      ? Number(input.retryAfterHeader)
      : null;

  // Hard rate-limit or secondary abuse response
  if (input.status === 403 || input.status === 429) {
    if (retryAfterSec !== null && !Number.isNaN(retryAfterSec) && retryAfterSec > 0) {
      const waitMs = Math.ceil(retryAfterSec * 1000) + 250;
      if (waitMs <= MAX_AUTO_WAIT_MS) {
        return {
          waitMs,
          shouldRetry: true,
          reason: `GitHub Retry-After header requested a ${Math.ceil(waitMs / 1000)}s cooldown.`,
        };
      }
      return {
        waitMs: 0,
        shouldRetry: false,
        fatalError: `GitHub rate limit cooldown (${Math.ceil(waitMs / 1000)}s) exceeds 120s auto-wait limit. Cannot proceed automatically.`,
      };
    }

    if (remaining === 0 && resetEpochSec !== null && !Number.isNaN(resetEpochSec)) {
      const waitMs = Math.max(1000, resetEpochSec * 1000 - now + 500);
      if (waitMs <= MAX_AUTO_WAIT_MS) {
        return {
          waitMs,
          shouldRetry: true,
          reason: `GitHub primary rate limit exhausted — cooling down ${Math.ceil(waitMs / 1000)}s until reset.`,
        };
      }
      const resetTime = new Date(resetEpochSec * 1000).toLocaleTimeString();
      return {
        waitMs: 0,
        shouldRetry: false,
        fatalError: `GitHub API rate limit exhausted until ${resetTime}. Action required: Add a personal access token or retry after reset.`,
      };
    }

    // Secondary rate limit without Retry-After header (429 or 403 with remaining > 0)
    if (input.status === 429 || (input.status === 403 && remaining !== 0)) {
      return {
        waitMs: input.status === 403 ? 8000 : 5000,
        shouldRetry: true,
        reason: `GitHub secondary rate limit (HTTP ${input.status}) — cooling down ${input.status === 403 ? 8 : 5}s before retry.`,
      };
    }
  }

  // Proactive pacing based on remaining quota
  if (remaining !== null && !Number.isNaN(remaining)) {
    // Check for exhaustion based on reset time, only if not already handled by hard 403/429 logic above
    if (remaining === 0 && resetEpochSec !== null && !Number.isNaN(resetEpochSec)) {
      const waitMs = Math.max(1000, resetEpochSec * 1000 - now + 500);
      if (waitMs <= MAX_AUTO_WAIT_MS) {
        return {
          waitMs,
          shouldRetry: true,
          reason: `GitHub quota reached 0 — cooling down ${Math.ceil(waitMs / 1000)}s until reset.`,
        };
      }
    } else if (remaining < 20) {
      return {
        waitMs: 1500,
        shouldRetry: false,
        reason: `GitHub quota low (${remaining} remaining) — slowing pace to 1.5s/request.`,
      };
    } else if (remaining < 100) {
      return { waitMs: 450, shouldRetry: false };
    }
  }

  // Baseline polite cooldown
  return {
    waitMs: input.isAuthenticated ? 180 : 1100,
    shouldRetry: false,
  };
}

/**
 * Computes inter-batch and retry cooldowns for LLM API calls (Gemini / NVIDIA NIM).
 */
export function computeAiBatchCooldownMs(attempt = 0, retryAfterSec?: number | null): number {
  if (attempt === 0) {
    return 1200; // Decent 1.2s cooldown between consecutive LLM batches
  }
  
  if (retryAfterSec !== undefined && retryAfterSec !== null) {
    if (retryAfterSec <= 0) {
      throw new Error(`retryAfterSec must be a positive number, got ${retryAfterSec}. This typically indicates an invalid response from the API.`);
    }
    return Math.min(30_000, Math.ceil(retryAfterSec * 1000) + 300);
  }
  
  return Math.min(20_000, 2500 * Math.pow(2, attempt - 1));
}

export async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms < 0) {
    throw new Error(`Sleep duration must be non-negative, got ${ms}ms`);
  }
  if (ms <= 0) return;
  if (signal?.aborted) throw new Error('Operation cancelled.');
  
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('Operation cancelled during sleep'));
      };
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('Operation cancelled')) {
      throw err;
    }
    throw new Error(`Sleep operation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Wraps fetch with an automatic timeout while respecting a caller-supplied AbortSignal
 * so stalled network sockets never freeze an extraction run.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 30_000
): Promise<Response> {
  if (timeoutMs <= 0) {
    throw new Error(`timeoutMs must be a positive number, got ${timeoutMs}`);
  }

  if (!url || typeof url !== 'string' || url.trim() === '') {
    throw new Error(`URL must be a non-empty string, got ${url}`);
  }

  const controller = new AbortController();
  let timedOut = false;
  const callerSignal = init.signal;

  if (callerSignal?.aborted) {
    throw new Error(`Operation cancelled by caller before request started for ${url}.`);
  }

  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    return response;
  } catch (err) {
    if (err instanceof Error) {
      if (err.name === 'AbortError') {
        if (timedOut) {
          throw new Error(`Request to ${url} timed out after ${Math.round(timeoutMs / 1000)}s`);
        } else if (callerSignal?.aborted) {
          throw new Error(`Operation cancelled by caller during request to ${url}`);
        } else {
          throw new Error(`Request to ${url} was aborted for an unknown reason`);
        }
      }
      // General network/fetch error
      throw new Error(`Request to ${url} failed: ${err.message}`);
    }
    // Unknown error type
    throw new Error(`Request to ${url} failed with unknown error type`);
  } finally {
    clearTimeout(timer);
    // Ensure cleanup happens even if an error occurred before the timeout was set
    if (callerSignal) {
      try {
        callerSignal.removeEventListener('abort', onCallerAbort);
      } catch (e) {
        // Ignore errors during cleanup
      }
    }
  }
}