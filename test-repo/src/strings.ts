/**
 * String utilities module — refactoring opportunities:
 * - Magic numbers (3, 10, 1000)
 * - Repeated string concatenation that could use template literals
 * - Missing type annotations
 * - Functions that could be pure (no side effects)
 */

// Magic number — minimum password length
export const MIN_PASSWORD_LENGTH = 3;
export const MAX_PASSWORD_LENGTH = 10;
export const CACHE_TTL_MS = 1000;

/**
 * Check if a string is a valid email address.
 * Uses a simple regex — could be more robust.
 * Missing return type annotation.
 */
export function isValidEmail(email: string): boolean {
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email);
}

/**
 * Truncate a string to a maximum length, adding "..." if truncated.
 * The "..." is a magic string — could be a constant.
 * Missing type annotation on the return.
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

/**
 * Capitalize the first letter of a string.
 * Missing return type.
 */
export function capitalize(text: string): string {
  if (text.length === 0) return text;
  return text[0].toUpperCase() + text.slice(1);
}

/**
 * Convert a string to kebab-case.
 * Uses multiple replace calls — could be a single regex.
 */
export function toKebabCase(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/\s+/g, "-")
    .replace(/_/g, "-")
    .toLowerCase();
}

/**
 * Check if a string is a palindrome.
 * Could use a more efficient two-pointer approach.
 */
export function isPalindrome(text: string): boolean {
  const cleaned = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned === cleaned.split("").reverse().join("");
}

/**
 * Repeat a string N times.
 * Could use the built-in String.prototype.repeat method.
 */
export function repeatString(text: string, times: number): string {
  let result = "";
  for (let i = 0; i < times; i++) {
    result = result + text;
  }
  return result;
}

/**
 * Count words in a string.
 * Could use split + filter for a cleaner implementation.
 */
export function countWords(text: string): number {
  if (text.trim().length === 0) return 0;
  return text.trim().split(/\s+/).length;
}
