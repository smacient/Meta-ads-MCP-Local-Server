import dotenv from "dotenv";
import { startServer } from "./server.js";
import { MetaConfig } from "./types.js";

dotenv.config();

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const cfg: MetaConfig = {
  appId: requireEnv("META_APP_ID"),
  appSecret: requireEnv("META_APP_SECRET"),
  accessToken: requireEnv("META_ACCESS_TOKEN"),
  adAccountId: process.env.META_AD_ACCOUNT_ID || "",
  apiVersion: process.env.META_API_VERSION || "v20.0",
};

if (!cfg.adAccountId.startsWith("act_")) {
  console.warn(
    "META_AD_ACCOUNT_ID is recommended (format: act_XXXXXXXXXXXX). You can still call list_accounts to discover accounts."
  );
}

startServer(cfg);
