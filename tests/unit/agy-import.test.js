import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

// Mock createProviderConnection
const mockCreateConnection = vi.fn();
vi.mock("@/models", () => ({
  createProviderConnection: (...args) => mockCreateConnection(...args),
}));
vi.mock("../../src/models/index.js", () => ({
  createProviderConnection: (...args) => mockCreateConnection(...args),
}));

const originalFetch = global.fetch;

describe("POST /api/oauth/agy/import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("successfully imports tokens and persists connection", async () => {
    // Mock userinfo & codeassist endpoints
    global.fetch.mockImplementation(async (url) => {
      if (typeof url === "string" && url.includes("userinfo")) {
        return {
          ok: true,
          json: async () => ({ email: "test-dev@gmail.com" }),
        };
      }
      if (typeof url === "string" && url.includes("loadCodeAssist")) {
        return {
          ok: true,
          json: async () => ({
            cloudaicompanionProject: { id: "test-project-123" },
            allowedTiers: [{ id: "pro-tier", isDefault: true }],
          }),
        };
      }
      return { ok: false, status: 404 };
    });

    mockCreateConnection.mockResolvedValueOnce({
      id: "conn-agy-1",
      provider: "agy",
      email: "test-dev@gmail.com",
      name: "My CLI",
    });

    const { POST } = await import("../../src/app/api/oauth/agy/import/route.js");

    const req = {
      json: async () => ({
        accessToken: "ya29.test-access-token",
        refreshToken: "1//test-refresh-token",
        name: "My CLI",
      }),
    };

    const res = await POST(req);
    const data = await res.json();

    expect(data.success).toBe(true);
    expect(data.connection.id).toBe("conn-agy-1");
    expect(data.connection.provider).toBe("agy");
    expect(data.connection.email).toBe("test-dev@gmail.com");

    expect(mockCreateConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "agy",
        authType: "oauth",
        accessToken: "ya29.test-access-token",
        refreshToken: "1//test-refresh-token",
        email: "test-dev@gmail.com",
        projectId: "test-project-123",
        providerSpecificData: expect.objectContaining({
          tierId: "pro-tier",
          source: "cli-import",
        }),
      })
    );
  });

  it("handles raw JSON token string input", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ email: "raw@gmail.com" }),
    });

    mockCreateConnection.mockResolvedValueOnce({
      id: "conn-agy-2",
      provider: "agy",
      email: "raw@gmail.com",
    });

    const { POST } = await import("../../src/app/api/oauth/agy/import/route.js");

    const rawJson = JSON.stringify({
      token: {
        access_token: "token-from-raw",
        refresh_token: "refresh-from-raw",
      },
    });

    const req = {
      json: async () => ({ rawJson }),
    };

    const res = await POST(req);
    const data = await res.json();

    expect(data.success).toBe(true);
    expect(mockCreateConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "agy",
        accessToken: "token-from-raw",
        refreshToken: "refresh-from-raw",
      })
    );
  });

  it.each([
    ["non-OK response", async () => ({ ok: false, status: 401 }), 400, "(401)"],
    ["network failure", async () => { throw new Error("offline"); }, 502, "Failed to refresh"],
    ["invalid JSON", async () => ({ ok: true, json: async () => { throw new Error("invalid JSON"); } }), 502, "invalid JSON"],
    ["missing access token", async () => ({ ok: true, json: async () => ({ expires_in: 3600 }) }), 502, "missing access_token"],
    ["invalid expiry", async () => ({ ok: true, json: async () => ({ access_token: "fresh", expires_in: "bad" }) }), 502, "invalid expires_in"],
  ])("rejects refresh-only import on %s without creating a connection", async (_case, refreshResult, status, errorText) => {
    global.fetch.mockImplementationOnce(refreshResult);
    const { POST } = await import("../../src/app/api/oauth/agy/import/route.js");

    const res = await POST({ json: async () => ({ refreshToken: "refresh-only" }) });
    const data = await res.json();

    expect(res.status).toBe(status);
    expect(data.error).toContain(errorText);
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  it("refreshes a refresh-only import before creating an active connection", async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "fresh-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ email: "refreshed@gmail.com" }),
      })
      .mockResolvedValue({ ok: false, status: 404 });
    mockCreateConnection.mockResolvedValueOnce({ id: "conn-refresh", provider: "agy" });
    const { POST } = await import("../../src/app/api/oauth/agy/import/route.js");

    const res = await POST({ json: async () => ({ refreshToken: "refresh-only" }) });

    expect(res.status).toBe(200);
    expect(mockCreateConnection).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: "fresh-access",
      refreshToken: "rotated-refresh",
      email: "refreshed@gmail.com",
      expiresAt: expect.any(String),
      testStatus: "active",
    }));
  });

  it.each([
    [{ token: { access_token: { value: "bad" } } }, "access_token must be a string"],
    [{ token: { refresh_token: ["bad"] } }, "refresh_token must be a string"],
    [{ token: { access_token: "token", expiry: "not-a-date" } }, "expiry must be a valid date"],
    [{ token: "bad" }, "token field must be a JSON object"],
  ])("rejects invalid nested raw token data %#", async (rawJson, expectedError) => {
    const { POST } = await import("../../src/app/api/oauth/agy/import/route.js");

    const res = await POST({ json: async () => ({ rawJson }) });
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toContain(expectedError);
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  it("rejects access-only import when token validation fails", async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 401 });
    const { POST } = await import("../../src/app/api/oauth/agy/import/route.js");

    const res = await POST({ json: async () => ({ accessToken: "stale-access" }) });
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toContain("validation failed");
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  it("rejects request when neither access token nor refresh token is provided", async () => {
    const { POST } = await import("../../src/app/api/oauth/agy/import/route.js");

    const req = {
      json: async () => ({}),
    };

    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toContain("required");
  });
});
