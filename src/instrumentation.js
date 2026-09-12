export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // Fire after a short delay so the HTTP listener is up and the DB is
    // initialised; never block the boot path.
    setTimeout(() => {
      autoStartHeadroom().catch((e) => {
        console.log(`[instrumentation] headroom auto-start error: ${e?.message || e}`);
      });
    }, 3000);
  }
}

async function autoStartHeadroom() {
  let settings;
  try {
    const { getSettings } = await import("@/lib/localDb");
    settings = await getSettings();
  } catch {
    return; // DB not ready yet — bail silently, user can start manually.
  }

  if (!settings?.headroomEnabled) return;

  const { findHeadroomBinary, isLoopbackHeadroomUrl, DEFAULT_HEADROOM_URL } = await import("@/lib/headroom/detect");
  const url = settings.headroomUrl || DEFAULT_HEADROOM_URL;
  if (!isLoopbackHeadroomUrl(url)) {
    // External headroom proxies are managed outside 9router; skip.
    return;
  }
  if (!findHeadroomBinary()) {
    // CLI not present — user hasn't installed Headroom; skip.
    return;
  }

  try {
    const { startHeadroomProxy } = await import("@/lib/headroom/process");
    const port = Number(new URL(url).port) || 8787;
    const result = await startHeadroomProxy({ port });
    if (!result?.alreadyRunning) {
      console.log(`[instrumentation] headroom auto-started: pid=${result.pid}`);
    }
  } catch (e) {
    // Already running, or some other non-fatal reason; log and move on.
    console.log(`[instrumentation] headroom auto-start skipped: ${e?.message || e}`);
  }
}
