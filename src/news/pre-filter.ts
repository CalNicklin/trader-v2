// Keyword pre-filter gate: eliminates ~80% of headlines before Haiku classification.
// Logic: if headline matches a BLOCK pattern, reject. Otherwise accept.
// This is intentionally permissive — better to classify a few extra headlines
// than miss a tradeable event. Haiku calls are ~$0.0001 each.

const BLOCK_PATTERNS = [
	/\banalyst\s+reiterates?\b/i,
	/\broutine\s+filing\b/i,
	/\bboard\s+(appointment|member|director)\b/i,
	/\bESG\s+report\b/i,
	/\bannual\s+(general\s+)?meeting\b/i,
	/\bcorporate\s+governance\b/i,
	/\bshareholder\s+letter\b/i,
	/\bno\s+material\s+change\b/i,
];

/**
 * Returns true if the headline should be sent to Haiku for classification.
 * Returns false if the headline is routine noise that can be skipped.
 */
export function shouldClassify(headline: string): boolean {
	for (const pattern of BLOCK_PATTERNS) {
		if (pattern.test(headline)) return false;
	}
	return true;
}
