/**
 * Array utilities module — refactoring opportunities:
 * - Manual loops that could use built-in array methods
 * - Missing type annotations on generic functions
 * - Magic numbers
 * - Functions that could be more generic
 */

export const DEFAULT_PAGE_SIZE = 10;
export const MAX_BATCH_SIZE = 100;

/**
 * Chunk an array into smaller arrays of a given size.
 * Uses a manual loop — could use Array.from with a mapper.
 */
export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [];
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

/**
 * Remove duplicate values from an array.
 * Uses a manual loop with indexOf — could use Set.
 */
export function unique<T>(arr: T[]): T[] {
  const result: T[] = [];
  for (const item of arr) {
    if (result.indexOf(item) === -1) {
      result.push(item);
    }
  }
  return result;
}

/**
 * Group array items by a key function.
 * Missing type annotation on the return value.
 */
export function groupBy<T, K extends string | number>(
  arr: T[],
  keyFn: (item: T) => K
): Record<K, T[]> {
  const result = {} as Record<K, T[]>;
  for (const item of arr) {
    const key = keyFn(item);
    if (!result[key]) {
      result[key] = [];
    }
    result[key].push(item);
  }
  return result;
}

/**
 * Flatten a nested array by one level.
 * Could use Array.prototype.flat().
 */
export function flatten<T>(arr: T[][]): T[] {
  const result: T[] = [];
  for (const subArray of arr) {
    for (const item of subArray) {
      result.push(item);
    }
  }
  return result;
}

/**
 * Partition an array into two based on a predicate.
 * Returns [matching, nonMatching].
 */
export function partition<T>(arr: T[], predicate: (item: T) => boolean): [T[], T[]] {
  const matching: T[] = [];
  const nonMatching: T[] = [];
  for (const item of arr) {
    if (predicate(item)) {
      matching.push(item);
    } else {
      nonMatching.push(item);
    }
  }
  return [matching, nonMatching];
}

/**
 * Paginate an array.
 * Uses magic number for default page size.
 */
export function paginate<T>(arr: T[], page: number, pageSize: number = DEFAULT_PAGE_SIZE): T[] {
  const start = (page - 1) * pageSize;
  return arr.slice(start, start + pageSize);
}
