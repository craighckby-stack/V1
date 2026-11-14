import { describe, test, expect } from "bun:test";
import { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent } from "./card";

// Mocking React components for testing structure/props, as we are testing the component rendering logic, not React itself.
// In a real environment, we'd use a renderer like @testing-library/react. Here, we check for expected props/attributes.
const renderComponent = (Component: (p: Record<string, unknown>) => { props: Record<string, unknown> }, props: Record<string, unknown> = {}) => ({
  props: props,
  // Simulate rendering by returning the component instance/structure for inspection
  instance: Component({ ...props })
});

describe("UI Card Components", () => {
  test("Card renders with default slot and base classes when no className is provided", () => {
    const { instance } = renderComponent(Card);
    // Check for required attributes/classes based on implementation
    expect(instance.props["data-slot"]).toBe("card");
    expect(instance.props["className"]).toContain("bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm");
  });

  test("CardHeader renders with default slot and base classes when no className is provided", () => {
    const { instance } = renderComponent(CardHeader);
    expect(instance.props["data-slot"]).toBe("card-header");
    expect(instance.props["className"]).toContain("@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6");
  });

  test("CardTitle renders with default slot and base classes when no className is provided", () => {
    const { instance } = renderComponent(CardTitle);
    expect(instance.props["data-slot"]).toBe("card-title");
    expect(instance.props["className"]).toContain("leading-none font-semibold");
  });

  test("CardDescription renders with default slot and base classes when no className is provided", () => {
    const { instance } = renderComponent(CardDescription);
    expect(instance.props["data-slot"]).toBe("card-description");
    expect(instance.props["className"]).toContain("text-muted-foreground text-sm");
  });

  test("CardAction renders with default slot and base classes when no className is provided", () => {
    const { instance } = renderComponent(CardAction);
    expect(instance.props["data-slot"]).toBe("card-action");
    expect(instance.props["className"]).toContain("col-start-2 row-span-2 row-start-1 self-start justify-self-end");
  });

  test("CardContent renders with default slot and base classes when no className is provided", () => {
    const { instance } = renderComponent(CardContent);
    expect(instance.props["data-slot"]).toBe("card-content");
    expect(instance.props["className"]).toContain("px-6");
  });

  test("CardFooter renders with default slot and base classes when no className is provided", () => {
    const { instance } = renderComponent(CardFooter);
    expect(instance.props["data-slot"]).toBe("card-footer");
    expect(instance.props["className"]).toContain("flex items-center px-6 [.border-t]:pt-6");
  });
});