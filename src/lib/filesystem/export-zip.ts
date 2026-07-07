// TASK-71 — per-run "Download run (ZIP)": archive ONE run's full resource set —
// report.md, tasks.json, screenshots/, and the recording it analyzed — into a
// single .zip produced entirely in the browser and saved through the ordinary
// download path (download.ts). Works for the live run and any archived run.
//
// Zero-dependency STORE-method zip. The assets we bundle (PNG frames + a
// WebM/MP4 recording) are ALREADY compressed, so DEFLATE would shave almost
// nothing off while pulling in a zip library. A STORE (no-compression) zip is a
// handful of well-documented little-endian records — a local file header per
// entry, a central directory, an end-of-central-directory, and a CRC32 — so we
// emit it by hand. (Alternative weighed: `fflate` (~8 KB min+gz, the smallest
// well-maintained option). Rejected: for pre-compressed payloads STORE gives the
// same file, and a ~120-line hand-rolled writer keeps the dependency list honest
// per CLAUDE.md's "don't add a dep without naming the alternative" rule.)
//
// ZIP32 only: the size/offset fields are 32-bit, so one archive is capped near
// 4 GB. A design-review recording is far under that; ZIP64 would add real
// complexity for a case we never hit — a deliberate scope line, not an oversight.
//
// Client-safe: File System Access + browser APIs (Blob, TextEncoder, atob-free).
// No Node built-ins, so it bundles into the "use client" session view.

import { kebabCase } from "@/lib/gemini/schema";
import { SCREENSHOTS_DIR, screenshotsArchiveName } from "@/lib/report/render-report";
import { downloadBlob } from "./download";
import { findRecording, RECORDING_EXTENSIONS } from "./recording-file";

/** One file inside the archive: its POSIX path within the zip + its raw bytes.
 *  The `<ArrayBuffer>` annotation (not the bare `Uint8Array`) pins the backing
 *  buffer so the bytes satisfy the DOM BlobPart type under TS 5.7+. */
