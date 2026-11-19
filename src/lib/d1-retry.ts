import type { Env } from "../env";

/**
 * "D1 DB is overloaded" means Cloudflare turned the query away before running it (too much work in a
 * 10-second window). A short wait and one or two more tries usually gets through, so a busy moment
 * doesn't surface as an error. Only that error is retried: anything else may have run, and is thrown.
 */
const OVERLOADED = /overloaded/i;
const DELAYS = [250, 750, 1500];
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

async function retry<T>(run: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await run();
    } catch (e) {
      if (i >= DELAYS.length || !OVERLOADED.test(String((e as Error)?.message ?? e))) throw e;
      await sleep(DELAYS[i] + Math.floor(Math.random() * 150));
    }
  }
}

/** Wrapped statement → the real one: db.batch is handed the originals. */
const originals = new WeakMap<object, D1PreparedStatement>();

function wrapStatement(stmt: D1PreparedStatement): D1PreparedStatement {
  const wrapped = new Proxy(stmt, {
    get(target, prop) {
      if (prop === "bind") return (...args: unknown[]) => wrapStatement(target.bind(...args));
      if (prop === "first" || prop === "all" || prop === "run" || prop === "raw") {
        const fn = (target as any)[prop].bind(target);
        return (...args: unknown[]) => retry(() => fn(...args));
      }
      const v = (target as any)[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  originals.set(wrapped, stmt);
  return wrapped;
}

export function retryingD1(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrapStatement(target.prepare(sql));
      if (prop === "batch") return <T>(stmts: D1PreparedStatement[]) => retry(() => target.batch<T>(stmts.map((x) => originals.get(x) ?? x)));
      if (prop === "exec") return (sql: string) => retry(() => target.exec(sql));
      const v = (target as any)[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** The env with its database retrying on "overloaded" (layered without copying, so secret bindings stay). */
export function withRetryingDb(env: Env): Env {
  if (!env.DB) return env;
  const out = Object.create(env) as Env;
  out.DB = retryingD1(env.DB);
  return out;
}
