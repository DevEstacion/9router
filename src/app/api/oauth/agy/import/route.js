import { NextResponse } from "next/server";
import { createProviderConnection } from "../../../../../models/index.js";
import { AGY_CONFIG, getOAuthClientMetadata } from "../../../../../lib/oauth/constants/oauth.js";

/**
 * POST /api/oauth/agy/import
 * Import Antigravity CLI credentials (access token / refresh token / token JSON).
 */
export async function POST(request) {
  try {
    const body = await request.json();

    let accessToken = body.accessToken?.trim() || null;
    let refreshToken = body.refreshToken?.trim() || null;
    let expiresAt = body.expiresAt || null;
    let email = body.email?.trim() || null;
    const name = body.name?.trim() || null;

    // Handle raw JSON string if passed in
    if (body.rawJson) {
      try {
        const raw = typeof body.rawJson === "string" ? JSON.parse(body.rawJson) : body.rawJson;
        const token = raw && typeof raw.token === "object" && raw.token !== null ? raw.token : raw;
        if (token.access_token) accessToken = token.access_token.trim();
        if (token.refresh_token) refreshToken = token.refresh_token.trim();
        if (token.expiry || token.expires_at) expiresAt = token.expiry || token.expires_at;
      } catch (err) {
        return NextResponse.json(
          { error: "Invalid JSON format in raw token input" },
          { status: 400 }
        );
      }
    }

    if (!accessToken && !refreshToken) {
      return NextResponse.json(
        { error: "Either access_token or refresh_token is required" },
        { status: 400 }
      );
    }

    // If no access token but refresh token exists, refresh to get fresh access token
    if (!accessToken && refreshToken) {
      try {
        const tokenRes = await fetch(AGY_CONFIG.tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: AGY_CONFIG.clientId,
            client_secret: AGY_CONFIG.clientSecret,
          }),
        });
        if (tokenRes.ok) {
          const data = await tokenRes.json();
          accessToken = data.access_token;
          if (data.expires_in) {
            expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
          }
        }
      } catch (e) {
        console.error("Failed to refresh token during agy import:", e);
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
        const metadata = getOAuthClientMetadata();

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
