export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  APP_NAME: string;
  SUPPORT_EMAIL: string;
  ADMIN_EMAILS: string;
  SHOPIFY_SHOP: string;
  SHOPIFY_API_VERSION: string;
  UPS_ENV: string;
  AI_MODEL: string;

  SESSION_SECRET: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SHOPIFY_ADMIN_TOKEN?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  UPS_CLIENT_ID?: string;
  UPS_CLIENT_SECRET?: string;
  UPS_ACCOUNT_NUMBER?: string;
  ANTHROPIC_API_KEY?: string;
  EASYPOST_API_KEY?: string;
  REDO_API_TOKEN?: string;
  REDO_STORE_ID?: string;
  BOOKING_SUPABASE_URL?: string;
  BOOKING_SUPABASE_ANON_KEY?: string;
  TUFTSTOCK_URL?: string;
  TUFTSTOCK_TOKEN?: string;
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  META_GRAPH_VERSION?: string; // e.g. "v23.0"
  DEV_LOGIN_EMAIL?: string;
  DEMO_DATA?: string;
  RAW_ENV?: Env; // env before app-entered credentials were applied
}

export interface Agent {
  id: number;
  email: string;
  name: string;
  role: "admin" | "agent";
  signature: string;
  theme?: "system" | "light" | "dark";
}

export type AppEnv = { Bindings: Env; Variables: { agent: Agent } };
