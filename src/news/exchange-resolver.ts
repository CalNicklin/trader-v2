import type { Exchange } from "../broker/contracts.ts";
import { fmpResolveExchange } from "../data/fmp.ts";

export interface ParseDeps {
	resolver?: (symbol: string) => Promise<Exchange | null>;
}

export async function parseUniverseSpec(
	spec: string,
	deps: ParseDeps = {},
): Promise<{ symbol: string; exchange: Exchange } | null> {
	if (!spec) return null;
	if (spec.includes(":")) {
		const [sym, ex] = spec.split(":");
		if (!sym || !ex) return null;
		return { symbol: sym, exchange: ex as Exchange };
	}
	const resolver = deps.resolver ?? ((s: string) => fmpResolveExchange(s));
	const exchange = await resolver(spec);
	if (!exchange) return null;
	return { symbol: spec, exchange };
}
