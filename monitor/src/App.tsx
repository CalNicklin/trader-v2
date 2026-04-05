import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export function App() {
	return (
		<div className="min-h-screen bg-zinc-950 text-zinc-100 p-4">
			<Card>
				<CardHeader>
					<CardTitle>
						trader-v2 <Badge>online</Badge>
					</CardTitle>
				</CardHeader>
				<CardContent>
					<p className="text-zinc-400 text-sm">Components loaded.</p>
				</CardContent>
			</Card>
		</div>
	);
}
