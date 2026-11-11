import { describe, test, expect } from "bun:test";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "./collapsible";

// Since these components render React elements, we test their structure/props,
// not their runtime React behavior (which requires a renderer).
// We assert the static attributes added by the wrapper components.

describe("Collapsible Component Wrappers", () => {
  test("Collapsible renders a Root component with the correct data-slot", () => {
    // Mocking the rendering output structure for assertion based on implementation
    const rendered = Collapsible({});
    // Asserting the specific attribute added by the wrapper
    expect(rendered.props.children).toBeUndefined(); // Assuming no children passed in this minimal test
    expect(rendered.props["data-slot"]).toBe("collapsible");
  });

  test("CollapsibleTrigger renders a CollapsibleTrigger component with the correct data-slot", () => {
    const rendered = CollapsibleTrigger({});
    // Asserting the specific attribute added by the wrapper
    expect(rendered.props["data-slot"]).toBe("collapsible-trigger");
  });

  test("CollapsibleContent renders a CollapsibleContent component with the correct data-slot", () => {
    const rendered = CollapsibleContent({});
    // Asserting the specific attribute added by the wrapper
    expect(rendered.props["data-slot"]).toBe("collapsible-content");
  });

  test("Components correctly pass through arbitrary props to underlying primitives", () => {
    const customProps = { className: "test-class", disabled: true };
    const renderedTrigger = CollapsibleTrigger(customProps);
    // Asserting that custom props are merged onto the underlying primitive
    expect(renderedTrigger.props.className).toBe("test-class");
    expect(renderedTrigger.props.disabled).toBe(true);
  });
});