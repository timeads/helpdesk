import { describe, expect, it } from "vitest";
import { testD1 } from "./helpers/d1";
import { checkAddress, rememberShippedAddress, trustAddress } from "../src/lib/address";

const a = { name: "Valeria", address1: "140 Newel Street", address2: "apt 3B", city: "Brooklyn", state: "NY", zip: "11222", country: "US", residential: true };
const flagUps = (env: any) => env.DB.raw.prepare("INSERT OR REPLACE INTO address_checks (hash, result, checked_at) SELECT hash, ?, checked_at FROM address_checks").run(
  JSON.stringify({ status: "invalid", residential: null, suggestion: null, provider: "UPS", message: "UPS couldn't find this address" }));

describe("addresses the team knows are right", () => {
  it("'This address is correct' sticks, even when checking again", async () => {
    const env: any = { DB: testD1() };
    const r = await trustAddress(env, a, "Tim");
    expect(r).toMatchObject({ status: "valid", message: expect.stringContaining("Marked correct by Tim") });
    expect((await checkAddress(env, { ...a, address1: "140 NEWEL STREET" }, { fresh: true })).status).toBe("valid");
  });

  it("buying a label anyway to an address UPS couldn't find remembers it as good", async () => {
    const env: any = { DB: testD1() };
    await trustAddress(env, a, "x");
    flagUps(env); // as if UPS had said it couldn't find it
    expect((await checkAddress(env, a)).status).toBe("invalid");
    await rememberShippedAddress(env, a, "Tim");
    expect((await checkAddress(env, a)).status).toBe("valid");
  });
});
