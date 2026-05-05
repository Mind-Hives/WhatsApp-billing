import twilio from "twilio";

export type TwilioClient = ReturnType<typeof twilio>;

function requireTwilioEnv(name: "TWILIO_ACCOUNT_SID" | "TWILIO_AUTH_TOKEN") {
  const value = process.env[name];

  if (!value || !value.trim()) {
    throw new Error(`[twilio-sync] Twilio client startup failed: ${name} is missing.`);
  }

  return value;
}

// Server-only Twilio client factory. Keep this module out of client components/routes that
// can be bundled for the browser; it reads credentials and must never log their values.
export function createTwilioClient(): TwilioClient {
  const accountSid = requireTwilioEnv("TWILIO_ACCOUNT_SID");
  const authToken = requireTwilioEnv("TWILIO_AUTH_TOKEN");

  return twilio(accountSid, authToken);
}
