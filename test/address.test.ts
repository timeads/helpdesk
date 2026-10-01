import { afterEach, describe, expect, it, vi } from "vitest";
import { sameAddress, validateAddressUps } from "../src/lib/ups";

const env = {
  UPS_CLIENT_ID: "id", UPS_CLIENT_SECRET: "secret", UPS_ACCOUNT_NUMBER: "A1B2C3", UPS_ENV: "production", SESSION_SECRET: "x".repeat(32),
  DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}) }), first: async () => null }) },
} as any;
const typed = { name: "Jane", address1: "200 west main street", city: "Austin", state: "TX", zip: "78701", country: "US" };

function mockUps(xav: any) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/oauth/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
    if (url.includes("/api/addressvalidation/v2/3")) return new Response(JSON.stringify({ XAVResponse: xav }));
    throw new Error(url);
  }));
}
afterEach(() => vi.unstubAllGlobals());
const cand = (line: string, zip = "78701", ext = "1204", cls = "2") => ({
  AddressClassification: { Code: cls },
  AddressKeyFormat: { AddressLine: line, PoliticalDivision2: "AUSTIN", PoliticalDivision1: "TX", PostcodePrimaryLow: zip, PostcodeExtendedLow: ext, CountryCode: "US" },
});

describe("address verification", () => {
  it("treats formatting, abbreviations and ZIP+4 as the same address", () => {
    expect(sameAddress(typed, { ...typed, address1: "200 W MAIN ST", city: "AUSTIN", zip: "78701-1204" })).toBe(true);
    expect(sameAddress(typed, { ...typed, address1: "210 W MAIN ST" })).toBe(false);
  });

  it("verified + residential when UPS returns a matching valid address", async () => {
    mockUps({ ValidAddressIndicator: "", Candidate: cand("200 W MAIN ST") });
    const r = await validateAddressUps(env, typed);
    expect(r).toMatchObject({ status: "valid", residential: true, suggestion: null, provider: "UPS" });
  });

  it("suggests UPS's correction when the valid address differs", async () => {
    mockUps({ ValidAddressIndicator: "", Candidate: cand("200 W MAIN ST", "78702", "", "1") });
    const r = await validateAddressUps(env, typed);
    expect(r.status).toBe("corrected");
    expect(r.residential).toBe(false);
    expect(r.suggestion).toMatchObject({ address1: "200 W MAIN ST", zip: "78702", name: "Jane" });
  });

  it("lists candidates when ambiguous, and flags addresses UPS can't find", async () => {
    mockUps({ AmbiguousAddressIndicator: "", Candidate: [cand("200 W MAIN ST"), cand("200 E MAIN ST")] });
    const amb = await validateAddressUps(env, typed);
    expect(amb.status).toBe("ambiguous");
    expect(amb.candidates?.map((c) => c.address1)).toEqual(["200 W MAIN ST", "200 E MAIN ST"]);
    mockUps({ NoCandidatesIndicator: "" });
    expect((await validateAddressUps(env, typed)).status).toBe("invalid");
  });
});
