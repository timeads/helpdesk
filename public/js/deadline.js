// Marketplace deadlines (Amazon's latest ship / delivery dates) for the queue, order page and scan page.
import { h } from "./ui.js";

// Amazon's deadlines are the end of a day in Pacific time (11:59 PM PT, which is 2:59 AM the next morning
// in Eastern). Shown as that calendar day, they read the way they're meant: "Deliver by Thu, Oct 15".
const day = (iso, opts = {}) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", ...opts });
const today = (iso) => day(iso) === day(new Date().toISOString());
const exact = (iso) => `${new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET`;

/** "Thu, Oct 15" (or "today, Wed, Oct 7"). */
export const deadline = (iso) => (today(iso) ? `today, ${day(iso)}` : day(iso));

/** Ship-by chip: red when it's due today (or past), amber when it's due tomorrow. */
export function shipByChip(o, small = true) {
  if (!o?.shipBy) return null;
  const left = Date.parse(o.shipBy) - Date.now();
  const cls = left < 0 || today(o.shipBy) ? "badge bad" : left < 48 * 3600_000 ? "badge warn" : "badge plain";
  return h("span", { class: cls + (small ? " ship-by" : ""), title: `${o.marketplace ?? "Marketplace"}'s cutoff: ship by ${exact(o.shipBy)}${o.deliverBy ? `, delivered by ${exact(o.deliverBy)}` : ""}` },
    left < 0 ? `Ship-by passed (${day(o.shipBy)})` : `Ship by ${deadline(o.shipBy)}`);
}
