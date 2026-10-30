/**
 * envdoctor core tests.
 *
 * Integration fixtures are built in temp dirs at test time. The healthy
 * fixture derives its engines range from process.version so it passes
 * on any Node version the suite itself runs on.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkNodeVersion,
  parseEnvExample,
  renderReport,
  runCheck,
  runDoctor,
  CLEAN_VERDICT,
  VERSION,
} from "../src/core.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "envdoctor-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function currentMajor(): number {
  const m = /^v?(\d+)/.exec(process.version);
  assert.ok(m, `cannot parse process.version ${process.version}`);
  return Number(m[1]);
}

function writeHealthy(root: string): void {
  const major = currentMajor();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture-healthy", version: "1.0.0", engines: { node: `^${major}.0.0` } }, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(join(root, "package-lock.json"), "{}\n", "utf8");
  writeFileSync(join(root, ".env.example"), "API_KEY=\nDATABASE_URL=\n", "utf8");
  writeFileSync(join(root, ".env"), "API_KEY=test-secret-value-123\nDATABASE_URL=test-secret-value-456\n", "utf8");
}

function writeBasePackage(root: string): void {
  const major = currentMajor();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", engines: { node: `^${major}.0.0` } }, null, 2) + "\n",
    "utf8",
  );
}

describe("exports", () => {
  it("exposes the fleet version and clean verdict", () => {
    assert.equal(VERSION, "0.1.0");
    assert.equal(CLEAN_VERDICT, "HEALTHY");
  });
});

describe("checkNodeVersion", () => {
  const cases: Array<[string, string, boolean | null]> = [
    ["v20.11.0", ">=18", true],
    ["v18.0.0", ">=18", true],
    ["v16.20.0", ">=18", false],
    ["v20.11.0", ">=20.0.0", true],
    ["v20.11.0", ">19", true],
    ["v20.11.0", "<21", true],
    ["v20.11.0", "^20.0.0", true],
    ["v21.0.0", "^20.0.0", false],
    ["v20.11.5", "^20.11.0", true],
    ["v20.10.0", "^20.11.0", false],
    ["v20.11.9", "~20.11.0", true],
    ["v20.12.0", "~20.11.0", false],
    ["v20.11.0", "~20", true],
    ["v20.11.0", "20.11.0", true],
    ["v20.11.1", "20.11.0", false],
    ["v20.5.0", "20.x", true],
    ["v19.5.0", "20.x", false],
    ["v20.11.0", "20.11.x", true],
    ["v20.12.0", "20.11.x", false],
    ["v20.11.0", ">=18 <21", true],
    ["v22.0.0", ">=18 <21", false],
    ["v20.11.0", "lts/*", null],
    ["v20.11.0", "not-a-version", null],
    ["v20.11.0", ">=foo", null],
    ["v20.11.0", "18 - 20", null],
    ["20.11.0", "20.x", true],
  ];
  for (const [current, range, expected] of cases) {
    it(`checkNodeVersion(${current}, ${JSON.stringify(range)}) is ${String(expected)}`, () => {
      assert.equal(checkNodeVersion(current, range), expected);
    });
  }
});

describe("parseEnvExample", () => {
  it("extracts names and skips comments and blanks", () => {
    const text = "# comment\n\nFOO=bar\n  \n# another\nBAR=baz\n";
    assert.deepEqual(parseEnvExample(text), ["FOO", "BAR"]);
  });

  it("strips the export prefix", () => {
    assert.deepEqual(parseEnvExample("export FOO=bar\nBAZ=qux\n"), ["FOO", "BAZ"]);
  });

  it("keeps only the name when the value contains = signs", () => {
    assert.deepEqual(parseEnvExample("TOKEN=abc=def=ghi\n"), ["TOKEN"]);
  });

  it("handles empty values, spaced keys, and lines without =", () => {
    assert.deepEqual(parseEnvExample("EMPTY=\nSPACED = value\nPLAINKEY\n"), ["EMPTY", "SPACED", "PLAINKEY"]);
  });

  it("dedupes names and preserves file order", () => {
    assert.deepEqual(parseEnvExample("B=1\nA=2\nB=3\n"), ["B", "A"]);
  });

  it("parses the shipped fixture file", () => {
    const text = readFileSync(join(FIXTURES, "env-example.txt"), "utf8");
    assert.deepEqual(parseEnvExample(text), ["API_KEY", "DATABASE_URL", "EMPTY_VALUE", "TOKEN_WITH_EQUALS", "SPACED_KEY"]);
  });

  it("returns no names for an empty file", () => {
    assert.deepEqual(parseEnvExample(""), []);
    assert.deepEqual(parseEnvExample("# only a comment\n\n"), []);
  });
});

describe("runCheck integration", () => {
  it("repo-healthy is HEALTHY with every check passing", () => {
    writeHealthy(dir);
    const { report, checks } = runDoctor(dir);
    assert.equal(report.tool, "envdoctor");
    assert.equal(report.version, "0.1.0");
    assert.equal(report.verdict, "HEALTHY");
    assert.equal(report.counts["checksRun"], 5);
    assert.equal(report.counts["checksPassed"], 5);
    assert.equal(report.counts["checksFailed"], 0);
    const names = checks.map((c) => c.name);
    assert.deepEqual(names, ["NODE-VERSION", "GIT-PRESENT", "NPM-PRESENT", "LOCKFILE", "ENV-FILE"]);
    for (const c of checks) assert.equal(c.status, "pass", `${c.name} should pass: ${c.detail}`);
    const passes = report.findings.filter((f) => f.rule === "CHECK-PASS");
    assert.equal(passes.length, 5);
    for (const c of checks) {
      assert.ok(
        passes.some((f) => f.message.startsWith(`${c.name}: `)),
        `a CHECK-PASS finding should cover ${c.name}`,
      );
    }
    // Env values must never appear in any output.
    const blob = JSON.stringify(report) + renderReport(report);
    assert.ok(!blob.includes("test-secret-value"), "env values must never be printed");
  });

  it("git and npm checks appear and pass on this machine", () => {
    writeHealthy(dir);
    const { checks } = runDoctor(dir);
    const git = checks.find((c) => c.name === "GIT-PRESENT");
    const npm = checks.find((c) => c.name === "NPM-PRESENT");
    assert.ok(git, "GIT-PRESENT check should exist");
    assert.ok(npm, "NPM-PRESENT check should exist");
    assert.equal(git.status, "pass");
    assert.equal(npm.status, "pass");
  });

  it("repo-noenv reports ENV-MISSING at medium with the copy fix", () => {
    writeBasePackage(dir);
    writeFileSync(join(dir, "package-lock.json"), "{}\n", "utf8");
    writeFileSync(join(dir, ".env.example"), "API_KEY=\n", "utf8");
    const { report, checks } = runDoctor(dir);
    assert.equal(report.verdict, "ISSUES");
    const finding = report.findings.find((f) => f.rule === "ENV-MISSING");
    assert.ok(finding, "ENV-MISSING finding expected");
    assert.equal(finding.severity, "medium");
    const envCheck = checks.find((c) => c.name === "ENV-FILE");
    assert.equal(envCheck?.status, "fail");
    assert.equal(envCheck?.fix, "copy .env.example to .env and fill values");
    assert.equal(report.counts["checksFailed"], 1);
  });

  it("repo-nolock reports NO-LOCKFILE at medium", () => {
    writeBasePackage(dir);
    const { report, checks } = runDoctor(dir);
    assert.equal(report.verdict, "ISSUES");
    const finding = report.findings.find((f) => f.rule === "NO-LOCKFILE");
    assert.ok(finding, "NO-LOCKFILE finding expected");
    assert.equal(finding.severity, "medium");
    assert.equal(checks.find((c) => c.name === "LOCKFILE")?.status, "fail");
    // With no .env.example the env check still passes.
    assert.equal(checks.find((c) => c.name === "ENV-FILE")?.status, "pass");
  });

  it("missing keys in .env produce one ENV-KEYS-MISSING finding per key, names only", () => {
    writeBasePackage(dir);
    writeFileSync(join(dir, "package-lock.json"), "{}\n", "utf8");
    writeFileSync(join(dir, ".env.example"), "API_KEY=\nDATABASE_URL=\nCACHE_TTL=\n", "utf8");
    writeFileSync(join(dir, ".env"), "API_KEY=super-secret-value\n", "utf8");
    const { report, checks } = runDoctor(dir);
    assert.equal(report.verdict, "ISSUES");
    const findings = report.findings.filter((f) => f.rule === "ENV-KEYS-MISSING");
    assert.equal(findings.length, 2);
    assert.ok(findings.every((f) => f.severity === "medium"));
    const named = findings.map((f) => f.message).join(" ");
    assert.ok(named.includes("DATABASE_URL"));
    assert.ok(named.includes("CACHE_TTL"));
    assert.ok(!named.includes("API_KEY is named"), "present keys are not reported missing");
    assert.equal(checks.find((c) => c.name === "ENV-FILE")?.status, "fail");
    const blob = JSON.stringify(report) + renderReport(report);
    assert.ok(!blob.includes("super-secret-value"), "env values must never be printed");
  });

  it("a node version outside engines fails NODE-VERSION at high", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0", engines: { node: ">=999" } }, null, 2) + "\n",
      "utf8",
    );
    writeFileSync(join(dir, "package-lock.json"), "{}\n", "utf8");
    const { report, checks } = runDoctor(dir);
    assert.equal(report.verdict, "ISSUES");
    const node = checks.find((c) => c.name === "NODE-VERSION");
    assert.equal(node?.status, "fail");
    const finding = report.findings.find((f) => f.rule === "NODE-VERSION");
    assert.ok(finding);
    assert.equal(finding.severity, "high");
  });

  it("an unsupported engines range warns with RANGE-UNSUPPORTED at info and stays HEALTHY when the rest passes", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0", engines: { node: "lts/*" } }, null, 2) + "\n",
      "utf8",
    );
    writeFileSync(join(dir, "package-lock.json"), "{}\n", "utf8");
    const { report, checks } = runDoctor(dir);
    const node = checks.find((c) => c.name === "NODE-VERSION");
    assert.equal(node?.status, "warn");
    const finding = report.findings.find((f) => f.rule === "RANGE-UNSUPPORTED");
    assert.ok(finding, "RANGE-UNSUPPORTED finding expected");
    assert.equal(finding.severity, "info");
    assert.equal(report.verdict, "HEALTHY");
    assert.equal(report.counts["checksPassed"], 4);
    assert.equal(report.counts["checksFailed"], 0);
  });

  it("no package.json skips the node check with NO-PACKAGE-JSON and the rest still run", () => {
    const { report, checks } = runDoctor(dir);
    const finding = report.findings.find((f) => f.rule === "NO-PACKAGE-JSON");
    assert.ok(finding, "NO-PACKAGE-JSON finding expected");
    assert.equal(finding.severity, "info");
    assert.equal(checks.find((c) => c.name === "NODE-VERSION")?.status, "skip");
    assert.equal(checks.find((c) => c.name === "GIT-PRESENT")?.status, "pass");
    assert.equal(checks.find((c) => c.name === "NPM-PRESENT")?.status, "pass");
    assert.equal(checks.length, 5);
    // The empty dir also has no lockfile, so the verdict is ISSUES.
    assert.equal(report.verdict, "ISSUES");
  });

  it("runCheck returns the same report as runDoctor", () => {
    writeHealthy(dir);
    assert.deepEqual(runCheck(dir), runDoctor(dir).report);
  });

  it("renderReport prints every check", () => {
    writeHealthy(dir);
    const { report, checks } = runDoctor(dir);
    const text = renderReport(report);
    for (const c of checks) assert.ok(text.includes(c.name), `render should mention ${c.name}`);
    assert.ok(text.includes("HEALTHY"));
  });

  it("a missing target throws a clear error", () => {
    const missing = join(dir, "does-not-exist");
    assert.throws(() => runCheck(missing), /target does not exist or is not a directory/);
  });
});
