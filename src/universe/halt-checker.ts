import { createChildLogger } from "../utils/logger.ts";
import type { DeltaFlag } from "./delta.ts";

const log = createChildLogger({ module: "universe-halt-checker" });

// v1 design: returns an empty list — live halt detection requires an IBKR
// event-stream subscription or a paid SEC halt feed, both of which are
// deferred to the follow-up iteration (see spec "Deferred" section).
// Symbols that genuinely go stale are still caught by the weekly refresh's
// filter pass (missing_data or low_dollar_volume rejects them), so the
// universe self-corrects within 7 days of any dropout even without this.
export async function ibkrHaltChecker(): Promise<DeltaFlag[]> {
	log.info("Halt checker v1 is a no-op; weekly refresh handles stale symbols");
	return [];
}
