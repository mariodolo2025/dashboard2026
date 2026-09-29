// =============================================================================
// Stale build recovery — the white screen after every deploy
// =============================================================================
// Mario, 2026-09-30: "esto lo esta haciendo seguido, que muestra pantalla en
// blanco, ahora lo hizo al querer editar uno de los profiles de cost."
//
// Every tab is its own lazily-loaded file whose name carries a content hash
// (CostsCanvas-6lp3GieC.js). Each deploy replaces them, and Vercel serves only
// the current deployment: a file from the previous build answers 404 (checked
// on live, 2026-09-30). A dashboard left open across a deploy still points at
// the old names, so the first tab it has not opened yet fails to load, React
// has nothing to render, and with no error boundary the whole page goes blank.
// Fourteen deploys since 20-Sep and thirteen lazy tabs made that routine.
//
// Vite reports exactly this case with a `vite:preloadError` event (its preload
// helper fires it when the import itself fails, vite 5.4). The fix is the one
// Vite documents: reload, which fetches the new index.html and the new names.
// Guarded so a file that is genuinely broken cannot put the tab in a reload
// loop — the second failure inside the window falls through to the visible
// error screen instead.

const KEY = 'aim-stale-build-reload-at';
const WINDOW_MS = 30_000;

/** Reload once to pick up the current build. False if we already did so in
 *  the last 30 s (the file is broken, not stale) — the caller should show the
 *  error instead of reloading again. */
export function reloadOnceForNewBuild(): boolean {
  let last = 0;
  try { last = Number(sessionStorage.getItem(KEY) ?? 0); } catch { /* private mode */ }
  if (Date.now() - last < WINDOW_MS) return false;
  try { sessionStorage.setItem(KEY, String(Date.now())); } catch { /* private mode */ }
  window.location.reload();
  return true;
}

/** True for the errors a browser raises when a lazily-imported file is gone. */
export function isStaleChunkError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err ?? '');
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(msg);
}

/** Wire the Vite event. Call once, before the app renders. */
export function installStaleBuildRecovery(): void {
  window.addEventListener('vite:preloadError', (event) => {
    // Only swallow the error when we are actually reloading; otherwise let it
    // reach the error boundary so it is seen, not silently dropped.
    if (reloadOnceForNewBuild()) event.preventDefault();
  });
}
