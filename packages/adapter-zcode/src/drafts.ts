/**
 * ARI event drafts — envelope-less event bodies used inside the adapter.
 *
 * The adapter builds events in two steps: map a ZCode fact to a draft, then
 * stamp the envelope (`sessionId`, `seq`) **last** so no payload field can
 * ever shadow it (SPEC §9.1 reserved fields).
 */

import type { AriEvent } from "../../ari/src/index.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An ARI event body without its envelope fields. */
export type AriEventDraft = DistributiveOmit<AriEvent, "sessionId" | "seq">;
