import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain JS module from the browser app
import { api, ApiError } from "../public/js/api.js";

/** Just enough DOM for the sign-in notice. */
function fakeDocument() {
  const toasts: { children: unknown[]; append: (...n: unknown[]) => void } = {
    children: [],
    append: (...n) => toasts.children.push(...n),
  };
  const el = () => ({
    className: "",
    textContent: "",
    isConnected: true,
    onclick: null as null | (() => void),
    setAttribute() {},
    append() {},
  });
  vi.stubGlobal("document", { createElement: el, getElementById: () => toasts });
  return toasts;
}

afterEach(() => vi.unstubAllGlobals());

describe("api() when the request never gets an answer", () => {
  it("says the sign-in ran out when Cloudflare Access redirects to its login", async () => {
    const toasts = fakeDocument();
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ type: "opaqueredirect" });
    vi.stubGlobal("fetch", fetch);
    const err = await api("/tickets/1/reply", { method: "POST", body: { text: "hi" } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("Your sign-in ran out");
    expect(fetch.mock.calls[1][1]).toMatchObject({ redirect: "manual" });
    expect(toasts.children).toHaveLength(1);
  });

  it("blames the connection when there's no redirect", async () => {
    const toasts = fakeDocument();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const err = await api("/counts").catch((e: unknown) => e);
    expect((err as ApiError).message).toMatch(/Couldn't reach the support desk/);
    expect((err as ApiError).status).toBe(0);
    expect(toasts.children).toHaveLength(0);
  });
});
