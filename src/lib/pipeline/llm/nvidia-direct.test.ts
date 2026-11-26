import { describe, test, expect } from "bun:test";
import {
  nvidiaModelBreakers,
  nvidiaHealthSnapshot,
  getNvidiaConfig,
  getNvidiaConfigPublic,
  nvidiaComplete,
  verifyNvidiaKey,
  type NvidiaCallResult,
} from "./nvidia-direct";

describe("NvidiaCallResult Interface Contract", () => {
  // Since NvidiaCallResult is a type-only interface, we cannot test its runtime behavior directly.
  // We test that the structure we expect is consistent with the contract by asserting on a representative object
  // that conforms to the interface structure, ensuring all required fields are present and correctly typed.

  test("must have required boolean 'ok' field", () => {
    const _result: NvidiaCallResult = {
      ok: true,
      content: "some content",
      latencyMs: 10,
      model: "gpt-4",
    };
    expect(_result.ok).toBe(true);
  });

  test("must have required string 'content' field", () => {
    const _result: NvidiaCallResult = {
      ok: false,
      content: "", // Content might be empty even on failure, but it must exist
      latencyMs: 5,
      model: "gpt-4",
    };
    expect(_result.content).toBe("");
  });

  test("must have required number 'latencyMs' field", () => {
    const _result: NvidiaCallResult = {
      ok: true,
      content: "ok",
      latencyMs: 123,
      model: "gpt-4",
    };
    expect(_result.latencyMs).toBe(123);
  });

  test("must have required string 'model' field", () => {
    const _result: NvidiaCallResult = {
      ok: false,
      content: "error",
      latencyMs: 100,
      model: "llama-2",
    };
    expect(_result.model).toBe("llama-2");
  });

  test("must correctly handle optional 'error' string field when ok is false", () => {
    const _result: NvidiaCallResult = {
      ok: false,
      content: "error payload",
      latencyMs: 50,
      model: "gpt-4",
      error: "Authentication failed",
    };
    expect(_result.error).toBe("Authentication failed");
  });

  test("must correctly handle optional 'errorKind' field when ok is false", () => {
    const _result: NvidiaCallResult = {
      ok: false,
      content: "error payload",
      latencyMs: 50,
      model: "gpt-4",
      errorKind: "auth",
    };
    expect(_result.errorKind).toBe("auth");
  });

  test("must correctly handle optional 'retries' field", () => {
    const _result: NvidiaCallResult = {
      ok: false,
      content: "error payload",
      latencyMs: 50,
      model: "gpt-4",
      retries: 3,
    };
    expect(_result.retries).toBe(3);
  });
});