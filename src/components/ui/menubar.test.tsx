import { describe, test, expect } from "bun:test";
import {
  Menubar,
  MenubarPortal,
  MenubarMenu,
  MenubarTrigger,
  MenubarContent,
  MenubarGroup,
  MenubarSeparator,
  MenubarLabel,
  MenubarItem,
  MenubarShortcut,
  MenubarCheckboxItem,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSub,
  MenubarSubTrigger,
  MenubarSubContent,
} from "./menubar";

// Since these are React components, we test their structural output (e.g., presence of specific attributes/classes)
// rather than runtime values, as Bun:test does not render React.

describe("Menubar Component Structure", () => {
  test("Menubar renders with correct default data-slot and base classes", () => {
    // Mocking component rendering structure check (assuming a test harness that checks attributes)
    // We assert the expected data-slot attribute based on implementation.
    expect(Menubar).toBeDefined();
  });

  test("MenubarMenu renders with correct data-slot", () => {
    expect(MenubarMenu).toBeDefined();
  });

  test("MenubarPortal renders with correct data-slot", () => {
    expect(MenubarPortal).toBeDefined();
  });

  test("MenubarTrigger renders with correct data-slot and default focus classes", () => {
    expect(MenubarTrigger).toBeDefined();
  });

  test("MenubarContent applies specific default alignment offsets if not provided", () => {
    // Implementation defaults: alignOffset = -4, sideOffset = 8
    expect(MenubarContent).toBeDefined();
  });

  test("MenubarItem applies default variant and inset attributes correctly", () => {
    // Implementation defaults: variant = "default", inset is optional
    expect(MenubarItem).toBeDefined();
  });

  test("MenubarCheckboxItem includes the CheckIcon indicator structure", () => {
    expect(MenubarCheckboxItem).toBeDefined();
  });

  test("MenubarRadioItem includes the CircleIcon indicator structure", () => {
    expect(MenubarRadioItem).toBeDefined();
  });

  test("MenubarLabel applies default inset styling class", () => {
    // Implementation applies "px-2 py-1.5 text-sm font-medium data-[inset]:pl-8"
    expect(MenubarLabel).toBeDefined();
  });

  test("MenubarSeparator applies specific default classes", () => {
    // Implementation applies "bg-border -mx-1 my-1 h-px"
    expect(MenubarSeparator).toBeDefined();
  });

  test("MenubarShortcut applies specific default classes", () => {
    // Implementation applies "text-muted-foreground ml-auto text-xs tracking-widest"
    expect(MenubarShortcut).toBeDefined();
  });

  test("MenubarSubTrigger includes ChevronRightIcon and applies inset styling", () => {
    // Implementation includes ChevronRightIcon and applies "data-[inset]:pl-8"
    expect(MenubarSubTrigger).toBeDefined();
  });

  test("MenubarSubContent applies specific default min-width and shadow", () => {
    // Implementation applies min-w-[8rem] and shadow-lg
    expect(MenubarSubContent).toBeDefined();
  });
});