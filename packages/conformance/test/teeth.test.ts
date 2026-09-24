/**
 * "Teeth" tests: proof that the conformance suite actually detects violations.
 *
 * A conformance suite that passes everything is worthless, so each of these
 * drives a deliberately non-conformant harness (test/broken-harness.ts, which
 * speaks NDJSON by hand precisely so it can break the rules) and asserts that
 * the corresponding check fails.
 *
 * Run: node --test packages/conformance/test/
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const CONFORMANCE = path.join(root, "packages/conformance/src/main.ts");
const BROKEN = path.join(root, "packages/conformance/test/broken-harness.ts");
const MOCK = path.join(root, "packages/mock-harness/src/main.ts");

interface Outcome {
  id: string;
  status: "pass" | "fail" | "skip";
  detail?: string;
}

function runConformance(args: readonly string[]): { code: number; outcomes: Outcome[]; text: string } {
  const result = spawnSync("node", [CONFORMANCE, "--json", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
  });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  let outcomes: Outcome[] = [];
  try {
    outcomes = (JSON.parse(result.stdout ?? "{}") as { outcomes?: Outcome[] }).outcomes ?? [];
  } catch {
    outcomes = [];
  }
  return { code: result.status ?? -1, outcomes, text };
}

function outcomeOf(outcomes: readonly Outcome[], id: string): Outcome | undefined {
  return outcomes.find((outcome) => outcome.id === id);
}

// ── the suite must accept a conformant harness ──────────────────────────

test("the mock harness passes every runnable check", () => {
  const { code, outcomes, text } = runConformance([
    "--prompt",
    "hello",
    "--probe-approval",
    "approve",
    "--probe-question",
    "question",
    "--probe-slow",
    "slow 8000",
    "--probe-error",
    "throw",
    "--queue-limit",
    "3",
    "--",
    "node",
    MOCK,
    "--queue-limit=3",
  ]);

  const failed = outcomes.filter((outcome) => outcome.status === "fail");
  assert.deepEqual(failed, [], `the mock harness must pass; failures: ${JSON.stringify(failed)}\n${text}`);
  assert.equal(code, 0, "a conformant harness must exit 0");
  assert.ok(outcomes.length >= 24, `expected at least 24 checks, got ${outcomes.length}`);
});

// ── the suite must reject a non-conformant harness ──────────────────────

const VIOLATIONS: ReadonlyArray<{ violate: string; check: string; extra?: string[] }> = [
  { violate: "gap", check: "C06" },
  { violate: "no-messageids", check: "C07" },
  { violate: "double-settle", check: "C08" },
  { violate: "gated", check: "C12" },
  { violate: "late-receipt", check: "C14" },
  { violate: "never-idle", check: "C22" },
  { violate: "stdout-noise", check: "C21" },
  { violate: "oversized", check: "C21" },
  { violate: "bad-error-order", check: "C09", extra: ["--probe-error", "anything"] },
];

for (const { violate, check, extra } of VIOLATIONS) {
  test(`the suite catches "${violate}" (${check})`, () => {
    const { code, outcomes, text } = runConformance([
      "--only",
      check,
      ...(extra ?? []),
      "--",
      "node",
      BROKEN,
      `--violate=${violate}`,
    ]);

    assert.equal(code, 1, `a non-conformant harness must exit 1\n${text}`);
    const outcome = outcomeOf(outcomes, check);
    assert.ok(outcome, `${check} must have run\n${text}`);
    assert.equal(
      outcome.status,
      "fail",
      `${check} must fail for violation "${violate}", got ${outcome.status}: ${outcome.detail ?? ""}\n${text}`,
    );
  });
}

// ── the suite must not fail a harness for something it cannot provoke ───

test("probe-dependent checks are skipped, not failed, without probes", () => {
  const { code, outcomes } = runConformance(["--only", "C09,C10,C11,C15,C17", "--", "node", MOCK]);
  assert.equal(code, 0, "missing probes must not be reported as failures");
  for (const id of ["C09", "C10", "C11", "C15", "C17"]) {
    assert.equal(outcomeOf(outcomes, id)?.status, "skip", `${id} must be skipped`);
  }
});

test("a harness that never completes a handshake is reported, not crashed on", () => {
  const { code, text } = runConformance(["--", "node", "-e", "process.exit(0)"]);
  assert.equal(code, 1, "an unusable harness must exit 1");
  assert.match(text, /initialize/, "the failure must name the handshake");
});
