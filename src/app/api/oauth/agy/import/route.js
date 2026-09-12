import { NextResponse } from "next/server";
import { createProviderConnection } from "../../../../../models/index.js";
import { AGY_CONFIG } from "../../../../../lib/oauth/constants/oauth.js";

/**
 * POST /api/oauth/agy/import
 * Import Antigravity CLI credentials (access token / refresh token / token JSON).
 */
export async function POST(request) {
  try {
    const body = await request.json();

    let accessToken = typeof body.accessToken === "string" ? body.accessToken.trim() || null : null;
    let refreshToken = typeof body.refreshToken === "string" ? body.refreshToken.trim() || null : null;
    let expiresAt = body.expiresAt ?? null;
    let email = typeof body.email === "string" ? body.email.trim() || null : null;
    const name = typeof body.name === "string" ? body.name.trim() || null : null;

    // Handle raw JSON string if passed in
    if (body.rawJson) {
      let raw;
      try {
        raw = typeof body.rawJson === "string" ? JSON.parse(body.rawJson) : body.rawJson;
      } catch {
        return NextResponse.json(
          { error: "Invalid JSON format in raw token input" },
          { status: 400 }
        );
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return NextResponse.json({ error: "Raw token input must be a JSON object" }, { status: 400 });
      }
      if (raw.token !== undefined && (!raw.token || typeof raw.token !== "object" || Array.isArray(raw.token))) {
        return NextResponse.json({ error: "Raw token token field must be a JSON object" }, { status: 400 });
      }
      const token = raw.token || raw;
      for (const field of ["access_token", "refresh_token"]) {
        if (token[field] !== undefined && token[field] !== null && typeof token[field] !== "string") {
          return NextResponse.json({ error: `${field} must be a string` }, { status: 400 });
        }
      }
      if (token.access_token !== undefined) accessToken = token.access_token?.trim() || null;
      if (token.refresh_token !== undefined) refreshToken = token.refresh_token?.trim() || null;
      if (token.expiry !== undefined || token.expires_at !== undefined) {
        expiresAt = token.expiry ?? token.expires_at;
      }
    }

    if (expiresAt !== null && expiresAt !== undefined) {
      if (typeof expiresAt !== "string" && typeof expiresAt !== "number") {
        return NextResponse.json({ error: "Token expiry must be a valid date" }, { status: 400 });
      }
      const expiryDate = typeof expiresAt === "number"
        ? new Date(expiresAt < 1e12 ? expiresAt * 1000 : expiresAt)
        : new Date(expiresAt);
      if (!Number.isFinite(expiryDate.getTime())) {
        return NextResponse.json({ error: "Token expiry must be a valid date" }, { status: 400 });
      }
      expiresAt = typeof expiresAt === "string" ? expiresAt : expiryDate.toISOString();
    }

    if (!accessToken && !refreshToken) {
      return NextResponse.json(
        { error: "Either access_token or refresh_token is required" },
        { status: 400 }
      );
    }

    // If no access token but refresh token exists, refresh to get fresh access token
    if (!accessToken && refreshToken) {
      let tokenRes;
      try {
        tokenRes = await fetch(AGY_CONFIG.tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: AGY_CONFIG.clientId,
            client_secret: AGY_CONFIG.clientSecret,
          }),
        });
      } catch (error) {
        console.error("Failed to refresh token during agy import:", error);
        return NextResponse.json({ error: "Failed to refresh Antigravity CLI token" }, { status: 502 });
      }

      if (!tokenRes.ok) {
        return NextResponse.json({ error: `Failed to refresh Antigravity CLI token (${tokenRes.status})` }, { status: 400 });
      }

      let data;
      try {
        data = await tokenRes.json();
      } catch {
        return NextResponse.json({ error: "Token refresh returned invalid JSON" }, { status: 502 });
      }
      if (!data || typeof data.access_token !== "string" || !data.access_token.trim()) {
        return NextResponse.json({ error: "Token refresh response missing access_token" }, { status: 502 });
      }
      if (data.expires_in !== undefined && (!Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0)) {
        return NextResponse.json({ error: "Token refresh response has invalid expires_in" }, { status: 502 });
      }

      accessToken = data.access_token.trim();
      if (typeof data.refresh_token === "string" && data.refresh_token.trim()) {
        refreshToken = data.refresh_token.trim();
      }
      if (data.expires_in !== undefined) {
        expiresAt = new Date(Date.now() + Number(data.expires_in) * 1000).toISOString();
      }
    }

    let projectId = "";
    let tierId = "legacy-tier";

    // If access token is available, enrich with user info and code assist metadata
    if (accessToken) {
      // 1. Fetch user email if not supplied
      if (!email) {
        try {
          const userRes = await fetch(`${AGY_CONFIG.userInfoUrl}?alt=json`, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "x-request-source": "local",
            },
          });
          if (userRes.ok) {
            const userData = await userRes.json();
            email = userData.email || null;
          }
        } catch (e) {
          console.error("Failed to fetch user info during agy import:", e);
        }
      }

      // 2. Fetch Code Assist project ID and tier
      try {
        const loadHeaders = {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": AGY_CONFIG.loadCodeAssistUserAgent,
          "x-request-source": "local",
        };
        const loadRes = await fetch(AGY_CONFIG.loadCodeAssistEndpoint, {
          method: "POST",
          headers: loadHeaders,
          body: AGY_CONFIG.loadCodeAssistClientMetadata,
        });

        if (loadRes.ok) {
          const data = await loadRes.json();
          projectId = data.cloudaicompanionProject?.id || data.cloudaicompanionProject || "";
          if (Array.isArray(data.allowedTiers)) {
            for (const tier of data.allowedTiers) {
              if (tier.isDefault && tier.id) {
                tierId = tier.id.trim();
                break;
              }
            }
          }
        }
      } catch (e) {
        console.error("Failed to fetch code assist info during agy import:", e);
      }
    }

    const connection = await createProviderConnection({
      provider: "agy",
      authType: "oauth",
      name: name || undefined,
      accessToken: accessToken || undefined,
      refreshToken: refreshToken || undefined,
      expiresAt: expiresAt || new Date(Date.now() + 3600 * 1000).toISOString(),
      email: email || undefined,
      projectId: projectId || undefined,
      providerSpecificData: {
        tierId,
        source: "cli-import",
      },
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
        name: connection.name,
      },
    });
  } catch (error) {
    console.error("Error importing Antigravity CLI token:", error);
    return NextResponse.json(
      { error: error.message || "Failed to import Antigravity CLI token" },
      { status: 500 }
    );
  }
}
