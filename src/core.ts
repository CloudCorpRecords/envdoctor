/**
 * envdoctor core: check a machine environment against a repo's stated
 * requirements.
 *
 * Checks (v0.1):
 * - NODE-VERSION: process.version against package.json engines.node.
 * - GIT-PRESENT: git --version succeeds.
 * - NPM-PRESENT: npm --version succeeds.
 * - LOCKFILE: a package manager lockfile exists at the target.
 * - ENV-FILE: when .env.example exists, .env exists and names every key
 *   the example names.
 *
 * Env values are never read into any output. The .env and .env.example
 * files are read as text only so the key NAMES (the text left of the
 * first = on each line) can be extracted. Values are discarded at parse
 * time and never stored, returned, or printed. See parseEnvExample.
 *
 * Disk space is out of scope. Port and service checks are out of scope
 * for v0.1.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Finding, Report, Severity } from "./types.js";

export const VERSION = "0.1.0";
export const CLEAN_VERDICT = "HEALTHY";
export const ISSUES_VERDICT = "ISSUES";

/* ------------------------------------------------------------------ */
/* Public check result shape (returned by runDoctor)                   */
/* ------------------------------------------------------------------ */

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  fix: string;
}

export interface DoctorResult {
  report: Report;
  checks: CheckResult[];
}

/* ------------------------------------------------------------------ */
/* Version parsing and range matching                                  */
/* ------------------------------------------------------------------ */

interface PartialVersion {
  parts: number[];
  /** How many numeric components were written (1 to 3). */
  written: number;
  /** True when an x, X, or * component ended the version. */
  wildcard: boolean;
}

function parsePartialVersion(raw: string): PartialVersion | null {
  let text = raw.trim();
  if (text.startsWith("v") || text.startsWith("V")) text = text.slice(1);
  if (!text) return null;
  // Strip any prerelease or build suffix; ranges here do not use them.
  text = text.split("-")[0]?.split("+")[0] ?? "";
  if (!text) return null;
  const segments = text.split(".");
  if (segments.length > 3) return null;
  const parts: number[] = [];
  let wildcard = false;
  for (const seg of segments) {
    if (seg === "x" || seg === "X" || seg === "*") {
      wildcard = true;
      break;
    }
    if (!/^\d+$/.test(seg)) return null;
    parts.push(Number(seg));
  }
  if (parts.length === 0 && !wildcard) return null;
  return { parts, written: parts.length, wildcard };
}

function parseCurrentVersion(raw: string): [number, number, number] | null {
  const parsed = parsePartialVersion(raw);
  if (!parsed || parsed.wildcard) return null;
  return [parsed.parts[0] ?? 0, parsed.parts[1] ?? 0, parsed.parts[2] ?? 0];
}

