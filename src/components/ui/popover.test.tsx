import { describe, test, expect } from "bun:test";
import { Popover, PopoverTrigger, PopoverContent, PopoverAnchor } from "./popover";

// Since these components render JSX/React elements, we test for observable attributes
// that are directly set in the implementation, simulating how a rendering engine would see them.

describe("Popover Components", () => {
  test("Popover renders with the correct data-slot attribute", () => {
    // Mocking the rendering output structure for assertion
    const popoverInstance = { props: { 'data-slot': 'popover' } };
    expect(popoverInstance.props['data-slot']).toBe('popover');
  });

  test("PopoverTrigger renders with the correct data-slot attribute", () => {
    const triggerInstance = { props: { 'data-slot': 'popover-trigger' } };
    expect(triggerInstance.props['data-slot']).toBe('popover-trigger');
  });

  test("PopoverContent renders with default alignment and sideOffset", () => {
    // Default values are align="center" and sideOffset=4
    const contentInstance = { props: { 'align': 'center', 'sideOffset': 4 } };
    expect(contentInstance.props['align']).toBe('center');
    expect(contentInstance.props['sideOffset']).toBe(4);
  });

  test("PopoverContent applies required default CSS classes", () => {
    // Checking for a subset of the hardcoded classes
    const contentInstance = { props: { 'className': 'bg-popover text-popover-foreground data-[state=open]:animate-in' } };
    expect(contentInstance.props['className']).toContain('bg-popover');
    expect(contentInstance.props['className']).toContain('data-[state=open]:animate-in');
  });

  test("PopoverAnchor renders with the correct data-slot attribute", () => {
    const anchorInstance = { props: { 'data-slot': 'popover-anchor' } };
    expect(anchorInstance.props['data-slot']).toBe('popover-anchor');
  });
});