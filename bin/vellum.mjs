#!/usr/bin/env node
// Vellum launcher (TASK-62): `vellum ui` boots the local web app and opens a
// browser at it. Written as plain ESM on purpose — it runs straight from a
// published npm package with no tsx/TypeScript step at runtime. The Next app
// itself is the built `.next` that ships in the tarball; this file is just the
// front door.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// The package root is the parent of bin/ — where `.next`, `public`, and
// next.config.ts live, both in a published tarball and in a dev checkout.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const [command = "ui"] = process.argv.slice(2);

switch (command) {
  case "ui":
    await runUi();
    break;
  case "analyze":
    // Reserved for TASK-53. Named here so `vellum analyze` fails with a human
    // hint instead of an "unknown command", since docs will mention it.
    console.error(
      "`vellum analyze` isn't available yet — analyze from the web app for now:\n  vellum ui\n(The terminal analyze command lands in TASK-53.)",
    );
    process.exit(1);
    break;
  case "-v":
  case "--version":
    console.log(readVersion());
    break;
  case "-h":
  case "--help":
    printHelp();
    break;
  default:
    console.error(`Unknown command: ${command}\n`);
    printHelp();
    process.exit(1);
}

async function runUi() {
  // Load the home-config key (TASK-64 writes it here) so the server sees it. A
  // real process.env value wins, so a dev checkout with .env.local or an
  // exported GEMINI_API_KEY still works.
  loadHomeEnv();

  const nextBin = require.resolve("next/dist/bin/next");

  // A production build must exist for `next start`. It ships prebuilt in the
  // published tarball; a dev checkout builds once on first run.
  if (!existsSync(join(packageRoot, ".next"))) {
    console.log("First run — building Vellum (one time, ~a minute)…\n");
    await runToCompletion(nextBin, ["build"]);
  }

  const port = await freePort(4270);
  const url = `http://localhost:${port}`;

  const server = spawn(process.execPath, [nextBin, "start", "-p", String(port)], {
    cwd: packageRoot,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, NODE_ENV: "production" },
  });

  // Stop the server cleanly on Ctrl-C so a stray port isn't left held.
  const stop = () => {
    server.kill("SIGINT");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  server.on("exit", (code) => process.exit(code ?? 0));

  await waitForServer(url);
  console.log(`\nVellum is running at ${url} — opening your browser.`);
  console.log("Leave this terminal open; press Ctrl-C to stop.\n");
  openBrowser(url);
}

/** Load ~/.vellum/.env into process.env without overriding real env vars. */
function loadHomeEnv() {
  const envPath = join(homedir(), ".vellum", ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

/** Prefer `preferred`; fall back to an OS-assigned free port if it's taken. */
function freePort(preferred) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(ephemeralPort()));
    probe.listen(preferred, () => probe.close(() => resolve(preferred)));
  });
}

function ephemeralPort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Poll until the server answers (any HTTP response counts), then return. */
async function waitForServer(url, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(url, { method: "HEAD" });
      return;
    } catch {
      await sleep(300);
    }
  }
  throw new Error(`Vellum didn't become ready at ${url} within 60s.`);
}

function openBrowser(url) {
  const os = platform();
  const [cmd, args] =
    os === "darwin"
      ? ["open", [url]]
      : os === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // Non-fatal: the URL is already printed for the user to click.
  }
}

/** Spawn `node <script> <args>` and resolve on a clean exit, reject otherwise. */
function runToCompletion(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: packageRoot,
      stdio: "inherit",
      env: { ...process.env, NODE_ENV: "production" },
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`\`next ${args[0]}\` exited with code ${code}.`)),
    );
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readVersion() {
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  return pkg.version ?? "unknown";
}

function printHelp() {
  console.log(`Vellum — record a design review, get a structured report.

Usage:
  vellum ui         Launch the local web app and open it in your browser
  vellum analyze    (coming soon) Analyze a recording from the terminal

  vellum --version  Print the installed version
  vellum --help     Show this help

The web app runs entirely on your machine. Recordings never leave your disk;
only the analyze step sends video to Google Gemini, under your own API key.`);
}
