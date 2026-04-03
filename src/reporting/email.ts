import { Resend } from "resend";
import { getConfig } from "../config.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "email" });

let _resend: Resend | null = null;

function getResend(): Resend {
	if (!_resend) {
		_resend = new Resend(getConfig().RESEND_API_KEY);
	}
	return _resend;
}

export interface EmailOptions {
	subject: string;
	html: string;
}

export async function sendEmail(options: EmailOptions): Promise<void> {
	const config = getConfig();

	if (config.NODE_ENV === "test") {
		log.debug({ subject: options.subject }, "Skipping email in test mode");
		return;
	}

	try {
		const resend = getResend();
		await resend.emails.send({
			from: config.ALERT_EMAIL_FROM,
			to: config.ALERT_EMAIL_TO,
			subject: options.subject,
			html: options.html,
		});
		log.info({ subject: options.subject }, "Email sent");
	} catch (error) {
		log.error({ error, subject: options.subject }, "Failed to send email");
	}
}
