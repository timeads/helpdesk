// Marketplace deadlines (Amazon's latest ship / delivery dates) for the queue, order page and scan page.
import { h } from "./ui.js";

/** Marketplace deadline in Eastern time (the shop is in Philadelphia): "Thu, Oct 8, 2:59 AM ET". */
export const deadline = (iso) => `${new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET`;
/** Ship-by chip: red once it's under 12 hours away (or past), amber under 36. */
export function shipByChip(o, small = true) {
  if (!o?.shipBy) return null;
  const left = Date.parse(o.shipBy) - Date.now();
  const cls = left < 12 * 3600_000 ? "badge bad" : left < 36 * 3600_000 ? "badge warn" : "badge plain";
  return h("span", { class: cls + (small ? " ship-by" : ""), title: `${o.marketplace ?? "Marketplace"} requires it to ship by ${deadline(o.shipBy)}${o.deliverBy ? ` and arrive by ${deadline(o.deliverBy)}` : ""}` },
    left < 0 ? `Ship-by passed · ${deadline(o.shipBy)}` : `Ship by ${deadline(o.shipBy)}`);
}
