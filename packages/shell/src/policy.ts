/**
 * Interaction policy — SPEC.md §10, Appendix A item 24.
 *
 * The one rule that matters here: **a Shell MUST NOT send a decision that was
 * not among the offered `options`.** A harness that does not want to offer
 * `allow_always` simply does not list it, and a Shell that sends it anyway gets
 * `-32602`. Keeping this in one pure function makes it testable without a
 * harness and impossible to get subtly wrong at the call site.
 */

import type { ApprovalDecision, ApprovalOption, QuestionAnswer, QuestionSpec } from "../../ari/src/index.ts";

/** Preference order when the user says "yes". */
const ALLOW_PREFERENCE: readonly ApprovalDecision[] = ["allow_once", "allow_always", "deny"];

/** Preference order when the user says "no". */
const DENY_PREFERENCE: readonly ApprovalDecision[] = ["deny", "allow_once", "allow_always"];

/** The three decisions ARI defines when a harness offers no explicit list (§10.1). */
export const DEFAULT_DECISIONS: readonly ApprovalDecision[] = ["allow_once", "allow_always", "deny"];

/** The decisions a harness actually offered, defaulting to the three (§10.1). */
export function offeredDecisions(options: readonly ApprovalOption[] | undefined): ApprovalDecision[] {
  if (!options || options.length === 0) return [...DEFAULT_DECISIONS];
  return options.map((option) => option.id);
}

/**
 * Pick a decision, **never outside `options`**. Returns `undefined` only if the
 * harness offered nothing usable, which cannot happen for a conformant harness
 * but is handled rather than assumed.
 */
export function chooseDecision(
  options: readonly ApprovalOption[] | undefined,
  preference: "allow" | "deny",
): ApprovalDecision | undefined {
  const offered = offeredDecisions(options);
  const order = preference === "allow" ? ALLOW_PREFERENCE : DENY_PREFERENCE;
  for (const candidate of order) {
    if (offered.includes(candidate)) return candidate;
  }
  return offered[0];
}

/** Parse a typed answer ("y"/"n"/"a"/a literal decision) against what was offered. */
export function parseDecision(
  input: string,
  options: readonly ApprovalOption[] | undefined,
): ApprovalDecision | undefined {
  const offered = offeredDecisions(options);
  const text = input.trim().toLowerCase();

  if (text === "") return undefined;
  if (offered.includes(text as ApprovalDecision)) return text as ApprovalDecision;

  const preference =
    text === "y" || text === "yes" || text === "1" ? "allow" : text === "n" || text === "no" || text === "0" ? "deny" : undefined;
  if (!preference) return undefined;
  return chooseDecision(options, preference);
}

/**
 * Build an answer for a question. `[]` means an explicit decline (SPEC §10.2),
 * which is why an empty answer list is a valid result rather than an error.
 */
export function buildAnswers(questions: readonly QuestionSpec[], input: string): QuestionAnswer[] {
  const text = input.trim();
  if (text === "") return []; // decline

  const answers: QuestionAnswer[] = [];
  for (const question of questions) {
    if (question.options && question.options.length > 0) {
      // Only values that were actually offered.
      const chosen = question.options
        .filter((option) => option.id === text || option.label.toLowerCase() === text.toLowerCase())
        .map((option) => option.id);
      if (chosen.length > 0) {
        answers.push({ id: question.id, values: chosen });
        continue;
      }
    }
    answers.push({ id: question.id, values: [text] });
  }
  return answers;
}
