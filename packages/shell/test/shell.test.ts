/**
 * Shell-side tests — SPEC.md Appendix A items 23–25, plus a CLI smoke test.
 *
 * Items 23–25 are Shell-side and therefore invisible to the harness-facing
 * conformance CLI. They are covered here instead: the rendering and interaction
 * policy are pure functions precisely so they can be tested without a harness,
 * and item 25's mechanism (rebuilding state from `snapshot`) is exercised
 * against the mock harness.
 *
 * Run: node --test packages/shell/test/
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { AriClient, type ApprovalOption, type AriEvent, type QuestionSpec } from "../../ari/src/index.ts";
import { buildAnswers, chooseDecision, DEFAULT_DECISIONS, offeredDecisions, parseDecision } from "../src/policy.ts";
import { renderEvent } from "../src/render.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const SHELL = path.join(root, "packages/shell/src/main.ts");
const MOCK = path.join(root, "packages/mock-harness/src/main.ts");

// ── item 23: ignore unknown event types, fields and capability keys ─────

test("an unknown event type is ignored, not fatal (item 23)", () => {
  const unknown = {
    sessionId: "s_1",
    seq: 1,
    type: "x-vendor/something-new",
    payloadWeHaveNeverSeen: { deeply: ["nested"] },
  } as unknown as AriEvent;

  const rendered = renderEvent(unknown);
  assert.ok(rendered.kind === "line" || rendered.kind === "none", "must not throw or stream garbage");

  // A completely unknown non-extension type is silent.
  const alien = { sessionId: "s_1", seq: 2, type: "totally/unknown" } as unknown as AriEvent;
  assert.equal(renderEvent(alien).kind, "none");
});

test("every event type in the catalogue renders without throwing", () => {
  const samples: AriEvent[] = [
    { sessionId: "s", seq: 1, type: "session/status", status: "running" },
    { sessionId: "s", seq: 2, type: "turn/started", turn: 1, messageIds: ["m_1"] },
    { sessionId: "s", seq: 3, type: "turn/completed", turn: 1, stopReason: "end_turn" },
    { sessionId: "s", seq: 4, type: "message/delta", turn: 1, text: "hi" },
    { sessionId: "s", seq: 5, type: "reasoning/delta", turn: 1, text: "thinking" },
    { sessionId: "s", seq: 6, type: "tool/started", turn: 1, callId: "t_1", name: "shell" },
    { sessionId: "s", seq: 7, type: "tool/updated", callId: "t_1", status: "running" },
    { sessionId: "s", seq: 8, type: "tool/completed", callId: "t_1", status: "success" },
    { sessionId: "s", seq: 9, type: "approval/requested", approvalId: "ap_1" },
    { sessionId: "s", seq: 10, type: "approval/resolved", approvalId: "ap_1", decision: "allow_once" },
    { sessionId: "s", seq: 11, type: "question/requested", questionId: "q_1", questions: [] },
    { sessionId: "s", seq: 12, type: "question/resolved", questionId: "q_1", outcome: "answered" },
    { sessionId: "s", seq: 13, type: "usage/updated", usage: { inputTokens: 1, outputTokens: 2 } },
    { sessionId: "s", seq: 14, type: "compaction/performed", trigger: "auto" },
    { sessionId: "s", seq: 15, type: "file/changed", path: "a.txt", kind: "modify" },
    { sessionId: "s", seq: 16, type: "subagent/started" },
    { sessionId: "s", seq: 17, type: "subagent/finished", status: "success" },
    { sessionId: "s", seq: 18, type: "background/started", taskId: "bg_1" },
    { sessionId: "s", seq: 19, type: "background/updated", taskId: "bg_1", status: "running" },
    { sessionId: "s", seq: 20, type: "background/finished", taskId: "bg_1", status: "success" },
    { sessionId: "s", seq: 21, type: "session/error", error: { code: -32000, message: "boom" } },
  ];

  for (const event of samples) {
    const rendered = renderEvent(event);
    assert.ok(
      rendered.kind === "stream" || rendered.kind === "line" || rendered.kind === "none",
      `${event.type} produced an invalid render`,
    );
  }
  assert.equal(samples.length, 21, "the sample list must cover all 21 events");
});

test("unknown fields on a known event do not break rendering (item 23)", () => {
  const withExtras = {
    sessionId: "s",
    seq: 1,
    type: "message/delta",
    text: "hello",
    fieldFromTheFuture: 42,
    _meta: { vendor: true },
  } as unknown as AriEvent;
  assert.deepEqual(renderEvent(withExtras), { kind: "stream", text: "hello", stream: "message" });
});

test("reasoning and the answer are distinct streams", () => {
  const reasoning = renderEvent({
    sessionId: "s",
    seq: 1,
    type: "reasoning/delta",
    text: "thinking",
  } as unknown as AriEvent);
  const answer = renderEvent({
    sessionId: "s",
    seq: 2,
    type: "message/delta",
    text: "hello",
  } as unknown as AriEvent);

  assert.deepEqual(reasoning, { kind: "stream", text: "thinking", stream: "reasoning" });
  assert.deepEqual(answer, { kind: "stream", text: "hello", stream: "message" });

  // With reasoning hidden, the delta renders as nothing at all.
  assert.equal(
    renderEvent({ sessionId: "s", seq: 3, type: "reasoning/delta", text: "x" } as unknown as AriEvent, {
      showReasoning: false,
      showStatus: false,
    }).kind,
    "none",
  );
});

// ── item 24: never send a decision that was not offered ────────────────

const LIMITED: ApprovalOption[] = [
  { id: "allow_once", label: "Once" },
  { id: "deny", label: "No" },
];

test("a decision outside the offered options is never chosen (item 24)", () => {
  for (const preference of ["allow", "deny"] as const) {
    const decision = chooseDecision(LIMITED, preference);
    assert.ok(decision, "a decision must be chosen");
    assert.ok(
      LIMITED.some((option) => option.id === decision),
      `chose ${decision}, which was not offered`,
    );
  }
  // allow_always is not offered, so "allow" must fall back to allow_once.
  assert.equal(chooseDecision(LIMITED, "allow"), "allow_once");
  assert.equal(chooseDecision(LIMITED, "deny"), "deny");
});

test("with no options offered, the three ARI defaults apply (item 24)", () => {
  assert.deepEqual(offeredDecisions(undefined), [...DEFAULT_DECISIONS]);
  assert.deepEqual(offeredDecisions([]), [...DEFAULT_DECISIONS]);
  assert.equal(chooseDecision(undefined, "allow"), "allow_once");
  assert.equal(chooseDecision(undefined, "deny"), "deny");
});

test("parseDecision refuses anything not offered (item 24)", () => {
  assert.equal(parseDecision("y", LIMITED), "allow_once");
  assert.equal(parseDecision("n", LIMITED), "deny");
  assert.equal(parseDecision("deny", LIMITED), "deny");
  // allow_always was not offered: the literal must be refused, and "y" must
  // still resolve to something that *was* offered.
  assert.equal(parseDecision("allow_always", LIMITED), undefined);
  assert.notEqual(parseDecision("y", LIMITED), "allow_always");
  assert.equal(parseDecision("garbage", LIMITED), undefined);
  assert.equal(parseDecision("", LIMITED), undefined);
});

test("a harness offering only a denial path is respected", () => {
  const denyOnly: ApprovalOption[] = [{ id: "deny", label: "No" }];
  assert.equal(chooseDecision(denyOnly, "allow"), "deny", "the only offered option is chosen");
  assert.equal(parseDecision("y", denyOnly), "deny");
});

// ── questions (§10.2) ──────────────────────────────────────────────────

test("an empty answer is an explicit decline, and offered labels are matched", () => {
  const questions: QuestionSpec[] = [
    { id: "which", question: "Which?", options: [{ id: "a", label: "a.txt" }, { id: "b", label: "b.md" }] },
  ];
  assert.deepEqual(buildAnswers(questions, ""), [], "empty input declines");
  assert.deepEqual(buildAnswers(questions, "a"), [{ id: "which", values: ["a"] }]);
  assert.deepEqual(buildAnswers(questions, "a.txt"), [{ id: "which", values: ["a"] }], "label matches");
  assert.deepEqual(buildAnswers(questions, "something else"), [{ id: "which", values: ["something else"] }]);
});

// ── item 25: rebuild state after a disconnect ──────────────────────────

test("resume restores a pending interaction from snapshot (item 25)", async () => {
  const client = AriClient.spawn({ command: "node", args: [MOCK], onStderr: () => undefined });
  // Collect from the start: once an approval is answered the harness continues
  // immediately, so a listener registered afterwards would miss the settlement.
  const events: AriEvent[] = [];
  client.onEvent((event) => events.push(event));
  const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${label}; saw ${events.map((e) => e.type).join(",")}`);
  };

  try {
    await client.initialize();
    const { sessionId } = await client.newSession();
    await client.prompt(sessionId, "approve");

    await waitFor(() => events.some((event) => event.type === "approval/requested"), "approval/requested");
    assert.equal(client.getSession(sessionId)?.pendingApprovals.size, 1, "the approval is pending on the client");

    // This is the mechanism item 25 depends on: a Shell that lost its state
    // rebuilds it from the replay response's snapshot.
    const resumed = await client.resumeSession({ sessionId });
    assert.ok(resumed.snapshot, "resume must return a snapshot");
    assert.equal(
      resumed.snapshot?.pendingApprovals.length,
      1,
      "the pending approval must be in the snapshot, not lost",
    );
    const approvalId = resumed.snapshot?.pendingApprovals[0]?.approvalId;
    assert.ok(approvalId, "the snapshot must carry the approvalId");

    // And it must still be answerable with the id the snapshot gave us.
    await client.respondApproval({ sessionId, approvalId, decision: "allow_once" });
    await waitFor(() => events.some((event) => event.type === "turn/completed"), "turn/completed");

    assert.equal(
      (events.find((event) => event.type === "approval/resolved") as unknown as { decision: string })?.decision,
      "allow_once",
    );
    assert.deepEqual(client.gaps, [], "the resumed stream must stay dense");
  } finally {
    client.close();
  }
});

// ── the CLI itself ─────────────────────────────────────────────────────

interface RunResult {
  code: number;
  stdout: string;
}

function runShell(args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("node", [SHELL, ...args], { cwd: root });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", () => undefined);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout }));
  });
}

test("the shell drives the mock harness without knowing what it is", async () => {
  const { code, stdout } = await runShell(["--prompt", "tool ls -la", "--", "node", MOCK]);

  assert.equal(code, 0, "a one-shot run must exit cleanly");
  assert.match(stdout, /connected to MockHarness/, "the shell reports what it connected to");
  assert.match(stdout, /⚙ shell/, "the tool call is rendered");
  assert.match(stdout, /✓/, "the tool result is rendered");
  assert.match(stdout, /ran: ls -la/, "the tool output reaches the user");
});

test("the shell answers an approval under an automatic policy", async () => {
  const { code, stdout } = await runShell(["--policy", "allow", "--prompt", "approve", "--", "node", MOCK]);
  assert.equal(code, 0);
  assert.match(stdout, /approval required/);
  assert.match(stdout, /approval allow_once/, "the shell resolved it without a human");
  assert.match(stdout, /decision=allow_once/, "the harness saw the decision");
});

test("the shell reports a harness that cannot be started", async () => {
  const { code } = await runShell(["--prompt", "hi", "--", "node", "-e", "process.exit(0)"]);
  assert.equal(code, 1, "an unusable harness must produce a non-zero exit");
});
