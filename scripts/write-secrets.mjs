// Runs in Cloudflare Workers Builds before `wrangler deploy`.
// Copies runtime secrets from the build's environment (Settings → Build → Variables and secrets)
// into a file that `wrangler deploy --secrets-file` uploads with every version, so a deploy can
// never leave the app without them. Values are never printed.
import { writeFileSync } from "node:fs";

const NAMES = [
  "SESSION_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  // Optional — these can also be entered in the app under Settings → Credentials
  "SHOPIFY_CLIENT_ID",
  "SHOPIFY_CLIENT_SECRET",
  "SHOPIFY_ADMIN_TOKEN",
  "UPS_CLIENT_ID",
  "UPS_CLIENT_SECRET",
  "UPS_ACCOUNT_NUMBER",
  "ANTHROPIC_API_KEY",
];
const REQUIRED = ["SESSION_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];

const secrets = {};
for (const name of NAMES) {
  const v = process.env[name];
  if (v && v.trim()) secrets[name] = v.trim();
}
writeFileSync(".secrets.json", JSON.stringify(secrets));

const found = Object.keys(secrets);
console.log(`Secrets included in this deploy: ${found.length ? found.join(", ") : "(none)"}`);
const missing = REQUIRED.filter((n) => !secrets[n]);
if (missing.length) {
  console.warn(
    `WARNING: ${missing.join(", ")} not found in Build variables. ` +
      "Existing values on the Worker are kept, but add them under Settings → Build → Variables and secrets so every deploy carries them.",
  );
}
