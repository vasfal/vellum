// Download kebab — client-side "save a file to the user's Downloads" for the right-pane
// download kebab (report Markdown / tasks JSON). This is NOT a File System Access
// write into the workspace — it's the ordinary browser download of an in-memory
// string, so it needs no permission and no directory handle: build a Blob, mint an
// object URL, click a throwaway <a download>, then revoke. Browser-only (touches
// document / URL), so it's called from "use client" components exclusively.

/**
 * Trigger a browser download of an already-built Blob as `name`. The <a> is
 * appended, clicked, and removed synchronously; the object URL is revoked on the
 * next tick so the click has resolved before the blob is freed. No-ops outside
 * the browser (SSR guard) rather than throwing. This is the shared primitive —
 * text downloads (below) and the per-run ZIP export (export-zip.ts) both route
 * through it, so there is one <a download> path to reason about.
 */
export function downloadBlob(name: string, blob: Blob): void {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click has been handled — revoking synchronously can cancel
  // the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Trigger a browser download of `text` as a file named `name` with MIME `mime`.
 * Thin wrapper over downloadBlob — wraps the string in a Blob first.
 */
export function downloadTextFile(name: string, text: string, mime: string): void {
  downloadBlob(name, new Blob([text], { type: mime }));
}
