/**
 * Event rendering — SPEC.md §9.
 *
 * Deliberately a pure function over an event, so it can be tested without a
 * harness and so the Shell's display logic contains no reference to any
 * particular implementation. `renderEvent` never throws: SPEC Appendix A item 23
 * requires a Shell to ignore unknown event types rather than fail on them.
 */

import { EVENT_CAPABILITY, type AriEvent } from "../../ari/src/index.ts";

export type Rendered =
  /** Append to the current line without breaking it (streaming text). */
  | { kind: "stream"; text: string; stream: "message" | "reasoning" | "tool" }
  /** A complete line of its own. */
  | { kind: "line"; text: string }
  /** Nothing worth showing. */
  | { kind: "none" };

export interface RenderOptions {
  showReasoning: boolean;
  showStatus: boolean;
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  showReasoning: true,
  showStatus: false,
};

const none: Rendered = { kind: "none" };
const line = (text: string): Rendered => ({ kind: "line", text });

function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 10)}…`;
}

function preview(value: unknown, limit = 120): string {
  if (value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** Render one event. Unknown types produce a dim note rather than an error. */
export function renderEvent(event: AriEvent, options: RenderOptions = DEFAULT_RENDER_OPTIONS): Rendered {
  const payload = event as unknown as Record<string, unknown>;

  switch (event.type) {
    case "session/status": {
      if (!options.showStatus) return none;
      return line(`  · ${String(payload["status"])}`);
    }

    case "turn/started":
      return none;

    case "turn/completed": {
      const stopReason = String(payload["stopReason"]);
      return stopReason === "end_turn" ? none : line(`  · turn ended: ${stopReason}`);
    }

    case "message/delta":
      return { kind: "stream", text: String(payload["text"] ?? ""), stream: "message" };

    case "reasoning/delta": {
      if (!options.showReasoning) return none;
      return { kind: "stream", text: String(payload["text"] ?? ""), stream: "reasoning" };
    }

    case "tool/started": {
      const name = String(payload["name"]);
      const input = preview(payload["input"], 80);
      return line(`  ⚙ ${name}${input ? ` ${input}` : ""}`);
    }

    case "tool/updated": {
      const delta = payload["outputDelta"];
      const title = payload["title"];
      if (delta !== undefined) return { kind: "stream", text: String(delta), stream: "tool" };
      if (title !== undefined) return line(`  ⚙ ${String(title)}`);
      return none;
    }

    case "tool/completed": {
      const ok = payload["status"] === "success";
      const output = preview(payload["output"]);
      return line(`  ${ok ? "✓" : "✗"} ${shortId(String(payload["callId"]))}${output ? ` ${output}` : ""}`);
    }

    case "approval/requested": {
      const options_ = payload["options"] as { id: string; label?: string }[] | undefined;
      const offered = options_?.map((option) => option.id).join(" | ") ?? "allow_once | allow_always | deny";
      const reason = payload["reason"] ? ` — ${String(payload["reason"])}` : "";
      return line(`  ? approval required (${offered})${reason}`);
    }

    case "approval/resolved":
      return line(`  · approval ${String(payload["decision"])}`);

    case "question/requested": {
      const questions = (payload["questions"] ?? []) as { question: string }[];
      return line(`  ? ${questions.map((question) => question.question).join(" / ")}`);
    }

    case "question/resolved":
      return line(`  · question ${String(payload["outcome"])}`);

    case "usage/updated": {
      const usage = payload["usage"] as { inputTokens?: number; outputTokens?: number } | undefined;
      if (!usage) return none;
      return line(`  · tokens in ${usage.inputTokens ?? 0} / out ${usage.outputTokens ?? 0}`);
    }

    case "compaction/performed":
      return line(`  · compacted (${String(payload["trigger"])})`);

    case "file/changed":
      return line(`  · ${String(payload["kind"])} ${String(payload["path"])}`);

    case "subagent/started":
      return line(`  ⇢ subagent started${payload["name"] ? ` (${String(payload["name"])})` : ""}`);

    case "subagent/finished":
      return line(`  ⇠ subagent ${String(payload["status"])}`);

    case "background/started":
      return line(`  ⋯ background started${payload["title"] ? ` (${String(payload["title"])})` : ""}`);

    case "background/updated":
      return none;

    case "background/finished":
      return line(`  ⋯ background ${String(payload["status"])}`);

    case "session/error": {
      const error = payload["error"] as { code: number; message: string; retryable?: boolean } | undefined;
      if (!error) return none;
      return line(`  ! ${error.message} (${error.code}${error.retryable ? ", retryable" : ""})`);
    }

    default: {
      // Unknown event types must be ignored, not fatal (Appendix A item 23).
      // The switch above covers every type the union knows; this branch only
      // runs for types that arrive on the wire before the types do.
      const type = (event as { type?: string }).type ?? "";
      if (type.startsWith("x-")) return line(`  · [${type}]`);
      void EVENT_CAPABILITY;
      return none;
    }
  }
}
