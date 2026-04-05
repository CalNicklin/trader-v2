import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { DeployRun } from "@/lib/use-deploys";

function relativeTime(dateStr: string): string {
	const diff = Date.now() - new Date(dateStr).getTime();
	const mins = Math.floor(diff / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function formatDuration(ms: number | null): string {
	if (!ms) return "-";
	const secs = Math.floor(ms / 1000);
	const m = Math.floor(secs / 60);
	const s = secs % 60;
	return `${m}m ${s}s`;
}

function conclusionBadge(run: DeployRun) {
	if (run.status === "in_progress") {
		return <Badge className="text-[10px] bg-blue-500/20 text-blue-400 border-blue-500/30">running</Badge>;
	}
	if (run.conclusion === "success") {
		return <Badge className="text-[10px] bg-emerald-500/20 text-emerald-400 border-emerald-500/30">passed</Badge>;
	}
	if (run.conclusion === "failure") {
		return <Badge className="text-[10px] bg-red-500/20 text-red-400 border-red-500/30">failed</Badge>;
	}
	return <Badge className="text-[10px] bg-zinc-500/20 text-zinc-400 border-zinc-500/30">{run.conclusion ?? run.status}</Badge>;
}

function DeployRow({ run }: { run: DeployRun }) {
	return (
		<a
			href={run.htmlUrl}
			target="_blank"
			rel="noopener noreferrer"
			className="flex items-center gap-2 text-[11px] py-1 hover:bg-zinc-800/50 rounded px-1 -mx-1"
		>
			{conclusionBadge(run)}
			<code className="text-zinc-400 font-mono">{run.headSha.slice(0, 7)}</code>
			<span className="text-zinc-500 truncate flex-1">{run.headMessage}</span>
			<span className="text-zinc-600 whitespace-nowrap">{formatDuration(run.runDurationMs)}</span>
			<span className="text-zinc-600 whitespace-nowrap">{relativeTime(run.createdAt)}</span>
		</a>
	);
}

export function DeployCard({ deploys }: { deploys: DeployRun[] }) {
	const [open, setOpen] = useState(false);
	const latest = deploys[0];

	if (!latest) {
		return (
			<Card className="bg-zinc-900/50 border-zinc-800">
				<CardHeader className="py-2 px-3">
					<CardTitle className="text-xs font-medium text-zinc-400">Deploys</CardTitle>
				</CardHeader>
				<CardContent className="px-3 pb-2">
					<span className="text-[11px] text-zinc-600">No deploy data</span>
				</CardContent>
			</Card>
		);
	}

	return (
		<Card className="bg-zinc-900/50 border-zinc-800">
			<Collapsible open={open} onOpenChange={setOpen}>
				<CardHeader className="py-2 px-3">
					<CardTitle className="text-xs font-medium text-zinc-400">
						<CollapsibleTrigger className="flex items-center gap-1 hover:text-zinc-200 cursor-pointer">
							Deploys
							<svg
								className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`}
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
							</svg>
						</CollapsibleTrigger>
					</CardTitle>
				</CardHeader>
				<CardContent className="px-3 pb-2">
					<DeployRow run={latest} />
					<CollapsibleContent>
						{deploys.slice(1).map((run) => (
							<DeployRow key={run.id} run={run} />
						))}
					</CollapsibleContent>
				</CardContent>
			</Collapsible>
		</Card>
	);
}
