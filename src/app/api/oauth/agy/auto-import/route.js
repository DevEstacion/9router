import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

/**
 * Resolve the Antigravity CLI token file path.
 * Default: ~/.gemini/antigravity-cli/antigravity-oauth-token
 * Supports AGY_TOKEN_FILE environment variable override.
 */
function getAgyTokenFilePath() {
  const override = process.env.AGY_TOKEN_FILE;
  if (override && override.trim()) return override.trim();
  return join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

/**
 * GET /api/oauth/agy/auto-import
 * Auto-detect and extract token from local Antigravity CLI installation.
 */
export async function GET() {
  try {
    const tokenPath = getAgyTokenFilePath();

    let content;
    try {
      content = await readFile(tokenPath, "utf-8");
    } catch (err) {
      return NextResponse.json({
        found: false,
        error: `Antigravity CLI token file not found at ${tokenPath}. Please run agy and sign in first.`,
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      return NextResponse.json({
        found: false,
        error: "Antigravity CLI token file contains invalid JSON.",
      });
    }

    // Support nested .token (standard CLI output) or flat structure
    const token = parsed && typeof parsed.token === "object" && parsed.token !== null
      ? parsed.token
      : parsed;

    const accessToken = token?.access_token || null;
    const refreshToken = token?.refresh_token || null;
    const expiresAt = token?.expiry || token?.expires_at || null;

    if (!refreshToken && !accessToken) {
      return NextResponse.json({
        found: false,
        error: "No access_token or refresh_token found in Antigravity CLI token file.",
      });
    }

    return NextResponse.json({
      found: true,
      accessToken,
      refreshToken,
      expiresAt,
      source: tokenPath,
    });
  } catch (error) {
    console.error("Antigravity CLI auto-import error:", error);
    return NextResponse.json(
      { found: false, error: error.message || "Failed to read Antigravity CLI token." },
      { status: 500 }
    );
  }
}
