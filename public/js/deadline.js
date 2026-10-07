// Marketplace deadlines (Amazon's latest ship / delivery dates) for the queue, order page and scan page.
import { h } from "./ui.js";

/** Marketplace deadline (e.g. Amazon's latest ship date) in this computer's time: "Wed, Oct 7, 11:59 PM". */
export const deadline = (iso) => new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
/** Ship-by chip: red once it's under 12 hours away (or past), amber under 36. */
export function shipByChip(o, small = true) {
  if (!o?.shipBy) return null;
  const left = Date.parse(o.shipBy) - Date.now();
  const cls = left < 12 * 3600_000 ? "badge bad" : left < 36 * 3600_000 ? "badge warn" : "badge plain";
  return h("span", { class: cls + (small ? " ship-by" : ""), title: `${o.marketplace ?? "Marketplace"} requires it to ship by ${deadline(o.shipBy)}${o.deliverBy ? ` and arrive by ${deadline(o.deliverBy)}` : ""}` },
    left < 0 ? `Ship-by passed · ${deadline(o.shipBy)}` : `Ship by ${deadline(o.shipBy)}`);
}
