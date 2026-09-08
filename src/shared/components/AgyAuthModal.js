"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Modal, Button, Input, OAuthModal } from "@/shared/components";

/**
 * Antigravity CLI Auth Modal
 * Supports:
 * 1. Auto-detect from local Antigravity CLI (~/.gemini/antigravity-cli/antigravity-oauth-token)
 * 2. Manual paste / file import of token JSON or refresh token
 * 3. Browser OAuth sign-in with Google
 */
export default function AgyAuthModal({ isOpen, providerInfo, onSuccess, onClose }) {
  const [authMode, setAuthMode] = useState("auto"); // "auto" | "paste" | "oauth"
  const [autoDetecting, setAutoDetecting] = useState(false);
  const [autoDetected, setAutoDetected] = useState(false);
  const [autoDetectError, setAutoDetectError] = useState(null);
  const [detectedToken, setDetectedToken] = useState(null);

  const [rawJson, setRawJson] = useState("");
  const [customName, setCustomName] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState(null);

  const runAutoDetect = async () => {
    setAutoDetecting(true);
    setAutoDetectError(null);
    setAutoDetected(false);
    setDetectedToken(null);

    try {
      const res = await fetch("/api/oauth/agy/auto-import");
      const data = await res.json();

      if (data.found) {
        setDetectedToken(data);
        setAutoDetected(true);
      } else {
        setAutoDetectError(data.error || "Could not auto-detect Antigravity CLI login.");
      }
    } catch (err) {
      setAutoDetectError("Failed to check local Antigravity CLI installation.");
    } finally {
      setAutoDetecting(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      setAuthMode("auto");
      setImportError(null);
      runAutoDetect();
    }
  }, [isOpen]);

  const handleImportDetected = async () => {
    if (!detectedToken) return;
    setImporting(true);
    setImportError(null);

    try {
      const res = await fetch("/api/oauth/agy/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessToken: detectedToken.accessToken,
          refreshToken: detectedToken.refreshToken,
          expiresAt: detectedToken.expiresAt,
          name: customName.trim() || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Import failed");
      }

      onSuccess?.();
      onClose();
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImporting(false);
    }
  };

  const handleImportManual = async () => {
    if (!rawJson.trim()) {
      setImportError("Please paste your Antigravity CLI token JSON or refresh token.");
      return;
    }

    setImporting(true);
    setImportError(null);

    try {
      let body;
      const text = rawJson.trim();
      if (text.startsWith("{")) {
        body = { rawJson: text, name: customName.trim() || undefined };
      } else {
        // Plain string: assume refresh token
        body = { refreshToken: text, name: customName.trim() || undefined };
      }

      const res = await fetch("/api/oauth/agy/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Import failed");
      }

      onSuccess?.();
      onClose();
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImporting(false);
    }
  };

  if (authMode === "oauth") {
    return (
      <OAuthModal
        isOpen={isOpen}
        provider="agy"
        providerInfo={providerInfo}
        onSuccess={() => {
          onSuccess?.();
          onClose();
        }}
        onClose={onClose}
      />
    );
  }

  return (
    <Modal isOpen={isOpen} title="Connect Antigravity CLI (agy)" onClose={onClose}>
      <div className="flex flex-col gap-4">
        {/* Navigation tabs */}
        <div className="flex border-b border-border text-sm">
          <button
            type="button"
            className={`px-4 py-2 font-medium border-b-2 transition-colors ${
              authMode === "auto"
                ? "border-primary text-primary"
                : "border-transparent text-text-muted hover:text-text"
            }`}
            onClick={() => setAuthMode("auto")}
          >
            Auto-Detect
          </button>
          <button
            type="button"
            className={`px-4 py-2 font-medium border-b-2 transition-colors ${
              authMode === "paste"
                ? "border-primary text-primary"
                : "border-transparent text-text-muted hover:text-text"
            }`}
            onClick={() => setAuthMode("paste")}
          >
            Paste Token JSON
          </button>
          <button
            type="button"
            className={`px-4 py-2 font-medium border-b-2 transition-colors ${
              authMode === "oauth"
                ? "border-primary text-primary"
                : "border-transparent text-text-muted hover:text-text"
            }`}
            onClick={() => setAuthMode("oauth")}
          >
            Sign in with Google
          </button>
        </div>

        {/* Optional Connection Name */}
        <Input
          label="Connection Label (optional)"
          placeholder="e.g. My Antigravity CLI"
          value={customName}
          onChange={(e) => setCustomName(e.target.value)}
        />

        {/* Auto-Detect Mode */}
        {authMode === "auto" && (
          <div className="flex flex-col gap-3">
            {autoDetecting && (
              <div className="text-center py-6">
                <div className="size-12 mx-auto mb-3 rounded-full bg-primary/10 flex items-center justify-center">
                  <span className="material-symbols-outlined text-2xl text-primary animate-spin">
                    progress_activity
                  </span>
                </div>
                <p className="text-sm font-medium">Scanning for local Antigravity CLI credentials...</p>
                <p className="text-xs text-text-muted">OS Keyring &amp; ~/.gemini/antigravity-cli</p>
              </div>
            )}

            {!autoDetecting && autoDetected && (
              <div className="bg-green-50 dark:bg-green-900/20 p-3 rounded-lg border border-green-200 dark:border-green-800 flex flex-col gap-2">
                <div className="flex items-center gap-2 text-green-800 dark:text-green-200 text-sm font-medium">
                  <span className="material-symbols-outlined text-green-600 dark:text-green-400 text-base">check_circle</span>
                  Local Antigravity CLI credentials found!
                </div>
                <p className="text-xs text-text-muted break-all">Source: {detectedToken?.source}</p>
                <Button
                  variant="primary"
                  fullWidth
                  onClick={handleImportDetected}
                  disabled={importing}
                >
                  {importing ? "Importing..." : "Connect Antigravity CLI"}
                </Button>
              </div>
            )}

            {!autoDetecting && !autoDetected && (
              <div className="bg-amber-50 dark:bg-amber-900/20 p-3 rounded-lg border border-amber-200 dark:border-amber-800 flex flex-col gap-3">
                <div className="flex items-start gap-2 text-amber-800 dark:text-amber-200 text-xs">
                  <span className="material-symbols-outlined text-amber-600 dark:text-amber-400 text-base shrink-0">info</span>
                  <div>
                    <p className="font-semibold mb-1">Local login not found</p>
                    <p>{autoDetectError || "Make sure you have logged into Antigravity CLI with `agy`."}</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={runAutoDetect}>
                    Retry Scan
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setAuthMode("paste")}>
                    Paste Token Manually
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Paste Mode */}
        {authMode === "paste" && (
          <div className="flex flex-col gap-3">
            <div className="text-xs text-text-muted">
              Paste the contents of your <code>antigravity-oauth-token</code> file or raw refresh token:
            </div>
            <textarea
              className="w-full h-32 p-2 text-xs font-mono rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder='{"token":{"access_token":"...","refresh_token":"..."}}'
              value={rawJson}
              onChange={(e) => setRawJson(e.target.value)}
            />
            <Button
              variant="primary"
              fullWidth
              onClick={handleImportManual}
              disabled={importing || !rawJson.trim()}
            >
              {importing ? "Importing..." : "Import Token"}
            </Button>
          </div>
        )}

        {importError && (
          <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-2 rounded border border-red-200 dark:border-red-800">
            {importError}
          </div>
        )}
      </div>
    </Modal>
  );
}

AgyAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  providerInfo: PropTypes.object,
  onSuccess: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
