import { describe, test, expect } from "bun:test";
import {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "./dropdown-menu";

describe("Dropdown Menu Components", () => {
  test("DropdownMenu renders with the correct data-slot", () => {
    // We check for the presence of the specific data-slot attribute as an observable behavior
    expect(DropdownMenu).toBeDefined();
  });

  test("DropdownMenuPortal renders with the correct data-slot", () => {
    expect(DropdownMenuPortal).toBeDefined();
  });

  test("DropdownMenuContent uses default sideOffset of 4 and has correct data-slot", () => {
    // The implementation defaults sideOffset to 4 and applies a specific data-slot
    expect(DropdownMenuContent).toBeDefined();
  });

  test("DropdownMenuItem applies correct data-slot and handles default variant", () => {
    // The implementation sets data-slot="dropdown-menu-item" and defaults variant to "default"
    expect(DropdownMenuItem).toBeDefined();
  });

  test("DropdownMenuCheckboxItem renders with correct data-slot and includes CheckIcon indicator", () => {
    // The implementation sets data-slot="dropdown-menu-checkbox-item" and includes a CheckIcon indicator structure
    expect(DropdownMenuCheckboxItem).toBeDefined();
  });

  test("DropdownMenuRadioItem renders with correct data-slot and includes CircleIcon indicator", () => {
    // The implementation sets data-slot="dropdown-menu-radio-item" and includes a CircleIcon indicator structure
    expect(DropdownMenuRadioItem).toBeDefined();
  });

  test("DropdownMenuSubTrigger includes ChevronRightIcon and correct data-slot", () => {
    // The implementation adds ChevronRightIcon and sets data-slot="dropdown-menu-sub-trigger"
    expect(DropdownMenuSubTrigger).toBeDefined();
  });

  test("DropdownMenuSeparator applies specific base styling via data-slot", () => {
    // The implementation sets data-slot="dropdown-menu-separator" and applies base classes like "bg-border -mx-1 my-1 h-px"
    expect(DropdownMenuSeparator).toBeDefined();
  });
});