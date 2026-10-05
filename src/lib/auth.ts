import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Agent, AppEnv, Env } from "../env";
import { HttpError, randomId } from "./util";

const SESSION_COOKIE = "hd_session";
const SESSION_DAYS = 30;

export async function createSession(c: Context<AppEnv>, agentId: number) {
  const id = randomId(32);
  const expires = Date.now() + SESSION_DAYS * 86400_000;
  await c.env.DB.prepare("INSERT INTO sessions (id, agent_id, expires_at) VALUES (?, ?, ?)").bind(id, agentId, expires).run();
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
}

export async function destroySession(c: Context<AppEnv>) {
  const id = getCookie(c, SESSION_COOKIE);
  if (id) await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export async function currentAgent(c: Context<AppEnv>): Promise<Agent | null> {
  const id = getCookie(c, SESSION_COOKIE);
  if (id) {
    const row = await c.env.DB.prepare(
      `SELECT a.id, a.email, a.name, a.role, a.signature, a.theme FROM sessions s
       JOIN agents a ON a.id = s.agent_id
       WHERE s.id = ? AND s.expires_at > ? AND a.active = 1`,
    )
      .bind(id, Date.now())
      .first<Agent>();
    if (row) return row;
  }
  // Local development shortcut: DEV_LOGIN_EMAIL only applies on localhost
  const host = new URL(c.req.url).hostname;
  if (c.env.DEV_LOGIN_EMAIL && (host === "localhost" || host === "127.0.0.1")) {
    return findOrProvisionAgent(c.env, c.env.DEV_LOGIN_EMAIL, "Dev");
  }
  return null;
}

/** Returns the agent for this email, creating it if listed in ADMIN_EMAILS. Null if not allowed. */
export async function findOrProvisionAgent(env: Env, email: string, name: string): Promise<Agent | null> {
  const existing = await env.DB.prepare(
    "SELECT id, email, name, role, signature, theme FROM agents WHERE email = ? AND active = 1",
  )
    .bind(email)
    .first<Agent>();
  if (existing) return existing;
  const admins = (env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!admins.includes(email.toLowerCase())) return null;
  const res = await env.DB.prepare(
    "INSERT INTO agents (email, name, role) VALUES (?, ?, 'admin') ON CONFLICT(email) DO UPDATE SET active = 1, role = 'admin' RETURNING id, email, name, role, signature, theme",
  )
    .bind(email.toLowerCase(), name || email.split("@")[0])
    .first<Agent>();
  return res;
}

export async function requireAgent(c: Context<AppEnv>, next: Next) {
  const agent = await currentAgent(c);
  if (!agent) return c.json({ error: "Not signed in" }, 401);
  c.set("agent", agent);
  await next();
}

export function requireAdmin(c: Context<AppEnv>) {
  if (c.get("agent").role !== "admin") throw new HttpError(403, "Admins only");
}
