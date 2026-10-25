/**
 * Shopping cart module — has obvious refactoring opportunities:
 * - Missing type annotations on parameters
 * - Magic numbers (1.08, 0.9, 0.8, 30000)
 * - Repeated discount logic that could be extracted
 * - A function that could be split into smaller helpers
 */

export interface CartItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
}

// Magic numbers — should be extracted into named constants
export const TAX_RATE = 1.08;
export const DISCOUNT_SAVE10 = 0.9;
export const DISCOUNT_SAVE20 = 0.8;
export const DEFAULT_TIMEOUT_MS = 30000;
export const MAX_ITEMS_PER_CART = 50;

/**
 * Calculate the total price of items in the cart, including tax.
 * Missing type annotation on the return value.
 */
export function calculateTotal(items: CartItem[]): number {
  let total = 0;
  for (const item of items) {
    total += item.price * item.quantity * TAX_RATE;
  }
  return total;
}

/**
 * Apply a discount code to a price.
 * The discount codes are string literals — could be a union type.
 * The if/else chain could be a lookup table.
 */
export function applyDiscount(price: number, code: string): number {
  if (code === "SAVE10") return price * DISCOUNT_SAVE10;
  if (code === "SAVE20") return price * DISCOUNT_SAVE20;
  return price;
}

/**
 * Validate that a cart is not empty and not over the item limit.
 * Missing return type annotation.
 */
export function validateCart(items: CartItem[]): boolean {
  if (items.length === 0) return false;
  if (items.length > MAX_ITEMS_PER_CART) return false;
  return true;
}

/**
 * Format a price for display.
 * The currency symbol and decimal places are magic — should be constants.
 */
export function formatPrice(price: number): string {
  return "$" + price.toFixed(2);
}

/**
 * Get the cheapest item in the cart.
 * Uses a manual loop — could use Math.min with spread.
 * Missing return type for the null case.
 */
export function getCheapestItem(items: CartItem[]): CartItem | null {
  if (items.length === 0) return null;
  let cheapest = items[0];
  for (const item of items) {
    if (item.price < cheapest.price) {
      cheapest = item;
    }
  }
  return cheapest;
}

/**
 * Get the most expensive item in the cart.
 * Same manual loop pattern as getCheapestItem — could be extracted into a
 * shared helper that takes a comparison function.
 */
export function getMostExpensiveItem(items: CartItem[]): CartItem | null {
  if (items.length === 0) return null;
  let expensive = items[0];
  for (const item of items) {
    if (item.price > expensive.price) {
      expensive = item;
    }
  }
  return expensive;
}