function pad3(p: PartialVersion): [number, number, number] {
  return [p.parts[0] ?? 0, p.parts[1] ?? 0, p.parts[2] ?? 0];
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

type TokenOutcome = boolean | null;

function evalCaret(current: [number, number, number], body: string): TokenOutcome {
  const p = parsePartialVersion(body);
  if (!p || p.wildcard) return null;
  const lower = pad3(p);
  if (cmp(current, lower) < 0) return false;
  const major = lower[0];
  let upper: [number, number, number];
  if (major > 0) {
    upper = [major + 1, 0, 0];
  } else if (p.written <= 1) {
    upper = [1, 0, 0];
  } else if (lower[1] > 0) {
    upper = [0, lower[1] + 1, 0];
  } else if (p.written === 2) {
    upper = [0, 1, 0];
  } else {
    upper = [0, 0, lower[2] + 1];
  }
  return cmp(current, upper) < 0;
}

function evalTilde(current: [number, number, number], body: string): TokenOutcome {
  const p = parsePartialVersion(body);
  if (!p || p.wildcard) return null;
  const lower = pad3(p);
  if (cmp(current, lower) < 0) return false;
  const upper: [number, number, number] =
    p.written >= 2 ? [lower[0], lower[1] + 1, 0] : [lower[0] + 1, 0, 0];
  return cmp(current, upper) < 0;
}

function evalComparator(
  current: [number, number, number],
  op: string,
  body: string,
): TokenOutcome {
  const p = parsePartialVersion(body);
  if (!p) return null;
  const target = pad3(p);
  const c = cmp(current, target);
  switch (op) {
    case ">=":
      return c >= 0;
    case "<=":
      return c <= 0;
    case ">":
      return c > 0;
    case "<":
      return c < 0;
    case "=":
    case "==":
      return c === 0;
    default:
      return null;
  }
}

function evalToken(current: [number, number, number], token: string): TokenOutcome {
  if (token === "*" || token === "x" || token === "X") return true;
  if (token.startsWith("^")) return evalCaret(current, token.slice(1));
  if (token.startsWith("~")) return evalTilde(current, token.slice(1));
  const compMatch = /^(>=|<=|==|>|<|=)(.+)$/.exec(token);
  if (compMatch) return evalComparator(current, compMatch[1] as string, compMatch[2] as string);
  // x-ranges and plain versions: 20.x, 20.11.x, 20, 20.11, 20.11.0.
  const p = parsePartialVersion(token);
  if (!p) return null;
  if (p.wildcard || p.written < 3) {
    // Prefix match on the written numeric components.
    const prefix = pad3(p);
    for (let i = 0; i < p.written; i++) {
      if (current[i] !== prefix[i]) return false;
    }
    return true;
  }
  return cmp(current, pad3(p)) === 0;
}

/**
 * Compare a Node version against an engines.node range.
 *
 * Supported range syntax: comparators (>=, <=, >, <, =), caret ranges
 * (^20.0.0), tilde ranges (~20.11.0), exact versions (20.11.0), x-ranges
 * (20.x, 20.11.x, *), partial versions (20, 20.11), and space separated
 * conjunctions of those (for example ">=18 <21"), plus || alternation
 * between conjunctions. Anything else returns null, meaning the range
 * uses syntax envdoctor does not support.
 */
export function checkNodeVersion(current: string, range: string): boolean | null {
  const cur = parseCurrentVersion(current);
  if (!cur) return null;
  const text = range.trim().replace(/,/g, " ").replace(/(>=|<=|==|>|<|=|\^|~)\s+/g, "$1");
  if (!text) return null;
  if (/\s-\s/.test(text)) return null; // Hyphen ranges are not supported.
  const alternatives = text.split("||").map((s) => s.trim()).filter(Boolean);
  if (alternatives.length === 0) return null;
  let sawNull = false;
  for (const alt of alternatives) {
    const tokens = alt.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return null;
    let altResult: TokenOutcome = true;
    for (const token of tokens) {
      const outcome = evalToken(cur, token);
      if (outcome === null) {
        altResult = null;
        break;
      }
      if (outcome === false) altResult = false;
    }
    if (altResult === true) return true;
    if (altResult === null) sawNull = true;
  }
  return sawNull ? null : false;
}

/* ------------------------------------------------------------------ */
/* Env file parsing: key names only                                    */
/* ------------------------------------------------------------------ */

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Extract the key NAMES declared by an env file's text.
 *
 * Only the text left of the first = on each line is kept. Values are
 * never returned, stored, or printed anywhere in envdoctor. Comment
 * lines (starting with #), blank lines, and an optional leading
 * "export " prefix are handled. A line with no = contributes its whole
 * trimmed text as a key name when it looks like one. Names are returned
 * in file order with duplicates removed.
 */
export function parseEnvExample(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trimStart();
    const eq = line.indexOf("=");
    // Names only: everything from the first = onward is a value and is
    // discarded here, at parse time, and never used again.
    const key = (eq === -1 ? line : line.slice(0, eq)).trim();
    if (!ENV_KEY_RE.test(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(key);
  }
  return names;
}

/* ------------------------------------------------------------------ */
/* Checks                                                              */
/* ------------------------------------------------------------------ */

interface InternalCheck extends CheckResult {
  rule: string;
  severity: Severity;
}

function tryToolVersion(command: string, args: string[]): string | null {
  try {
    const out = execFileSync(command, args, {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const line = out.split(/\r?\n/)[0]?.trim() ?? "";
    return line || "available";
  } catch {
    return null;
  }
}

function checkNode(root: string): InternalCheck {
  const name = "NODE-VERSION";
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) {
    return {
      name,
      status: "skip",
      detail: `no package.json at target, so the required Node version is unknown (running ${process.version})`,
      fix: "add a package.json with an engines.node range if this repo needs a specific Node version",
      rule: "NO-PACKAGE-JSON",
      severity: "info",
    };
  }
  let pkg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("top level is not an object");
    }
    pkg = parsed as Record<string, unknown>;
  } catch (err) {
    return {
      name,
      status: "fail",
      detail: `package.json is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
      fix: "fix package.json so it parses as JSON",
      rule: "PACKAGE-JSON-INVALID",
      severity: "high",
    };
  }
  const engines = pkg["engines"];
  const range =
    typeof engines === "object" && engines !== null && !Array.isArray(engines)
      ? (engines as Record<string, unknown>)["node"]
      : undefined;
  if (typeof range !== "string" || !range.trim()) {
    return {
      name,
      status: "skip",
      detail: `package.json declares no engines.node range (running ${process.version})`,
      fix: "add an engines.node range to package.json so the required Node version is stated",
      rule: "NO-ENGINES",
      severity: "info",
    };
  }
  const outcome = checkNodeVersion(process.version, range);
  if (outcome === null) {
    return {
      name,
      status: "warn",
      detail: `engines.node range "${range}" uses syntax envdoctor does not support, so node ${process.version} was not compared against it`,
      fix: "use a supported engines.node range: >=, ^, ~, an exact version, or an x-range such as 20.x",
      rule: "RANGE-UNSUPPORTED",
      severity: "info",
    };
  }
  if (outcome) {
    return {
      name,
      status: "pass",
      detail: `node ${process.version} satisfies engines.node "${range}"`,
      fix: "",
      rule: "CHECK-PASS",
      severity: "info",
    };
  }
  return {
    name,
    status: "fail",
    detail: `node ${process.version} does not satisfy engines.node "${range}"`,
    fix: `install or switch to a Node version matching "${range}" (for example with nvm or fnm)`,
    rule: "NODE-VERSION",
    severity: "high",
  };
}

function checkGit(): InternalCheck {
  const version = tryToolVersion("git", ["--version"]);
  if (version !== null) {
    return {
      name: "GIT-PRESENT",
      status: "pass",
      detail: version,
      fix: "",
      rule: "CHECK-PASS",
      severity: "info",
    };
  }
  return {
    name: "GIT-PRESENT",
    status: "fail",
    detail: "git --version failed, so git is missing or not on PATH",
    fix: "install git and make sure it is on PATH",
    rule: "GIT-MISSING",
    severity: "medium",
  };
}

function checkNpm(): InternalCheck {
  const version = tryToolVersion("npm", ["--version"]);
  if (version !== null) {
    return {
      name: "NPM-PRESENT",
      status: "pass",
      detail: `npm ${version} available`,
      fix: "",
      rule: "CHECK-PASS",
      severity: "info",
    };
  }
  return {
    name: "NPM-PRESENT",
    status: "fail",
    detail: "npm --version failed, so npm is missing or not on PATH",
    fix: "install npm (it ships with Node) and make sure it is on PATH",
    rule: "NPM-MISSING",
    severity: "medium",
  };
}

const LOCKFILES = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"] as const;

function checkLockfile(root: string): InternalCheck {
  const found = LOCKFILES.filter((f) => existsSync(join(root, f)));
  if (found.length > 0) {
    return {
      name: "LOCKFILE",
      status: "pass",
      detail: `found ${found.join(", ")}`,
      fix: "",
      rule: "CHECK-PASS",
      severity: "info",
    };
  }
  return {
    name: "LOCKFILE",
    status: "fail",
    detail: `no lockfile found (looked for ${LOCKFILES.join(", ")})`,
    fix: "run your package manager install (npm install, yarn install, or pnpm install) to generate a lockfile and commit it",
    rule: "NO-LOCKFILE",
    severity: "medium",
  };
}

function checkEnvFile(root: string): { check: InternalCheck; extraFindings: Finding[] } {
  const name = "ENV-FILE";
  const examplePath = join(root, ".env.example");
  if (!existsSync(examplePath)) {
    return {
      check: {
        name,
        status: "pass",
        detail: "no .env.example at target, so no .env file is required",
        fix: "",
        rule: "CHECK-PASS",
        severity: "info",
      },
      extraFindings: [],
    };
  }
  // Names only: both files are parsed with parseEnvExample, which keeps
  // only the text left of the first = on each line. Values from .env
  // and .env.example are discarded at parse time and never appear in
  // any check, finding, report, or output.
  const exampleKeys = parseEnvExample(readFileSync(examplePath, "utf8"));
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) {
    return {
      check: {
        name,
        status: "fail",
        detail: `.env.example declares ${exampleKeys.length} key(s) but .env is missing`,
        fix: "copy .env.example to .env and fill values",
        rule: "ENV-MISSING",
        severity: "medium",
      },
      extraFindings: [],
    };
  }
  const envKeys = new Set(parseEnvExample(readFileSync(envPath, "utf8")));
  const missing = exampleKeys.filter((k) => !envKeys.has(k));
  if (missing.length === 0) {
    return {
      check: {
        name,
        status: "pass",
        detail: `.env names all ${exampleKeys.length} key(s) declared in .env.example (key names only compared)`,
        fix: "",
        rule: "CHECK-PASS",
        severity: "info",
      },
      extraFindings: [],
    };
  }
  // One finding per missing key, so a large example produces a large,
  // complete report instead of one truncated line. Each finding names
  // exactly one key; no value is ever included.
  const extraFindings: Finding[] = missing.map((key) => ({
    rule: "ENV-KEYS-MISSING",
    severity: "medium" as Severity,
    message: `ENV-FILE: key ${key} is named in .env.example but missing from .env. Fix: add ${key} to .env and fill its value`,
  }));
  return {
    check: {
      name,
      status: "fail",
      detail: `${missing.length} of ${exampleKeys.length} key(s) named in .env.example are missing from .env: ${missing.join(", ")}`,
      fix: "add the missing key names to .env and fill values",
      rule: "ENV-KEYS-MISSING",
      severity: "medium",
    },
    extraFindings,
  };
}

/* ------------------------------------------------------------------ */
/* Doctor                                                              */
/* ------------------------------------------------------------------ */

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };

/**
 * Run every check against a target directory and return both the fixed
 * Report shape and the richer per-check list. Throws a clear Error when
 * the target does not exist or is not a directory.
 */
export function runDoctor(target: string): DoctorResult {
  const root = resolve(target);
  let isDir = false;
  try {
    isDir = statSync(root).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw new Error(`target does not exist or is not a directory: ${target}`);
  }

  const envResult = checkEnvFile(root);
  const internal: InternalCheck[] = [
    checkNode(root),
    checkGit(),
    checkNpm(),
    checkLockfile(root),
    envResult.check,
  ];
  const checks: CheckResult[] = internal.map(({ name, status, detail, fix }) => ({
    name,
    status,
    detail,
    fix,
  }));

  const findings: Finding[] = [];
  for (const c of internal) {
    if (c.status === "fail" && c.rule === "ENV-KEYS-MISSING") {
      // Represented by the per-key findings below; a summary finding
      // would only duplicate the first of them.
      continue;
    }
    const fixSuffix = c.fix && c.status !== "pass" ? ` Fix: ${c.fix}` : "";
    findings.push({
      rule: c.rule,
      severity: c.severity,
      message: `${c.name}: ${c.detail}${fixSuffix}`,
    });
  }
  findings.push(...envResult.extraFindings);
  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0) ||
      (a.message < b.message ? -1 : a.message > b.message ? 1 : 0),
  );

  const checksRun = checks.length;
  const checksPassed = checks.filter((c) => c.status === "pass").length;
  const checksFailed = checks.filter((c) => c.status === "fail").length;
  const checksWarned = checks.filter((c) => c.status === "warn").length;
  const checksSkipped = checks.filter((c) => c.status === "skip").length;

  const bySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) bySeverity[f.severity] += 1;

  const verdict = bySeverity.medium > 0 || bySeverity.high > 0 ? ISSUES_VERDICT : CLEAN_VERDICT;

  const counts: Record<string, number> = {
    checksRun,
    checksPassed,
    checksFailed,
    checksWarned,
    checksSkipped,
    findings: findings.length,
    high: bySeverity.high,
    medium: bySeverity.medium,
    low: bySeverity.low,
    info: bySeverity.info,
  };

  const checkList = checks.map((c) => `${c.name} ${c.status}`).join(", ");
  const summary =
    `${checksRun} check(s) run (${checkList}): ${checksPassed} passed, ${checksFailed} failed, ` +
    `${checksWarned} warned, ${checksSkipped} skipped. ${findings.length} finding(s) ` +
    `(${bySeverity.high} high, ${bySeverity.medium} medium, ${bySeverity.low} low, ${bySeverity.info} info). ` +
    (verdict === CLEAN_VERDICT
      ? "No medium or high findings, so the environment is healthy for this repo."
      : "Medium or high findings need attention before this environment matches the repo.");

  const report: Report = {
    tool: "envdoctor",
    version: VERSION,
    target,
    verdict,
    counts,
    findings,
    summary,
  };
  return { report, checks };
}

/** Run the checks and return only the fixed Report shape. */
export function runCheck(target: string): Report {
  return runDoctor(target).report;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

export function renderReport(report: Report): string {
  const out: string[] = [];
  out.push(`envdoctor check ${report.target}: ${report.verdict}`);
  out.push(
    `  checks: ${report.counts["checksRun"] ?? 0} run, ${report.counts["checksPassed"] ?? 0} passed, ${report.counts["checksFailed"] ?? 0} failed, ` +
      `findings: ${report.counts["findings"] ?? 0} (high: ${report.counts["high"] ?? 0}, medium: ${report.counts["medium"] ?? 0}, low: ${report.counts["low"] ?? 0}, info: ${report.counts["info"] ?? 0})`,
  );
  out.push(`  summary: ${report.summary}`);
  for (const f of report.findings) {
    const where = f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : "";
    const evidence = f.evidence ? ` (evidence: ${f.evidence})` : "";
    out.push(`  [${f.severity.toUpperCase()}] ${f.rule}${where ? ` ${where}` : ""} ${f.message}${evidence}`);
  }
  if (report.verdict === CLEAN_VERDICT) {
    out.push("HEALTHY: no medium or high findings. Every check passed, was skipped for a stated reason, or only raised an info note.");
  } else {
    out.push("ISSUES: at least one medium or high finding. Apply the fix named in each finding and run envdoctor again.");
  }
  return out.join("\n");
}
