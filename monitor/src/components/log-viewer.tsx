import { useRef, useEffect, useState, useMemo } from "react";
import { Input } from "@/components/ui/input";

interface LogViewerProps {
	lines: string[];
}

const ERROR_PATTERN = /\b(error|fatal|err(?:or)?)\b/i;
const WARN_PATTERN = /\b(warn|warning)\b/i;

function classifyLine(line: string): "error" | "warn" | "info" {
	if (ERROR_PATTERN.test(line)) return "error";
	if (WARN_PATTERN.test(line)) return "warn";
	return "info";
}

const lineColors = {
	error: "text-red-400",
	warn: "text-amber-400",
	info: "text-zinc-300",
} as const;

export function LogViewer({ lines }: LogViewerProps) {
	const [filter, setFilter] = useState("");
	const [autoScroll, setAutoScroll] = useState(true);
	const bottomRef = useRef<HTMLDivElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	const filteredLines = useMemo(() => {
		if (!filter) return lines;
		const lower = filter.toLowerCase();
		return lines.filter((l) => l.toLowerCase().includes(lower));
	}, [lines, filter]);

	useEffect(() => {
		if (autoScroll && bottomRef.current) {
			bottomRef.current.scrollIntoView({ behavior: "instant" });
		}
	}, [filteredLines, autoScroll]);

	function handleScroll(e: React.UIEvent<HTMLDivElement>) {
		const el = e.currentTarget;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
		setAutoScroll(atBottom);
	}

	return (
		<div className="flex flex-col h-full">
			<div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
				<Input
					placeholder="Filter logs..."
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					className="h-7 text-xs bg-zinc-900 border-zinc-700 text-zinc-200 placeholder:text-zinc-600 max-w-xs"
				/>
				<span className="text-xs text-zinc-600 ml-auto">
					{filteredLines.length} lines
				</span>
			</div>
			<div
				ref={containerRef}
				onScroll={handleScroll}
				className="flex-1 overflow-y-auto font-mono text-xs leading-5 p-3"
			>
				{filteredLines.map((line, i) => {
					const level = classifyLine(line);
					return (
						<div key={i} className={`${lineColors[level]} whitespace-pre-wrap break-all`}>
							{line}
						</div>
					);
				})}
				<div ref={bottomRef} />
			</div>
			{!autoScroll && (
				<button
					type="button"
					onClick={() => {
						setAutoScroll(true);
						bottomRef.current?.scrollIntoView({ behavior: "smooth" });
					}}
					className="absolute bottom-6 right-6 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs px-3 py-1.5 rounded-full border border-zinc-700 shadow-lg"
				>
					Jump to bottom
				</button>
			)}
		</div>
	);
}
