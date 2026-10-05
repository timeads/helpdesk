// Ticket folders: file tickets away from the inbox (e.g. repairs waiting for the machine to arrive) and pull
// them up from the sidebar when it's time. Filing doesn't change the status; a customer reply still marks it unread.
import type { Env } from "../env";
import { logEvent, type TicketRow } from "./support";
import { HttpError } from "./util";

export interface Folder { id: number; name: string; position: number }

export async function listFolders(env: Env): Promise<Folder[]> {
  const { results } = await env.DB.prepare("SELECT id, name, position FROM folders ORDER BY position, name COLLATE NOCASE").all<Folder>();
  return results;
}

const cleanName = (name: unknown) => {
  const n = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!n) throw new HttpError(400, "Give the folder a name");
  return n;
};

export async function createFolder(env: Env, name: unknown) {
  const n = cleanName(name);
  if (await env.DB.prepare("SELECT 1 FROM folders WHERE name = ?").bind(n).first()) throw new HttpError(409, `There's already a folder called “${n}”`);
  const max = await env.DB.prepare("SELECT COALESCE(MAX(position), 0) AS p FROM folders").first<{ p: number }>();
  return env.DB.prepare("INSERT INTO folders (name, position) VALUES (?, ?) RETURNING id, name, position").bind(n, (max?.p ?? 0) + 1).first<Folder>();
}

export async function renameFolder(env: Env, id: number, name: unknown) {
  const n = cleanName(name);
  if (await env.DB.prepare("SELECT 1 FROM folders WHERE name = ? AND id != ?").bind(n, id).first()) throw new HttpError(409, `There's already a folder called “${n}”`);
  const r = await env.DB.prepare("UPDATE folders SET name = ? WHERE id = ?").bind(n, id).run();
  if (!r.meta.changes) throw new HttpError(404, "Folder not found");
}

/** Deleting a folder puts its tickets back in the inbox. */
export async function deleteFolder(env: Env, id: number) {
  const { results } = await env.DB.prepare("SELECT id FROM tickets WHERE folder_id = ?").bind(id).all<{ id: number }>();
  await env.DB.batch([
    env.DB.prepare("UPDATE tickets SET folder_id = NULL WHERE folder_id = ?").bind(id),
    env.DB.prepare("DELETE FROM folders WHERE id = ?").bind(id),
  ]);
  return results.length;
}

/** Files a ticket in a folder (or back in the inbox with null), noting it in the ticket's activity. */
export async function fileTicket(env: Env, t: TicketRow, folderId: number | null, agentId: number | null) {
  const next = folderId === null || folderId === undefined ? null : Number(folderId);
  if ((t.folder_id ?? null) === next) return;
  let name = "";
  if (next !== null) {
    const f = await env.DB.prepare("SELECT name FROM folders WHERE id = ?").bind(next).first<{ name: string }>();
    if (!f) throw new HttpError(404, "That folder no longer exists");
    name = f.name;
  }
  // Filing counts as dealing with it for now: the folder only lights up when the customer writes again
  await env.DB.prepare(`UPDATE tickets SET folder_id = ?${next !== null ? ", unread = 0" : ""} WHERE id = ?`).bind(next, t.id).run();
  await logEvent(env, t.id, "folder", next === null ? "" : name, agentId);
  t.folder_id = next;
}
