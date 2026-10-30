/**
 * Pipe regression tests, inherited from the factory emit contract
 * (FACTORY-NOTES.md; ledger P-001, P-017, P-021 in the tranche 1 tools).
 *
 * Node stdout attached to a pipe is asynchronous: console.log followed
 * by process.exit discards whatever the pipe has not drained, truncating
 * at one 64 KiB pipe buffer while the exit code still reports success.
 * These tests spawn the real CLI with piped stdio and push a report past
 * 200 KiB through the pipe.
 *
 * envdoctor reports are normally small, so the fixture builds a repo
 * whose .env.example declares 4000 keys while its .env is empty: that
 * produces one ENV-KEYS-MISSING finding per key and a report well past
 * 200 KiB.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { renderReport, runCheck } from "../src/core.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY_COUNT = 4000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "envdoctor-pipe-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeBigEnvRepo(root: string): void {
  const m = /^v?(\d+)/.exec(process.version);
  const major = m ? Number(m[1]) : 20;
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture-big", version: "1.0.0", engines: { node: `^${major}.0.0` } }, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(join(root, "package-lock.json"), "{}\n", "utf8");
  const keys: string[] = [];
  for (let i = 0; i < KEY_COUNT; i++) keys.push(`KEY_${String(i).padStart(4, "0")}=placeholder`);
  writeFileSync(join(root, ".env.example"), keys.join("\n") + "\n", "utf8");
  // .env exists but names no keys, so every example key is missing.
  writeFileSync(join(root, ".env"), "", "utf8");
}

interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], opts: { destroyStdoutOnFirstChunk?: boolean } = {}): Promise<CliResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error("CLI timed out"));
    }, 90000);
    if (opts.destroyStdoutOnFirstChunk) {
      // Close the read end immediately, before the child has even finished
      // computing its report. Destroying only on the first chunk races the
      // writer: if the whole write lands in the kernel pipe buffer before
      // the destroy lands, no EPIPE occurs and the process exits with its
      // verdict code.
      child.stdout.destroy();
    }
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
      if (opts.destroyStdoutOnFirstChunk) child.stdout.destroy();
    });
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      rejectPromise(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout: out, stderr: err });
    });
  });
}

describe("emit contract: piped output is delivered whole", () => {
  it("piped --json report over 200 KiB parses and matches the in-process report", { timeout: 120000 }, async () => {
    writeBigEnvRepo(dir);
    const direct = runCheck(dir);
    const directJson = JSON.stringify(direct, null, 2);
    assert.ok(directJson.length > 200_000, `fixture must exceed 200 KiB of JSON, got ${directJson.length}`);
    const missing = direct.findings.filter((f) => f.rule === "ENV-KEYS-MISSING");
    assert.equal(missing.length, KEY_COUNT);
    const res = await runCli(["doctor", dir, "--json"]);
    assert.equal(res.code, 1, `expected exit 1 (ISSUES), got ${res.code} (stderr: ${res.stderr.slice(0, 200)})`);
    assert.equal(res.stdout.length, directJson.length + 1, "piped bytes must equal the full report plus the trailing newline");
    const parsed = JSON.parse(res.stdout) as { counts: Record<string, number>; verdict: string; findings: unknown[] };
    assert.equal(parsed.counts["findings"], direct.counts["findings"]);
    assert.equal(parsed.findings.length, direct.findings.length);
    assert.equal(parsed.verdict, direct.verdict);
    assert.equal(parsed.verdict, "ISSUES");
  });

  it("piped human output is byte-identical to the in-process render", { timeout: 120000 }, async () => {
    writeBigEnvRepo(dir);
    const expected = renderReport(runCheck(dir)) + "\n";
    assert.ok(expected.length > 65_536, `human fixture must exceed one pipe buffer, got ${expected.length}`);
    const res = await runCli(["doctor", dir]);
    assert.equal(res.code, 1);
    assert.equal(res.stdout, expected);
  });

  it("a reader that closes the pipe early never sees a success exit", { timeout: 120000 }, async () => {
    writeBigEnvRepo(dir);
    const res = await runCli(["doctor", dir, "--json"], { destroyStdoutOnFirstChunk: true });
    assert.notEqual(res.code, 0, "exit 0 would report success for output that was never delivered");
    assert.ok(res.signal === "SIGPIPE" || res.code === 141, `expected SIGPIPE or exit 141, got code ${res.code} signal ${res.signal}`);
  });
});
