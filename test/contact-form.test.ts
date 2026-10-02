import { describe, expect, it } from "vitest";
import { contactFormSender } from "../src/lib/mime";

const SUPPORT = "support@tufttheworld.com";
const shopifyBody = `You received a new message from your online store's contact form.
Country Code: US
Name: Jane Rivera
Email: jane@example.com
Phone: 2155550100
Body:
My tufting gun stopped cutting.
Can you help?`;

describe("website contact form emails", () => {
  it("takes the customer from Reply-To when Shopify sends from the store's own address", () => {
    const r = contactFormSender({ from: `Tuft the World <${SUPPORT}>`, "reply-to": "Jane Rivera <jane@example.com>", subject: "New customer message on October 2, 2026 at 3:14 pm" }, shopifyBody, SUPPORT);
    expect(r).toEqual({ email: "jane@example.com", name: "Jane Rivera", message: "My tufting gun stopped cutting.\nCan you help?" });
  });

  it("falls back to the Email line in the body when there's no Reply-To", () => {
    const r = contactFormSender({ from: "Shopify <mailer@shopify.com>", subject: "New customer message" }, shopifyBody, SUPPORT);
    expect(r?.email).toBe("jane@example.com");
  });

  it("leaves ordinary customer email alone", () => {
    expect(contactFormSender({ from: "Jane <jane@example.com>", subject: "Where is my order?" }, "Hi, where is it?", SUPPORT)).toBeNull();
    expect(contactFormSender({ from: "Jane <jane@example.com>", "reply-to": "other@example.com", subject: "Order" }, "Email: x@y.com", SUPPORT)).toBeNull();
  });

  it("doesn't turn our own sent mail into a customer", () => {
    expect(contactFormSender({ from: `Tuft <${SUPPORT}>`, subject: "Re: your order" }, "Thanks!", SUPPORT)).toBeNull();
  });
});
