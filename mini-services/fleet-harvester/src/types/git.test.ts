import { describe, test, expect } from "bun:test";
import type {
  GitHubUser,
  RepoSummary,
  RawCommit,
  ClassifiedCommit,
  ExtractionSettings,
  DestinationSettings,
  LogBucket,
  CiState,
} from "./git";

describe("Git Types Contracts", () => {
  // Test structure for GitHubUser
  test("GitHubUser interface must define login string and optional fields", () => {
    const user: GitHubUser = { login: "testuser" };
    expect(user.login).toBe("testuser");
    expect(user.name).toBeUndefined(); // Testing optionality based on definition
  });

  // Test structure for RepoSummary
  test("RepoSummary interface must define full_name, name, owner, and private status", () => {
    const summary: RepoSummary = {
      full_name: "owner/repo",
      name: "repo",
      owner: "owner",
      private: true,
      fork: false,
      default_branch: "main",
    };
    expect(summary.full_name).toBe("owner/repo");
    expect(summary.private).toBe(true);
  });

  // Test structure for RawCommit
  test("RawCommit interface must define required fields like sha, repo, and message", () => {
    const commit: RawCommit = {
      sha: "a1b2c3d4",
      repo: "owner/repo",
      isPrivate: false,
      branches: ["main"],
      message: "Initial commit",
      authorName: "Test Author",
      date: "2023-01-01T00:00:00Z",
    };
    expect(commit.sha).toBe("a1b2c3d4");
    expect(commit.branches).toEqual(["main"]);
  });

  // Test structure for ClassifiedCommit (composition)
  test("ClassifiedCommit must extend RawCommit and include classification details", () => {
    const commit: ClassifiedCommit = {
      sha: "a1b2c3d4",
      repo: "owner/repo",
      isPrivate: false,
      branches: ["main"],
      message: "Test",
      authorName: "A",
      date: "2023-01-01T00:00:00Z",
      classification: "successful",
      confidence: "high",
      source: "heuristic",
      reason: "Good commit",
      footprint: "10kb",
    };
    expect(commit.classification).toBe("successful");
    expect(commit.reason).toBe("Good commit");
  });

  // Test structure for ExtractionSettings (using BranchScope type)
  test("ExtractionSettings must correctly use BranchScope type 'default'", () => {
    const settings: ExtractionSettings = {
      authorFilter: "user",
      sources: "github",
      extAuthor: "ext",
      repoFilter: "repo",
      sinceDate: "2023-01-01",
      untilDate: "2023-12-31",
      branchScope: "default", // Pinning 'default' value
      siphonEngines: true,
      includePrivate: false,
      includeForks: false,
      skipOwn: true,
      includeEmails: false,
      includeMine: false,
      ciLookup: true,
      failRx: "fail",
      okRx: "ok",
      aiStrategy: "consensus",
      useGemini: true,
      useGeminiBackup: false,
      useLlm: true,
      nvKey: "key",
      nvModel: "model",
      nvEndpoint: "endpoint",
      nvPrivate: false,
    };
    expect(settings.branchScope).toBe("default");
    expect(settings.aiStrategy).toBe("consensus");
  });

  // Test structure for DestinationSettings (using ArchiveFormat type)
  test("DestinationSettings must correctly use ArchiveFormat type 'json'", () => {
    const settings: DestinationSettings = {
      targetRepo: "target/repo",
      targetBranch: "main",
      targetPath: "data/",
      fileFormat: "json", // Pinning 'json' value
      autoCreateRepo: true,
    };
    expect(settings.fileFormat).toBe("json");
    expect(settings.autoCreateRepo).toBe(true);
  });

  // Test structure for LogBucket (using ClassificationOutcome type)
  test("LogBucket type must resolve to 'successful' or 'engines'", () => {
    const logBucket: LogBucket = "engines"; // Pinning 'engines' value
    expect(logBucket).toBe("engines");
  });

  // Test structure for CiState
  test("CiState must correctly represent 'pending' state", () => {
    const state: CiState = "pending";
    expect(state).toBe("pending");
  });
});