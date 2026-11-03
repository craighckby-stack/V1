/**
 * Ambient type declarations for bun:test (the bun test runner's import
 * surface).
 *
 * WHY THIS EXISTS: the ratchet's gate 3 runs `tsc --noEmit` over drafted
 * characterization tests, which import `bun:test`. Without these
 * declarations tsc fails every draft with
 *   error TS2307: Cannot find module 'bun:test'
 * — meaning the ratchet's typecheck gate rejected EVERY pin before it ever
 * reached the debate (discovered by the sandbox smoke test, 2026-11-03:
 * the repo had zero test files because the full pin chain was
 * unreachable). Installing @types/bun globally instead would drag in
 * bun's Node-globals and conflict with Next.js's @types/node + @types/react
 * in a Next-first project — so this file declares ONLY the test API, with
 * deliberately loose matcher typing (`expect: any`): the anti-tautology
 * gate and the actual `bun test` run provide the real behavioral checking;
 * tsc's job here is only to catch type errors in the test's own code.
 *
 * Location: src/types/ — picked up by the root tsconfig's wildcard include
 * of every .ts file AND by
 * every sandbox copy (core/sandbox-test.ts copies src/ wholesale, so
 * sandboxed typechecks see the same declarations). Sits OUTSIDE the loop's
 * mutation scopes (pipeline/ + display/) — the loop cannot weaken the
 * types its own tests are checked against.
 */

declare module "bun:test" {
  type TestFn = () => void | Promise<void>;
  interface TestOptions {
    timeout?: number;
    retry?: number;
    repeats?: number;
    only?: boolean;
    skip?: boolean | string;
    todo?: boolean;
  }
  function test(name: string | undefined, fn: TestFn): void;
  function test(name: string | undefined, options: TestOptions, fn: TestFn): void;
  namespace test {
    function skip(name: string | undefined, fn: TestFn): void;
    function skip(name: string | undefined, options: TestOptions, fn: TestFn): void;
    function only(name: string | undefined, fn: TestFn): void;
    function only(name: string | undefined, options: TestOptions, fn: TestFn): void;
    function todo(name: string | undefined): void;
    function fails(name: string | undefined, fn: TestFn): void;
    function fails(name: string | undefined, options: TestOptions, fn: TestFn): void;
  }
  function it(name: string | undefined, fn: TestFn): void;
  function it(name: string | undefined, options: TestOptions, fn: TestFn): void;
  namespace it {
    function skip(name: string | undefined, fn: TestFn): void;
    function only(name: string | undefined, fn: TestFn): void;
    function todo(name: string | undefined): void;
  }
  function describe(name: string | undefined, fn: () => void): void;
  namespace describe {
    function skip(name: string | undefined, fn: () => void): void;
    function only(name: string | undefined, fn: () => void): void;
    function todo(name: string | undefined): void;
  }
  // Deliberately loose: matchers are validated by actually running the
  // test, not by tsc. A precise matcher type would either be huge or
  // wrong; `any` keeps the gate focused on the test's own logic.
  const expect: any;
  function beforeAll(fn: () => void | Promise<void>): void;
  function afterAll(fn: () => void | Promise<void>): void;
  function beforeEach(fn: () => void | Promise<void>): void;
  function afterEach(fn: () => void | Promise<void>): void;
  const mock: any;
  function spyOn(target: object, propertyName: string): any;
}