interface ZipEntry {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export interface RunZipTarget {
  /** The live workspace root handle (the session folder lives under it). */
  workspace: FileSystemDirectoryHandle;
  /** The session's on-disk folder name (the route slug / stable id). */
  name: string;
  /** The session's effective display name — the download filename slug. */
  displayName: string;
  /**
   * The archived run's unified stamp ("YYYY-MM-DD-HHMMSS", optionally "-N"), or
   * null for the LATEST/live run. Selects which of a run's resources to gather:
   * the live `report.md`/`tasks.json`/`screenshots/`, or the stamped siblings.
   */
  stamp: string | null;
}

/**
 * Gather one run's four resources and download them as a single .zip. Best-effort
 * throughout (ADR-008): a run missing its report, tasks, frames, or recording
 * still exports whatever it has; only a completely empty run is a silent no-op.
 * The recording is resolved per-run — the archived snapshot if this run's video
 * was later replaced, else the shared session recording (see resolveRunRecording).
 */
export async function downloadRunZip({
  workspace,
  name,
  displayName,
  stamp,
}: RunZipTarget): Promise<void> {
  const dir = await workspace.getDirectoryHandle(name);

  // The live run reads the canonical names; an archived run reads its stamped
  // siblings (ADR-023: report/tasks/screenshots of one run share the stamp).
  const reportName = stamp ? `report-${stamp}.md` : "report.md";
  const tasksName = stamp ? `tasks-${stamp}.json` : "tasks.json";
  const shotsDirName = stamp ? screenshotsArchiveName(stamp) : SCREENSHOTS_DIR;

  const entries: ZipEntry[] = [];

  // report.md + tasks.json — stored under their CANONICAL names inside the zip
  // (not the stamped disk names), so every run's archive looks the same to open.
  const reportBytes = await readBytesOrNull(dir, reportName);
  if (reportBytes) entries.push({ name: "report.md", bytes: reportBytes });

  const tasksBytes = await readBytesOrNull(dir, tasksName);
  if (tasksBytes) entries.push({ name: "tasks.json", bytes: tasksBytes });

  // screenshots/ — every PNG in the run's frames folder, flattened under a
  // canonical `screenshots/` prefix regardless of the on-disk (stamped) folder.
  const shotsDir = await getDirectoryHandleOrNull(dir, shotsDirName);
  if (shotsDir) {
    for await (const entry of shotsDir.values()) {
      if (entry.kind !== "file") continue;
      const file = await entry.getFile();
      entries.push({
        name: `screenshots/${entry.name}`,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
    }
  }

  // The recording this run analyzed (webm/mp4), stored under its canonical name.
  const recording = await resolveRunRecording(dir, stamp);
  if (recording) entries.push(recording);

  if (entries.length === 0) return; // nothing to export — silent no-op

  const blob = buildStoreZip(entries);
  // Filename mirrors the MD/JSON export: kebab slug of the display name, plus the
  // archive stamp for an older run so it never collides with the latest's.
  const slug = kebabCase(displayName) ?? "session";
  const base = stamp ? `${slug}-${stamp}` : slug;
  downloadBlob(`${base}.zip`, blob);
}

/**
 * Resolve the exact recording a run analyzed. An archived run whose video was
 * later REPLACED (a re-run-with-video — origin "revise-video") has its prior
 * recording snapshotted beside its other archives as `recording-<stamp>.<ext>`
 * (write-report-browser.ts) — prefer that. Otherwise the run shared the session
 * recording (a text-revise, an un-replaced video, or the live run): resolve the
 * current `recording.webm`/`recording.mp4`. Null when the session has no
 * recording at all (an incomplete session, ADR-008). Named canonically inside the
 * zip (`recording.<ext>`) even when it came from a stamped snapshot.
 */
async function resolveRunRecording(
  dir: FileSystemDirectoryHandle,
  stamp: string | null,
): Promise<ZipEntry | null> {
  if (stamp) {
    for (const ext of RECORDING_EXTENSIONS) {
      const bytes = await readBytesOrNull(dir, `recording-${stamp}${ext}`);
      if (bytes) return { name: `recording${ext}`, bytes };
    }
  }
  const match = await findRecording(dir);
  if (!match) return null;
  const bytes = new Uint8Array(await (await match.handle.getFile()).arrayBuffer());
  return { name: match.name, bytes };
}

// --- ZIP writer (STORE method) --------------------------------------------------

/**
 * Build a STORE-method zip from `entries` and return it as one Blob. Layout:
 * for each entry a local file header + its raw bytes, then the central directory
 * (one record per entry), then the end-of-central-directory record. All fields
 * are little-endian; filenames are UTF-8 (general-purpose bit 11 set). Sizes and
 * CRC32 are known up front (STORE), so no data descriptors are needed.
 */
function buildStoreZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0; // running byte offset of the next local header

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.bytes);
    const size = entry.bytes.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed to extract (2.0)
    lv.setUint16(6, 0x0800, true); // flags: UTF-8 filename
    lv.setUint16(8, 0, true); // method: 0 = store
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0x21, true); // mod date: 1980-01-01 (fixed, deterministic)
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // compressed size (== uncompressed for store)
    lv.setUint32(22, size, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra field length
    local.set(nameBytes, 30);

    parts.push(local, entry.bytes);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory header signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true); // flags: UTF-8 filename
    cv.setUint16(10, 0, true); // method: store
    cv.setUint16(12, 0, true); // mod time
    cv.setUint16(14, 0x21, true); // mod date
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra field length
    cv.setUint16(32, 0, true); // file comment length
    cv.setUint16(34, 0, true); // disk number start
    cv.setUint16(36, 0, true); // internal attributes
    cv.setUint32(38, 0, true); // external attributes
    cv.setUint32(42, offset, true); // offset of local header
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + size;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const cd of central) {
    parts.push(cd);
    centralSize += cd.length;
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory signature
  ev.setUint16(4, 0, true); // number of this disk
  ev.setUint16(6, 0, true); // disk with the central directory
  ev.setUint16(8, entries.length, true); // entries on this disk
  ev.setUint16(10, entries.length, true); // total entries
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  ev.setUint16(20, 0, true); // comment length
  parts.push(eocd);

  return new Blob(parts, { type: "application/zip" });
}

/** CRC32 lookup table (IEEE polynomial 0xEDB88320), built once at module load. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** Standard CRC32 over `bytes`, returned as an unsigned 32-bit int (zip byte order). */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// --- Best-effort reads ----------------------------------------------------------

/** Read a file's bytes, or null when it isn't there (NotFoundError). Other errors propagate. */
async function readBytesOrNull(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const handle = await dir.getFileHandle(name);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotFoundError") return null;
    throw err;
  }
}

/** getDirectoryHandle, but a missing folder → null instead of throwing. */
async function getDirectoryHandleOrNull(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await dir.getDirectoryHandle(name);
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotFoundError") return null;
    throw err;
  }
}
