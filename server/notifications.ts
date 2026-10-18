import { readFileSync, existsSync } from "node:fs";
import nodemailer from "nodemailer";
import { z } from "zod";

export const SmtpSchema = z.object({
  host: z.string().min(1).max(253),
  port: z.union([z.literal(465), z.literal(587)]).default(587),
  username: z.string().min(1).max(320),
  password: z.string().min(1),
  from: z.email(),
  to: z.array(z.email()).min(1),
});
export interface Message {
  id: number;
  messageKey?: string;
  subject: string;
  body: string;
}
export interface Delivery {
  send(message: Message): Promise<void>;
  provider: string;
  recipients?: string[];
}
export function smtpDelivery(
  preferences?: () => { recipients: string[] },
): Delivery | null {
  const file = process.env.HOSTBOARD_SMTP_CONFIG || "config/smtp.json";
  if (!existsSync(file)) return null;
  const config = SmtpSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    requireTLS: true,
    auth: { user: config.username, pass: config.password },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    logger: false,
    debug: false,
  });
  return {
    provider: "SMTP",
    recipients: config.to,
    async send(message) {
      const result = await transport.sendMail({
        from: config.from,
        to: preferences?.().recipients.length
          ? preferences().recipients
          : config.to,
        subject: message.subject,
        text: message.body,
        messageId: `<hostboard-${message.messageKey || message.id}@${config.from.split("@")[1]}>`,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      if (result.rejected.length || !result.accepted.length)
        throw new Error("SMTP recipient rejected");
    },
  };
}
