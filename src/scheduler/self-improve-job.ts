import { getConfig } from "../config";
import { sendEmail } from "../reporting/email";
import { runSelfImprovementCycle } from "../self-improve/proposer";
import { createChildLogger } from "../utils/logger";

const log = createChildLogger({ module: "self-improve-job" });

export async function runSelfImproveJob(): Promise<void> {
	const config = getConfig();

	if (!config.GITHUB_TOKEN || !config.GITHUB_REPO_OWNER) {
		log.info("GitHub not configured, skipping self-improvement");
		return;
	}

	try {
		const result = await runSelfImprovementCycle();

		log.info(
			{
				prsCreated: result.prsCreated,
				errors: result.errors.length,
			},
			"Self-improvement cycle complete",
		);

		if (result.prsCreated > 0 || result.errors.length > 0) {
			await sendEmail({
				subject: `Trader v2 Self-Improve: ${result.prsCreated} PRs`,
				html: `
                    <h2>Self-Improvement Cycle Results</h2>
                    <ul>
                        <li><strong>PRs created:</strong> ${result.prsCreated}</li>
                        ${result.errors.length > 0 ? `<li><strong>Errors:</strong><ul>${result.errors.map((e) => `<li>${e}</li>`).join("")}</ul></li>` : ""}
                    </ul>
                `,
			});
		}
	} catch (error) {
		log.error({ error }, "Self-improvement cycle failed");
		throw error;
	}
}
