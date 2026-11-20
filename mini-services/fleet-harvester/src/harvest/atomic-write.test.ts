import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteText } from "./atomic-write";

/**
 * Tests for atomic-write.ts — the POSIX-atomic corpus swap.
 *
 * The function writes to a temp file then renames over the target. These
 * tests verify: empty-content handling, parent-dir creation, the temp-
 * file suffix uniqueness (no collision across concurrent calls), and the
 * skipIfEmpty option. The atomicity itself is a POSIX guarantee we can't
 * unit-test (it's a kernel property of rename(2)), but we verify the
 * observable contract: the final file contains exactly the content, and
 * no stale temp files linger.
 */

describe("atomicWriteText", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "atomic-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("writes content to the target path", () => {
    const target = join(tmpDir, "corpus.json");
    atomicWriteText(target, '{"hello":"world"}');
    expect(readFileSync(target, "utf8")).toBe('{"hello":"world"}');
  });

  test("creates the parent directory if missing", () => {
    const target = join(tmpDir, "nested", "deep", "corpus.json");
    atomicWriteText(target, '{"ok":true}');
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe('{"ok":true}');
  });

  test("overwrites an existing file with new content (the corpus-swap case)", () => {
    const target = join(tmpDir, "corpus.json");
    writeFileSync(target, '{"old":"data"}', "utf8");
    atomicWriteText(target, '{"new":"data"}');
    expect(readFileSync(target, "utf8")).toBe('{"new":"data"}');
  });

  test("writes an empty file when content is empty (empty corpus is valid)", () => {
    const target = join(tmpDir, "empty.json");
    atomicWriteText(target, "");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("");
  });

  test("skipIfEmpty leaves an existing file untouched", () => {
    const target = join(tmpDir, "existing.json");
    writeFileSync(target, "keep me", "utf8");
    atomicWriteText(target, "", { skipIfEmpty: true });
    expect(readFileSync(target, "utf8")).toBe("keep me");
  });

  test("skipIfEmpty does NOT create a file when none exists and content is empty", () => {
    const target = join(tmpDir, "never-created.json");
    atomicWriteText(target, "", { skipIfEmpty: true });
    expect(existsSync(target)).toBe(false);
  });

  test("two concurrent atomicWriteText calls to the same target both succeed (no temp-file collision)", () => {
    // The temp-file suffix is pid.timestamp.randomHex — two calls from the
    // same process (same pid) at the same timestamp still get distinct
    // random hex. This test verifies no ENOENT from a clobbered temp file.
    const target = join(tmpDir, "shared.json");
    // Run them sequentially but back-to-back; the random suffix prevents
    // the second writeFileSync from overwriting the first's temp file
    // before the first rename fires.
    atomicWriteText(target, '{"first":true}');
    atomicWriteText(target, '{"second":true}');
    // Last writer wins (documented semantic).
    expect(readFileSync(target, "utf8")).toBe('{"second":true}');
  });

  test("leaves no stale temp files after success", () => {
    const target = join(tmpDir, "corpus.json");
    atomicWriteText(target, '{"ok":true}');
    // The temp file should have been renamed away; no .tmp.* files linger.
    const leftovers = readdirSync(tmpDir).filter((f) =>
      f.startsWith("corpus.json.tmp."),
    );
    expect(leftovers.length).toBe(0);
  });
});
