/**
 * MockHarness — a minimal, deterministic ARI 1.0 harness.
 *
 * This is the "SimpleAgent" that SPEC Appendix A and report D8 talk about: it
 * has no ledger beyond the helper's replay buffer, no compaction, no subagents,
 * no model. It exists to prove two things:
 *
 *   1. a conformant harness is small — this file plus the helper is the whole
 *      implementation, and the helper carries the invariants;
 *   2. the conformance suite and the reference shell have a stable, offline
 *      target that can be driven into every interesting path.
 *
 * Behaviour is **keyword-driven**, so tests can exercise any path by choosing the
 * prompt text — no side channel, no fixtures, no LLM:
 *
 *   echo <text>       reply with <text>
 *   reasoning <text>  reasoning/delta then a reply
 *   tool <cmd>        one tool call: started → updated → completed
 *   toolerror <cmd>   one tool call that ends in error
 *   dangling          leave a tool open and return (helper must close it)
 *   chunks <n>        stream n tool-output chunks (stays under the 1 MiB cap)
 *   oversized         emit a single event above 1 MiB (must be refused)
 *   approve           request an approval and report the decision
 *   approve-limited   request an approval offering only allow_once | deny
 *   question          ask a question and report the outcome
 *   slow [ms]         sleep until cancelled (default 10000 ms)
 *   error             emit a retryable session/error, then continue
 *   throw             throw from the delegate
 *   fail              call ctx.fail()
 *   usage             emit usage/updated
 *   file <path>       emit file/changed
 *   subagent          emit subagent/started + subagent/finished
 *   background        emit background/started + updated + finished
 *   compact           emit compaction/performed
 *   (anything else)   echo the text back
 *
 * Usage:
 *   node packages/mock-harness/src/main.ts [--minimal] [--caps=k:v,k:v]
 *
 *   --minimal      declare every capability false (report D8's minimal agent)
 *   --caps=k:v     start from all-true and override, e.g. --caps=reasoning:false
 *   --caps-off=k   start from all-false and enable, e.g. --caps-off=question
 */

import { AriHarness, type HarnessDelegate, type TurnContext } from "../../ari/src/index.ts";
import {
  ALL_CAPABILITIES,
  NO_CAPABILITIES,
  type AgentCapabilities,
  type CapabilityKey,
  type StopReason,
} from "../../ari/src/index.ts";

// ── options ─────────────────────────────────────────────────────────────

interface MockOptions {
  capabilities: AgentCapabilities;
}

function parseArgs(argv: readonly string[]): MockOptions {
  let capabilities: AgentCapabilities = { ...ALL_CAPABILITIES };

  for (const arg of argv) {
    if (arg === "--minimal") {
      capabilities = { ...NO_CAPABILITIES };
      continue;
    }
    if (arg.startsWith("--caps-off=")) {
      capabilities = { ...NO_CAPABILITIES };
      for (const entry of arg.slice("--caps-off=".length).split(",")) {
        const key = entry.trim() as CapabilityKey;
        if (key in capabilities) capabilities[key] = true;
      }
      continue;
    }
    if (arg.startsWith("--caps=")) {
      for (const entry of arg.slice("--caps=".length).split(",")) {
        const [rawKey, rawValue] = entry.split(":");
        const key = (rawKey ?? "").trim() as CapabilityKey;
        if (!(key in capabilities)) continue;
        capabilities[key] = (rawValue ?? "").trim() !== "false";
      }
      continue;
    }
  }

  return { capabilities };
}

// ── helpers ─────────────────────────────────────────────────────────────

