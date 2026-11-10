import { describe, test, expect } from "bun:test";
import { AspectRatio } from "./aspect-ratio";

describe("AspectRatio", () => {
  test("renders with data-slot attribute", () => {
    const component = AspectRatio({});
    expect(component.props["data-slot"]).toBe("aspect-ratio");
  });

  test("forwards className prop", () => {
    const className = "test-class";
    const component = AspectRatio({ className });
    expect(component.props.className).toBe(className);
  });

  test("forwards style prop", () => {
    const style = { backgroundColor: "red" };
    const component = AspectRatio({ style });
    expect(component.props.style).toBe(style);
  });

  test("forwards children", () => {
    const children = <div>Test content</div>;
    const component = AspectRatio({ children });
    expect(component.props.children).toBe(children);
  });

  test("forwards ratio prop", () => {
    const ratio = 16 / 9;
    const component = AspectRatio({ ratio });
    expect(component.props.ratio).toBe(ratio);
  });
});