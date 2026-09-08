import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";

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
 * Attempt to extract Antigravity token from the OS keyring (service="gemini", account="antigravity").
 * This is where official `agy` stores tokens on Linux (Secret Service / libsecret), macOS (Keychain),
 * and Windows (Credential Manager).
 */
export function extractFromKeyring() {
  if (process.env.AGY_DISABLE_KEYRING === "1") return null;
  const platform = process.platform;

  if (platform === "darwin") {
    try {
      const out = execFileSync("/usr/bin/security", [
        "find-generic-password",
        "-s", "gemini",
        "-a", "antigravity",
        "-w"
      ], { encoding: "utf-8", timeout: 3000 }).trim();
      if (out) return { raw: out, source: "macOS Keychain" };
    } catch {}
  } else if (platform === "linux") {
    // 1. Try secret-tool CLI if installed
    try {
      const out = execFileSync("secret-tool", [
        "lookup",
        "service", "gemini",
        "username", "antigravity"
      ], { encoding: "utf-8", timeout: 3000 }).trim();
      if (out) return { raw: out, source: "Secret Service (secret-tool)" };
    } catch {}

    // 2. Try libsecret via python3 ctypes (standard on Pop!_OS / Ubuntu / GNOME / Linux desktops)
    try {
      const pyCode = `
import ctypes
try:
    lib = ctypes.CDLL("libsecret-1.so.0")
    class SecretSchemaAttribute(ctypes.Structure):
        _fields_ = [("name", ctypes.c_char_p), ("type", ctypes.c_int)]
    class SecretSchema(ctypes.Structure):
        _fields_ = [("name", ctypes.c_char_p), ("flags", ctypes.c_int), ("attributes", SecretSchemaAttribute * 32)]

    schema = SecretSchema()
    schema.name = b"org.freedesktop.Secret.Generic"
    schema.flags = 0
    schema.attributes[0].name = b"service"
    schema.attributes[0].type = 0
    schema.attributes[1].name = b"username"
    schema.attributes[1].type = 0

    lib.secret_password_lookup_sync.restype = ctypes.c_char_p
    lib.secret_password_lookup_sync.argtypes = [
        ctypes.POINTER(SecretSchema),
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.c_char_p, ctypes.c_char_p,
        ctypes.c_char_p, ctypes.c_char_p,
        ctypes.c_void_p
    ]

    err = ctypes.c_void_p()
    pwd = lib.secret_password_lookup_sync(
        ctypes.byref(schema),
        None,
        ctypes.byref(err),
        b"service", b"gemini",
        b"username", b"antigravity",
        None
    )
    if pwd:
        print(pwd.decode("utf-8"))
except Exception:
    pass
`;
      const out = execFileSync("python3", ["-c", pyCode], { encoding: "utf-8", timeout: 3000 }).trim();
      if (out) return { raw: out, source: "Secret Service (libsecret)" };
    } catch {}
  }

  return null;
}

/**
 * Parse raw token JSON string and extract access/refresh tokens.
 */
function parseTokenData(rawContent, source) {
  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return { error: "Antigravity CLI token contains invalid JSON." };
  }

  const token = parsed && typeof parsed.token === "object" && parsed.token !== null
    ? parsed.token
    : parsed;

  const accessToken = token?.access_token || null;
  const refreshToken = token?.refresh_token || null;
  const expiresAt = token?.expiry || token?.expires_at || null;

  if (!refreshToken && !accessToken) {
    return { error: "No access_token or refresh_token found in Antigravity CLI token." };
  }

  return {
    found: true,
    accessToken,
    refreshToken,
    expiresAt,
    source,
  };
}

/**
 * GET /api/oauth/agy/auto-import
 * Auto-detect and extract token from local Antigravity CLI installation.
 * Probes:
 * 1. AGY_TOKEN_FILE environment override or ~/.gemini/antigravity-cli/antigravity-oauth-token
 * 2. OS Keyring (service="gemini", username="antigravity" via Secret Service / macOS Keychain)
 */
export async function GET() {
  try {
    const tokenPath = getAgyTokenFilePath();

    // 1. Check file storage first (explicit override or file fallback)
    try {
      const content = await readFile(tokenPath, "utf-8");
      const parsed = parseTokenData(content, tokenPath);
      if (parsed.found) {
        return NextResponse.json(parsed);
      }
      if (parsed.error) {
        return NextResponse.json({ found: false, error: parsed.error });
      }
    } catch (err) {
      // File does not exist; proceed to keyring lookup
    }

    // 2. Check OS Keyring (where official agy stores credentials by default)
    try {
      const keyringData = extractFromKeyring();
      if (keyringData && keyringData.raw) {
        const parsed = parseTokenData(keyringData.raw, keyringData.source);
        if (parsed.found) {
          return NextResponse.json(parsed);
        }
      }
    } catch (keyringErr) {
      console.warn("Failed to check keyring for agy token:", keyringErr);
    }

    // 3. Neither file nor keyring found credentials
    return NextResponse.json({
      found: false,
      error: `Antigravity CLI login not found in system keyring or at ${tokenPath}. Please run agy and sign in first, or use the "Paste Token" or "Browser OAuth" tab.`,
    });
  } catch (error) {
    console.error("Antigravity CLI auto-import error:", error);
    return NextResponse.json(
      { found: false, error: error.message || "Failed to read Antigravity CLI token." },
      { status: 500 }
    );
  }
}
