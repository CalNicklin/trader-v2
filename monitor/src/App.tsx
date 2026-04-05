import { useLogs } from "@/lib/use-logs";
import { useHealth } from "@/lib/use-health";
import { useDeploys } from "@/lib/use-deploys";
import { LogViewer } from "@/components/log-viewer";
import { HealthCard } from "@/components/health-card";
import { DeployCard } from "@/components/deploy-card";

export function App() {
	const { lines, connected } = useLogs();
	const health = useHealth();
	const deploys = useDeploys();

	return (
		<div className="h-screen flex flex-col bg-zinc-950 text-zinc-100">
			{/* Header */}
			<header className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-sm">
				<div className="flex items-center gap-3">
					<h1 className="text-sm font-semibold tracking-tight">trader-v2</h1>
					<div className="flex items-center gap-1.5">
						<div
							className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.5)]" : "bg-red-400 shadow-[0_0_4px_rgba(248,113,113,0.5)]"}`}
						/>
						<span className="text-[10px] text-zinc-500">
							{connected ? "streaming" : "disconnected"}
						</span>
					</div>
				</div>
				<div className="flex items-center gap-2">
					<HealthCard {...health} />
					<DeployCard deploys={deploys} />
				</div>
			</header>

			{/* Log viewer */}
			<main className="flex-1 overflow-hidden relative">
				<LogViewer lines={lines} />
			</main>
		</div>
	);
}