function log(message: string): void {
  // stdout is reserved for ARI frames (SPEC §4.1): everything else goes to stderr.
  process.stderr.write(`[mock-harness] ${message}\n`);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The mock keeps just enough history for `session/fork` to mean something. */
interface TranscriptEntry {
  turn: number;
  prompt: string;
  reply: string;
}

const transcripts = new Map<string, TranscriptEntry[]>();

function promptText(ctx: TurnContext): string {
  return ctx.messages
    .flatMap((message) => message.content.map((block) => block.text))
    .join("\n")
    .trim();
}

// ── the delegate ────────────────────────────────────────────────────────

const delegate: HarnessDelegate = {
  onFork({ sourceSessionId, newSessionId, atTurn }) {
    const source = transcripts.get(sourceSessionId) ?? [];
    transcripts.set(
      newSessionId,
      source.filter((entry) => entry.turn <= atTurn),
    );
    log(`forked ${sourceSessionId} at turn ${atTurn} into ${newSessionId}`);
  },

  async handleTurn(ctx: TurnContext): Promise<StopReason> {
    const text = promptText(ctx);
    const [command = "", ...rest] = text.split(/\s+/);
    const arg = rest.join(" ");
    let reply = "";

    switch (command) {
      case "echo":
        reply = arg;
        ctx.messageDelta(reply);
        break;

      case "reasoning":
        ctx.reasoningDelta(`considering: ${arg}`);
        reply = arg;
        ctx.messageDelta(reply);
        break;

      case "tool": {
        const callId = ctx.toolStarted({ name: "shell", input: { command: arg || "ls" } });
        ctx.toolUpdated({ callId, status: "running", title: "running", outputDelta: "partial…" });
        ctx.toolCompleted({ callId, status: "success", output: `ran: ${arg || "ls"}` });
        reply = "tool finished";
        ctx.messageDelta(reply);
        break;
      }

      case "toolerror": {
        const callId = ctx.toolStarted({ name: "shell", input: { command: arg || "false" } });
        ctx.toolCompleted({ callId, status: "error", output: "exit 1" });
        reply = "tool failed";
        ctx.messageDelta(reply);
        break;
      }

      case "dangling": {
        // Deliberately leave a tool open: the helper must close it before the
        // turn settles, so the stream stays consistent (SPEC §9.2).
        ctx.toolStarted({ name: "leaky" });
        reply = "leaving a tool open";
        ctx.messageDelta(reply);
        break;
      }

      case "chunks": {
        const count = Math.max(1, Number(arg) || 3);
        const callId = ctx.toolStarted({ name: "shell", input: { command: "yes" } });
        for (let i = 0; i < count; i += 1) {
          ctx.toolUpdated({ callId, status: "running", outputDelta: `chunk-${i};`.repeat(64) });
        }
        ctx.toolCompleted({ callId, status: "success", output: `${count} chunks streamed` });
        reply = "streamed";
        ctx.messageDelta(reply);
        break;
      }

      case "oversized": {
        // One event above the 1 MiB frame cap: the helper must refuse it rather
        // than put an unframeable line on the wire (SPEC §4.2).
        const callId = ctx.toolStarted({ name: "shell" });
        ctx.toolCompleted({ callId, status: "success", output: "x".repeat(1_100_000) });
        reply = "unreachable";
        break;
      }

      case "approve": {
        const decision = await ctx.requestApproval({
          toolName: "shell",
          reason: "command matches a destructive pattern",
        });
        reply = `decision=${decision}`;
        ctx.messageDelta(reply);
        break;
      }

      case "approve-limited": {
        const decision = await ctx.requestApproval({
          toolName: "shell",
          options: [
            { id: "allow_once", label: "Allow once" },
            { id: "deny", label: "Deny" },
          ],
        });
        reply = `decision=${decision}`;
        ctx.messageDelta(reply);
        break;
      }

      case "question": {
        const answered = await ctx.requestQuestion({
          questions: [
            {
              id: "which",
              question: "Which file should I touch?",
              options: [
                { id: "a", label: "a.txt" },
                { id: "b", label: "b.md" },
              ],
            },
          ],
        });
        reply = `outcome=${answered.outcome}`;
        ctx.messageDelta(reply);
        break;
      }

      case "slow": {
        const ms = Number(arg) || 10_000;
        await sleep(ms, ctx.signal);
        reply = "slept";
        ctx.messageDelta(reply);
        break;
      }

      case "error": {
        ctx.error({ code: -32000, message: "transient upstream failure", retryable: true });
        reply = "recovered after a retryable error";
        ctx.messageDelta(reply);
        break;
      }

      case "throw":
        throw new Error("mock harness: deliberate delegate failure");

      case "fail":
        ctx.fail({ code: -32000, message: "mock harness: deliberate fail()" });
        break;

      case "usage":
        ctx.usage({ inputTokens: 1234, outputTokens: 56, cachedTokens: 100, cost: 0.0042 });
        reply = "usage emitted";
        ctx.messageDelta(reply);
        break;

      case "file":
        ctx.fileChanged({ path: arg || "a.txt", kind: "modify", diff: "@@ -1 +1 @@\n-old\n+new\n" });
        reply = `changed ${arg || "a.txt"}`;
        ctx.messageDelta(reply);
        break;

      case "subagent":
        ctx.subagentStarted({ childSessionId: "s_child", name: "worker" });
        ctx.subagentFinished({ childSessionId: "s_child", status: "success", summary: "child finished" });
        reply = "subagent done";
        ctx.messageDelta(reply);
        break;

      case "background":
        ctx.backgroundStarted({ taskId: "bg_1", title: "indexing" });
        ctx.backgroundUpdated({ taskId: "bg_1", status: "running", outputDelta: "50%" });
        ctx.backgroundFinished({ taskId: "bg_1", status: "success", output: "indexed" });
        reply = "background done";
        ctx.messageDelta(reply);
        break;

      case "compact":
        ctx.compactionPerformed({ trigger: "auto", preTokens: 90_000, postTokens: 12_000 });
        reply = "compacted";
        ctx.messageDelta(reply);
        break;

      default:
        reply = text === "" ? "(empty prompt)" : text;
        ctx.messageDelta(reply);
        break;
    }

    const entries = transcripts.get(ctx.sessionId) ?? [];
    entries.push({ turn: ctx.turn, prompt: text, reply });
    transcripts.set(ctx.sessionId, entries);

    return ctx.cancelled ? "cancelled" : "end_turn";
  },
};

// ── main ────────────────────────────────────────────────────────────────

const { capabilities } = parseArgs(process.argv.slice(2));

const harness = new AriHarness({
  agentInfo: { name: "MockHarness", version: "1.0.0" },
  capabilities,
  delegate,
  cancelGraceMs: 1000,
});

log(`capabilities: ${Object.entries(capabilities).filter(([, on]) => on).map(([k]) => k).join(", ") || "(none)"}`);

await harness.serve(process.stdin, process.stdout);
log("stdin closed; exiting");
