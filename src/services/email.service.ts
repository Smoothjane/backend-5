import { config } from '@/config/config';
import { getQueue } from '@/utils/queue';
import { logger } from '@/utils/logger';

export interface Email {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Sends one email. With EMAIL_PROVIDER=resend it calls the Resend HTTP API
 * (no SMTP library needed); otherwise it logs the message, which keeps
 * development and tests free of external services. Throws on failure so the
 * queue can retry.
 */
export async function sendEmail(email: Email): Promise<void> {
  const { provider, apiKey, from } = config.email;
  if (provider !== 'resend') {
    logger.info(`[email:log] to=${email.to} subject="${email.subject}"`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [email.to],
      subject: email.subject,
      text: email.text,
      html: email.html,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    // 4xx other than rate limiting will not succeed on retry, but the queue's
    // attempt cap bounds the cost; the message records why.
    throw new Error(`Email provider responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

let registered = false;

/** Registers the notifications processor. Safe to call more than once. */
export function startEmailWorker(): void {
  if (registered) return;
  registered = true;
  getQueue<Email>('notifications').process(sendEmail);
}

/** Queues an email; returns immediately. Failures are retried with backoff. */
export function queueEmail(email: Email): void {
  getQueue<Email>('notifications').add(email);
}
