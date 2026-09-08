import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock next/server
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

// Mock os
vi.mock("os", () => ({
  default: { homedir: vi.fn(() => "/mock/home") },
  homedir: vi.fn(() => "/mock/home"),
}));

// Mock fs/promises
const mockReadFile = vi.fn();
vi.mock("fs/promises", () => ({
  readFile: (...args) => mockReadFile(...args),
}));

// Mock child_process for keyring lookup tests
const mockExecFileSync = vi.fn();
vi.mock("child_process", () => ({
  execFileSync: (...args) => mockExecFileSync(...args),
}));

describe("GET /api/oauth/agy/auto-import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGY_TOKEN_FILE;
    delete process.env.AGY_DISABLE_KEYRING;
    mockExecFileSync.mockImplementation(() => {
      throw new Error("No keyring entry");
    });
  });

  it("extracts credentials from standard nested .token format", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        token: {
          access_token: "mock-access-token",
          refresh_token: "mock-refresh-token",
          token_type: "Bearer",
          expiry: "2026-09-08T00:00:00.000Z",
        },
      })
    );

    const { GET } = await import("../../src/app/api/oauth/agy/auto-import/route.js");
    const res = await GET();
    const data = await res.json();

    expect(data.found).toBe(true);
    expect(data.accessToken).toBe("mock-access-token");
    expect(data.refreshToken).toBe("mock-refresh-token");
    expect(data.expiresAt).toBe("2026-09-08T00:00:00.000Z");
    expect(mockReadFile).toHaveBeenCalledWith(
      "/mock/home/.gemini/antigravity-cli/antigravity-oauth-token",
      "utf-8"
    );
  });

  it("extracts credentials from flat token format", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        access_token: "flat-access-token",
        refresh_token: "flat-refresh-token",
        expires_at: "2026-10-01T12:00:00.000Z",
      })
    );

    const { GET } = await import("../../src/app/api/oauth/agy/auto-import/route.js");
    const res = await GET();
    const data = await res.json();

    expect(data.found).toBe(true);
    expect(data.accessToken).toBe("flat-access-token");
    expect(data.refreshToken).toBe("flat-refresh-token");
    expect(data.expiresAt).toBe("2026-10-01T12:00:00.000Z");
  });

  it("respects AGY_TOKEN_FILE environment variable override", async () => {
    process.env.AGY_TOKEN_FILE = "/custom/path/to/custom-agy-token";
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        token: {
          access_token: "custom-token",
          refresh_token: "custom-refresh",
        },
      })
    );

    const { GET } = await import("../../src/app/api/oauth/agy/auto-import/route.js");
    const res = await GET();
    const data = await res.json();

    expect(data.found).toBe(true);
    expect(mockReadFile).toHaveBeenCalledWith(
      "/custom/path/to/custom-agy-token",
      "utf-8"
    );
  });

  it("extracts credentials from OS keyring when file does not exist", async () => {
    mockReadFile.mockRejectedValueOnce(new Error("ENOENT: no such file or directory"));
    mockExecFileSync.mockReturnValueOnce(
      JSON.stringify({
        token: {
          access_token: "keyring-access-token",
          refresh_token: "keyring-refresh-token",
          expiry: "2026-09-09T00:00:00.000Z",
        },
        auth_method: "consumer",
      })
    );

    const { GET } = await import("../../src/app/api/oauth/agy/auto-import/route.js");
    const res = await GET();
    const data = await res.json();

    expect(data.found).toBe(true);
    expect(data.accessToken).toBe("keyring-access-token");
    expect(data.refreshToken).toBe("keyring-refresh-token");
    expect(data.expiresAt).toBe("2026-09-09T00:00:00.000Z");
    expect(data.source).toContain("Secret Service");
  });

  it("returns found: false when neither file nor keyring contains credentials", async () => {
    mockReadFile.mockRejectedValueOnce(new Error("ENOENT: no such file or directory"));
    mockExecFileSync.mockImplementation(() => {
      throw new Error("Secret not found");
    });

    const { GET } = await import("../../src/app/api/oauth/agy/auto-import/route.js");
    const res = await GET();
    const data = await res.json();

    expect(data.found).toBe(false);
    expect(data.error).toContain("Antigravity CLI login not found in system keyring");
  });

  it("returns found: false when file JSON is malformed and keyring is empty", async () => {
    mockReadFile.mockResolvedValueOnce("not-json-content");
    mockExecFileSync.mockImplementation(() => {
      throw new Error("Secret not found");
    });

    const { GET } = await import("../../src/app/api/oauth/agy/auto-import/route.js");
    const res = await GET();
    const data = await res.json();

    expect(data.found).toBe(false);
    expect(data.error).toContain("invalid JSON");
  });
});
