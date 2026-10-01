import { describe, expect, it } from "vitest";
import { buildRateRequest, buildShipRequest, parseRates, parseShipResponse, type Address } from "../src/lib/ups";

const from: Address = { name: "Tim", company: "Tuft the World", phone: "(215) 555-0100", address1: "1901 S 9th St", city: "Philadelphia", state: "PA", zip: "19148", country: "US" };
const to: Address = { name: "Jane Doe", address1: "1 Main St", address2: "Apt 2", city: "Austin", state: "TX", zip: "78701", country: "US", residential: true };

describe("UPS requests", () => {
  it("builds a shop-rates request with negotiated rates", () => {
    const r = buildRateRequest("A1B2C3", from, to, [{ length: 12, width: 10, height: 6.2, weight: 3.14 }]);
    const s = r.RateRequest.Shipment;
    expect(r.RateRequest.Request.RequestOption).toBe("Shop");
    expect(s.Shipper.ShipperNumber).toBe("A1B2C3");
    expect(s.Shipper.Phone).toEqual({ Number: "2155550100" });
    expect(s.ShipTo.Address).toMatchObject({ AddressLine: ["1 Main St", "Apt 2"], ResidentialAddressIndicator: "" });
    expect(s.Package[0]).toMatchObject({
      PackagingType: { Code: "02" },
      Dimensions: { Length: "12", Width: "10", Height: "7" },
      PackageWeight: { Weight: "3.1" },
    });
  });

  it("builds a ship request using Packaging (not PackagingType)", () => {
    const r = buildShipRequest("A1B2C3", from, to, [{ length: 8, width: 6, height: 4, weight: 0.05 }], "03", { reference: "#1001", labelFormat: "GIF" });
    expect(r.ShipmentRequest.Shipment.Service.Code).toBe("03");
    expect(r.ShipmentRequest.Shipment.Package[0]).toHaveProperty("Packaging");
    expect(r.ShipmentRequest.Shipment.Package[0].PackageWeight.Weight).toBe("0.1");
    expect(r.ShipmentRequest.LabelSpecification.LabelImageFormat.Code).toBe("GIF");
  });

  it("parses single and multiple rated shipments, preferring negotiated", () => {
    const one = parseRates({ RateResponse: { RatedShipment: { Service: { Code: "03" }, TotalCharges: { MonetaryValue: "12.50", CurrencyCode: "USD" } } } });
    expect(one).toEqual([{ serviceCode: "03", serviceName: "UPS Ground", total: 12.5, listTotal: 12.5, currency: "USD", days: null }]);
    const many = parseRates({
      RateResponse: {
        RatedShipment: [
          { Service: { Code: "01" }, TotalCharges: { MonetaryValue: "60.00", CurrencyCode: "USD" }, GuaranteedDelivery: { BusinessDaysInTransit: "1" } },
          { Service: { Code: "03" }, TotalCharges: { MonetaryValue: "14.00", CurrencyCode: "USD" }, NegotiatedRateCharges: { TotalCharge: { MonetaryValue: "9.80" } } },
        ],
      },
    });
    expect(many.map((r) => [r.serviceCode, r.total])).toEqual([["03", 9.8], ["01", 60]]);
    expect(many[1].days).toBe(1);
  });

  it("parses a ship response", () => {
    const r = parseShipResponse({
      ShipmentResponse: {
        ShipmentResults: {
          ShipmentIdentificationNumber: "1ZSHIP",
          ShipmentCharges: { TotalCharges: { MonetaryValue: "11.20", CurrencyCode: "USD" } },
          PackageResults: { TrackingNumber: "1Z999", ShippingLabel: { GraphicImage: "R0lGOD" } },
        },
      },
    });
    expect(r).toEqual({ shipmentId: "1ZSHIP", trackingNumbers: ["1Z999"], labels: ["R0lGOD"], cost: 11.2, currency: "USD" });
  });
});
