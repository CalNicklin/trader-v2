import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { HealthState } from "@/lib/use-health";

function formatUptime(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

function formatPnl(pnl: number): string {
	const sign = pnl >= 0 ? "+" : "";
	return `${sign}${pnl.toFixed(1)}p`;
}

const statusColors = {
	ok: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
	degraded: "bg-amber-500/20 text-amber-400 border-amber-500/30",
	error: "bg-red-500/20 text-red-400 border-red-500/30",
} as const;

export function HealthCard({ data, error }: HealthState) {
	if (error || !data) {
		return (
			<Card className="bg-zinc-900/50 border-zinc-800">
				<CardHeader className="py-2 px-3">
					<CardTitle className="text-xs font-medium text-zinc-400">Health</CardTitle>
				</CardHeader>
				<CardContent className="px-3 pb-2">
					<Badge variant="destructive" className="text-[10px]">Unreachable</Badge>
				</CardContent>
			</Card>
		);
	}

	return (
		<Card className="bg-zinc-900/50 border-zinc-800">
			<CardHeader className="py-2 px-3">
				<CardTitle className="text-xs font-medium text-zinc-400 flex items-center gap-2">
					Health
					<Badge className={`text-[10px] ${statusColors[data.status]}`}>
						{data.status}
					</Badge>
				</CardTitle>
			</CardHeader>
			<CardContent className="px-3 pb-2">
				<div className="grid grid-cols-4 gap-3 text-[11px]">
					<div>
						<div className="text-zinc-500">Uptime</div>
						<div className="text-zinc-200 font-medium">{formatUptime(data.uptime)}</div>
					</div>
					<div>
						<div className="text-zinc-500">Strategies</div>
						<div className="text-zinc-200 font-medium">{data.activeStrategies}</div>
					</div>
					<div>
						<div className="text-zinc-500">Daily P&L</div>
						<div className={`font-medium ${data.dailyPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
							{formatPnl(data.dailyPnl)}
						</div>
					</div>
					<div>
						<div className="text-zinc-500">API Spend</div>
						<div className="text-zinc-200 font-medium">${data.apiSpendToday.toFixed(2)}</div>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
