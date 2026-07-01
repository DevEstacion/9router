// Next.js startup hook (https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation).
// Runs once when the 9router server boots, before it begins accepting
// requests. Used here to auto-start the Headroom context-compression
// proxy so users don't have to click "Start" in the dashboard after
// every 9router restart.
//
// Failure modes are all swallowed and logged — never block 9router boot.

import { getSettings } from "@/lib/localDb";
import { startHeadroomProxy } from "@/lib/headroom/process";
import { findHeadroomBinary, isLoopbackHeadroomUrl, DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Fire after a short delay so the HTTP listener is up and the DB is
  // initialised; never block the boot path.
  setTimeout(() => {
    autoStartHeadroom().catch((e) => {
      console.log(`[instrumentation] headroom auto-start error: ${e?.message || e}`);
    });
  }, 3000);
}

async function autoStartHeadroom() {
  let settings;
  try {
    settings = await getSettings();
  } catch (e) {
    return; // DB not ready yet — bail silently, user can start manually.
  }

  if (!settings.headroomEnabled) return;

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
    const port = Number(new URL(url).port) || 8787;
    const result = await startHeadroomProxy({ port });
    if (!result.alreadyRunning) {
      console.log(`[instrumentation] headroom auto-started: pid=${result.pid}`);
    }
  } catch (e) {
    // Already running, or some other non-fatal reason; log and move on.
    console.log(`[instrumentation] headroom auto-start skipped: ${e?.message || e}`);
  }
}
