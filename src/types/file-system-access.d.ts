// File System Access API — ambient declaration for the one gap in TS 5.9's
// lib.dom. The handle types (FileSystemDirectoryHandle, FileSystemFileHandle,
// FileSystemWritableFileStream) and their methods all ship in lib.dom already;
// only `window.showDirectoryPicker` is missing, so we declare just that.
//
// Spec: https://wicg.github.io/file-system-access/#api-showdirectorypicker
// Chromium-only — matches our browser constraint (ADR-001 / ARCHITECTURE).

interface ShowDirectoryPickerOptions {
  /** Persisted picker location, keyed per-id by the browser. */
  id?: string;
  /** "readwrite" requests write permission upfront so we don't re-prompt to save. */
  mode?: "read" | "readwrite";
  /** A well-known directory or a handle to open the picker in. */
  startIn?: FileSystemHandle | "desktop" | "documents" | "downloads" | "music" | "pictures" | "videos";
}

// showOpenFilePicker — used by video import (TASK-30) to choose a pre-recorded
// webm/mp4. Same lib.dom gap as showDirectoryPicker; we declare the single
// (non-multiple) form plus the accept-filter shape we pass.
// Spec: https://wicg.github.io/file-system-access/#api-showopenfilepicker
interface FilePickerAcceptType {
  description?: string;
  /** MIME type → list of file extensions (each with a leading dot). */
  accept: Record<string, string | string[]>;
}

interface ShowOpenFilePickerOptions {
  multiple?: boolean;
  /** Hide the "All files" option so the picker steers toward `types`. */
  excludeAcceptAllOption?: boolean;
  types?: FilePickerAcceptType[];
  id?: string;
  startIn?: FileSystemHandle | "desktop" | "documents" | "downloads" | "music" | "pictures" | "videos";
}

interface Window {
  showDirectoryPicker(options?: ShowDirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
  showOpenFilePicker(options?: ShowOpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
}

// Permission methods for persisted handles (TASK-15). lib.dom ships the handle
// types but not these WICG methods — we restore a handle from IndexedDB, then
// query/request permission rather than re-prompting the picker.
// Spec: https://wicg.github.io/file-system-access/#api-filesystemhandle-querypermission
interface FileSystemHandlePermissionDescriptor {
  mode?: "read" | "readwrite";
}

interface FileSystemHandle {
  queryPermission(
    descriptor?: FileSystemHandlePermissionDescriptor,
  ): Promise<PermissionState>;
  requestPermission(
    descriptor?: FileSystemHandlePermissionDescriptor,
  ): Promise<PermissionState>;
}

// move() — Chromium's in-place rename, used by crash-recovery (TASK-24) to
// commit an orphaned recording.webm.crswap onto recording.webm. It's a Chromium
// extension, not in lib.dom or the WICG/WHATWG drafts, so we declare the single
// same-directory rename form we use. We remove any existing destination first
// rather than rely on move()'s (unspecified) overwrite behaviour.
// Shipped Chrome 111+. https://developer.mozilla.org/docs/Web/API/FileSystemHandle/move
interface FileSystemFileHandle {
  move(newName: string): Promise<void>;
}

// lib.dom omits the directory async iterators too. keys() probes whether a
// restored folder is still reachable (TASK-15); values() walks the entries to
// list sessions (TASK-14). The values() union carries the `kind` discriminant,
// so callers can narrow a directory entry from a file entry.
interface FileSystemDirectoryHandle {
  keys(): AsyncIterableIterator<string>;
  values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>;
}
