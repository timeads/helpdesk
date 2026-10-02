import type { Env } from "../env";
import { HttpError, cachedToken, deleteSetting } from "./util";

export function shopifyConfigured(env: Env) {
  return !!(env.SHOPIFY_SHOP && (env.SHOPIFY_ADMIN_TOKEN || (env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET)));
}

async function token(env: Env): Promise<string> {
  if (env.SHOPIFY_ADMIN_TOKEN) return env.SHOPIFY_ADMIN_TOKEN;
  if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) throw new HttpError(409, "Shopify is not connected");
  // Apps created in the Shopify Dev Dashboard and installed on your own store use the client-credentials grant
  return cachedToken(env, "shopify_access", async () => {
    const res = await fetch(`https://${env.SHOPIFY_SHOP}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: env.SHOPIFY_CLIENT_ID!,
        client_secret: env.SHOPIFY_CLIENT_SECRET!,
      }),
    });
    if (!res.ok) throw new HttpError(502, `Shopify auth ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { access_token: string; expires_in?: number };
    return { token: j.access_token, expiresIn: j.expires_in ?? 86399 };
  });
}

export class ShopifyAccessError extends HttpError {}

export async function shopify<T = any>(env: Env, query: string, variables: Record<string, unknown> = {}, retried = false): Promise<T> {
  const res = await fetch(`https://${env.SHOPIFY_SHOP}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-shopify-access-token": await token(env) },
    body: JSON.stringify({ query, variables }),
  });
  const denied = res.status === 401 || res.status === 403;
  let j: { data?: T; errors?: { message: string }[] } = {};
  if (!denied) {
    if (!res.ok) throw new HttpError(502, `Shopify ${res.status}: ${(await res.text()).slice(0, 300)}`);
    j = await res.json();
  }
  const messages = [...new Set((j.errors ?? []).map((e) => e.message))];
  const accessProblem = denied || messages.some((m) => /access denied|required access/i.test(m));
  // A cached client-credentials token keeps the scopes it was issued with (up to 24h).
  // After scopes change in Shopify, drop it and try once more with a fresh token.
  if (accessProblem && !retried && !env.SHOPIFY_ADMIN_TOKEN) {
    await deleteSetting(env, "shopify_access");
    return shopify<T>(env, query, variables, true);
  }
  if (denied) throw new ShopifyAccessError(502, `Shopify rejected the app's access (${res.status}). Check the app is installed on the store.`);
  if (messages.length) {
    const msg = "Shopify: " + messages.join("; ");
    throw accessProblem ? new ShopifyAccessError(502, msg) : new HttpError(502, msg);
  }
  return j.data as T;
}

export function adminOrderUrl(env: Env, gid: string) {
  const handle = env.SHOPIFY_SHOP.replace(".myshopify.com", "");
  return `https://admin.shopify.com/store/${handle}/orders/${gid.split("/").pop()}`;
}

export function adminCustomerUrl(env: Env, gid: string) {
  const handle = env.SHOPIFY_SHOP.replace(".myshopify.com", "");
  return `https://admin.shopify.com/store/${handle}/customers/${gid.split("/").pop()}`;
}

const ADDRESS = `name company address1 address2 city province provinceCode zip country countryCodeV2 phone`;

// Shopify caps each query at 1000 "cost" points, roughly one per object returned. Order lists
// therefore fetch a lean shape in small pages; product details (weight, barcode) come from a
// second batched lookup by variant ID, which also needs read_products and is skipped without it.
const PAGE = 10;

// Orders are read as they are now, after any edits or refunds: totals are Shopify's "current"
// amounts and each line's quantity is its current quantity (items removed in an order edit stay on
// the order with quantity 0, and decorate() drops them).
const ORDER_FIELDS_TEMPLATE = `
  id name createdAt cancelledAt closed note email phone tags
  displayFinancialStatus displayFulfillmentStatus
  totalPriceSet: currentTotalPriceSet { shopMoney { amount currencyCode } }
  totalShippingPriceSet: currentShippingPriceSet { shopMoney { amount currencyCode } }
  subtotalPriceSet: currentSubtotalPriceSet { shopMoney { amount } }
  totalDiscountsSet: currentTotalDiscountsSet { shopMoney { amount } }
  totalTaxSet: currentTotalTaxSet { shopMoney { amount } }
  shippingAddress { ${ADDRESS} }
  shippingLines(first: 1) { nodes { title } }
  lineItems(first: __LINES__) {
    nodes {
      id title variantTitle quantity: currentQuantity unfulfilledQuantity sku
      discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }
      image { url(transform: { maxWidth: 120 }) }
      __VARIANT__
    }
  }
  __FO__
  fulfillments(first: 3) {
    status createdAt displayStatus
    trackingInfo(first: 3) { company number url }
  }
`;

// How each part of the order is delivered (shipping vs. in-store pickup); needs the fulfillment-order scopes
const FO_FIELDS = "fulfillmentOrders(first: 5) { nodes { id status deliveryMethod { methodType } } }";

const orderFields = (lines: number, variant: boolean, fo = true) =>
  ORDER_FIELDS_TEMPLATE.replace("__LINES__", String(lines)).replace("__VARIANT__", variant ? "variant { id }" : "").replace("__FO__", fo ? FO_FIELDS : "");

/** Runs an order query; if product or fulfillment-order access is missing, retries without those fields. */
async function withOrderFields<T>(lines: number, run: (fields: string) => Promise<T>): Promise<T> {
  let variant = true;
  let fo = true;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await run(orderFields(lines, variant, fo));
    } catch (e) {
      if (!(e instanceof ShopifyAccessError)) throw e;
      if (fo && /fulfillment ?order/i.test(e.message)) fo = false;
      else if (variant && /read_products|variant/i.test(e.message)) variant = false;
      else throw e;
    }
  }
  return run(orderFields(lines, false, false));
}

export interface ShopifyOrder {
  id: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  closed: boolean;
  note: string | null;
  email: string | null;
  phone: string | null;
  tags: string[];
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  totalShippingPriceSet?: { shopMoney: { amount: string; currencyCode: string } };
  subtotalPriceSet?: { shopMoney: { amount: string } } | null;
  totalDiscountsSet?: { shopMoney: { amount: string } } | null;
  totalTaxSet?: { shopMoney: { amount: string } } | null;
  shippingAddress: Record<string, string | null> | null;
  shippingLines: { nodes: { title: string }[] };
  lineItems: {
    nodes: {
      id: string;
      title: string;
      variantTitle: string | null;
      quantity: number;
      unfulfilledQuantity?: number;
      sku: string | null;
      image: { url: string } | null;
      discountedUnitPriceAfterAllDiscountsSet?: { shopMoney: { amount: string } };
      variant?: {
        id: string;
        barcode?: string | null;
        inventoryItem?: {
          measurement: { weight: { value: number; unit: string } | null };
          harmonizedSystemCode?: string | null;
          countryCodeOfOrigin?: string | null;
        } | null;
      } | null;
    }[];
  };
  fulfillmentOrders?: { nodes: { id: string; status: string; deliveryMethod: { methodType: string } | null }[] };
  fulfillments: {
    status: string;
    createdAt: string;
    displayStatus: string | null;
    trackingInfo: { company: string | null; number: string | null; url: string | null }[];
  }[];
  adminUrl?: string;
}

/**
 * The order as far as shipping is concerned: only what's still to ship. After a partial shipment
 * the rest of the order keeps its line items, with their remaining quantities.
 */
export function remaining(o: ShopifyOrder): ShopifyOrder {
  if (!o.lineItems.nodes.some((l) => typeof l.unfulfilledQuantity === "number")) return o;
  return { ...o, lineItems: { ...o.lineItems, nodes: o.lineItems.nodes.map((l) => ({ ...l, quantity: Math.min(l.quantity, l.unfulfilledQuantity ?? l.quantity) })).filter((l) => l.quantity > 0) } };
}

function decorate(env: Env, o: ShopifyOrder): ShopifyOrder {
  return {
    ...o,
    tags: o.tags ?? [],
    lineItems: { ...o.lineItems, nodes: o.lineItems.nodes.filter((l) => l.quantity > 0) },
    adminUrl: adminOrderUrl(env, o.id),
  };
}

/** Adds barcode + weight to each line's variant with one batched lookup per 50 variants. */
async function enrichVariants(env: Env, orders: ShopifyOrder[]): Promise<ShopifyOrder[]> {
  const ids = [...new Set(orders.flatMap((o) => o.lineItems.nodes.map((l) => l.variant?.id).filter(Boolean) as string[]))];
  if (!ids.length) return orders;
  const info = new Map<string, { barcode: string | null; inventoryItem: any }>();
  const run = async (customs: boolean) => {
    for (let i = 0; i < ids.length; i += 50) {
      const data = await shopify<{ nodes: ({ id: string; barcode: string | null; inventoryItem: any } | null)[] }>(
        env,
        `query Variants($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id barcode inventoryItem { measurement { weight { value unit } } ${customs ? "harmonizedSystemCode countryCodeOfOrigin" : ""} } } } }`,
        { ids: ids.slice(i, i + 50) },
      );
      for (const n of data.nodes) if (n?.id) info.set(n.id, n);
    }
  };
  try {
    // Customs codes come along when the app may read them; weights and barcodes either way
    await run(true).catch(() => run(false));
  } catch {
    return orders; // weights and barcodes are conveniences
  }
  for (const o of orders) for (const l of o.lineItems.nodes) if (l.variant?.id && info.has(l.variant.id)) l.variant = { ...l.variant, ...info.get(l.variant.id)! };
  return orders;
}

function quoteSearch(v: string) {
  return `"${v.replace(/["\\]/g, "")}"`;
}

/** Pages through an orders search, PAGE at a time (keeps each request under the cost cap). */
async function pagedOrders(env: Env, query: string, max: number, oldestFirst = false): Promise<ShopifyOrder[]> {
  const out: ShopifyOrder[] = [];
  let after: string | null = null;
  while (out.length < max) {
    const data: { orders: { nodes: ShopifyOrder[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await withOrderFields(20, (fields) =>
      shopify(
        env,
        `query Orders($q: String!, $after: String, $n: Int!) {
          orders(first: $n, after: $after, query: $q, sortKey: CREATED_AT, reverse: ${oldestFirst ? "false" : "true"}) {
            nodes { ${fields} } pageInfo { hasNextPage endCursor }
          }
        }`,
        { q: query, after, n: Math.min(PAGE, max - out.length) },
      ),
    );
    out.push(...data.orders.nodes.map((o) => decorate(env, o)));
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
  return out;
}

export async function customerProfile(env: Env, email: string) {
  const data = await shopify<{ customers: { nodes: any[] } }>(
    env,
    `query Customer($cq: String!) {
      customers(first: 1, query: $cq) {
        nodes {
          id displayName email phone note tags createdAt
          numberOfOrders
          amountSpent { amount currencyCode }
          defaultAddress { ${ADDRESS} }
        }
      }
    }`,
    { cq: `email:${quoteSearch(email)}` },
  );
  const orders = await pagedOrders(env, `email:${quoteSearch(email)}`, 10);
  const customer = data.customers.nodes[0] ?? null;
  return {
    customer: customer ? { ...customer, adminUrl: adminCustomerUrl(env, customer.id) } : null,
    orders,
  };
}

export const OPEN_TO_SHIP = "status:open AND (fulfillment_status:unfulfilled OR fulfillment_status:partial)";

/** Everything waiting to ship (oldest first), with product weights and barcodes. */
export async function queueOrders(env: Env, max = 60) {
  return enrichVariants(env, await pagedOrders(env, OPEN_TO_SHIP, max, true));
}

/** Orders for the shipping screen: open & unshipped by default, or a search by order number / name / email. */
export async function searchOrders(env: Env, search: string) {
  const s = search.trim();
  let query = OPEN_TO_SHIP;
  if (s) {
    if (/^#?[\w-]*\d[\w-]*$/.test(s) && !s.includes("@")) query = `name:${quoteSearch(s.startsWith("#") ? s : "#" + s)}`;
    else if (s.includes("@")) query = `email:${quoteSearch(s)}`;
    else query = s.replace(/["\\]/g, "");
  }
  return enrichVariants(env, await pagedOrders(env, query, s ? 20 : 60, !s));
}

export async function getOrder(env: Env, id: string) {
  const data = await withOrderFields(50, (fields) =>
    shopify<{ order: ShopifyOrder | null }>(env, `query Order($id: ID!) { order(id: $id) { ${fields} } }`, { id }),
  );
  if (!data.order) throw new HttpError(404, "Order not found");
  const [o] = await enrichVariants(env, [decorate(env, data.order)]);
  return o;
}

/** Several orders by ID (packing slips, bulk actions), 10 per request to stay under the cost cap. */
export async function ordersByIds(env: Env, ids: string[]): Promise<ShopifyOrder[]> {
  const out: ShopifyOrder[] = [];
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    const data = await withOrderFields(25, (fields) =>
      shopify<{ nodes: (ShopifyOrder | null)[] }>(env, `query Orders($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { ${fields} } } }`, { ids: chunk }),
    );
    out.push(...data.nodes.filter((n): n is ShopifyOrder => !!n?.id).map((o) => decorate(env, o)));
  }
  return enrichVariants(env, out);
}

/** Finds an order by its name as printed/scanned (e.g. "#68762-TG", "68762-TG" or "68762"). */
export async function findOrderByName(env: Env, raw: string) {
  const name = raw.trim().replace(/^#?/, "#");
  const found = await pagedOrders(env, `name:${quoteSearch(name)}`, 1);
  if (!found.length) throw new HttpError(404, `No order ${name}`);
  return getOrder(env, found[0].id);
}

/**
 * Cancels the Shopify fulfillment a voided label created, so the order is unfulfilled again.
 * Without a saved id it's found by tracking number. Returns false when there's nothing to cancel.
 */
export async function cancelFulfillment(env: Env, orderId: string, fulfillmentId: string | null, tracking: string[]): Promise<boolean> {
  let id = fulfillmentId;
  if (!id) {
    const data = await shopify<{ order: { fulfillments: { id: string; status: string; trackingInfo: { number: string | null }[] }[] } | null }>(
      env,
      `query F($id: ID!) { order(id: $id) { fulfillments(first: 20) { id status trackingInfo(first: 10) { number } } } }`,
      { id: orderId },
    );
    const f = (data.order?.fulfillments ?? []).find((x) => x.status !== "CANCELLED" && x.trackingInfo.some((t) => t.number && tracking.includes(t.number)));
    id = f?.id ?? null;
  }
  if (!id) return false;
  const res = await shopify<{ fulfillmentCancel: { fulfillment: { id: string; status: string } | null; userErrors: { message: string }[] } }>(
    env,
    `mutation C($id: ID!) { fulfillmentCancel(id: $id) { fulfillment { id status } userErrors { message } } }`,
    { id },
  );
  if (res.fulfillmentCancel.userErrors.length) throw new HttpError(422, "Shopify: " + res.fulfillmentCancel.userErrors.map((e) => e.message).join("; "));
  return true;
}

/** In-store pickup: tells Shopify the order is ready to collect (Shopify emails the customer). */
export async function markReadyForPickup(env: Env, orderId: string) {
  const fo = await shopify<{ order: { fulfillmentOrders: { nodes: { id: string; status: string; deliveryMethod: { methodType: string } | null }[] } } }>(
    env,
    `query FO($id: ID!) { order(id: $id) { fulfillmentOrders(first: 10) { nodes { id status deliveryMethod { methodType } } } } }`,
    { id: orderId },
  );
  const open = fo.order.fulfillmentOrders.nodes.filter((n) => ["OPEN", "IN_PROGRESS"].includes(n.status) && n.deliveryMethod?.methodType === "PICK_UP");
  if (!open.length) throw new HttpError(409, "Shopify doesn't have this order set up for in-store pickup (or it's already been picked up)");
  const res = await shopify<{ fulfillmentOrderLineItemsPreparedForPickup: { userErrors: { message: string }[] } }>(
    env,
    `mutation R($input: FulfillmentOrderLineItemsPreparedForPickupInput!) { fulfillmentOrderLineItemsPreparedForPickup(input: $input) { userErrors { message } } }`,
    { input: { lineItemsByFulfillmentOrder: open.map((n) => ({ fulfillmentOrderId: n.id })) } },
  );
  if (res.fulfillmentOrderLineItemsPreparedForPickup.userErrors.length) {
    throw new HttpError(422, "Shopify: " + res.fulfillmentOrderLineItemsPreparedForPickup.userErrors.map((e) => e.message).join("; "));
  }
}

export async function fulfillOrder(
  env: Env,
  orderId: string,
  tracking: { numbers: string[]; urls: string[]; company: string } | null, // null: in-store pickup (no tracking)
  notifyCustomer: boolean,
  only?: { id: string; qty: number }[], // partial shipment: these order line items and quantities only
) {
  type FoLine = { id: string; remainingQuantity: number; lineItem: { id: string } };
  const fo = await shopify<{ order: { fulfillmentOrders: { nodes: { id: string; status: string; lineItems: { nodes: FoLine[] } }[] } } }>(
    env,
    `query FO($id: ID!) { order(id: $id) { fulfillmentOrders(first: 10) { nodes { id status lineItems(first: 100) { nodes { id remainingQuantity lineItem { id } } } } } } }`,
    { id: orderId },
  );
  const open = fo.order.fulfillmentOrders.nodes.filter((n) => ["OPEN", "IN_PROGRESS"].includes(n.status));
  if (!open.length) throw new HttpError(409, "This order has nothing left to fulfill in Shopify");
  let byFo: { fulfillmentOrderId: string; fulfillmentOrderLineItems?: { id: string; quantity: number }[] }[] = open.map((n) => ({ fulfillmentOrderId: n.id }));
  if (only) {
    // Spread each line's quantity over the fulfillment order lines that still have it
    const want = new Map(only.filter((x) => x.qty > 0).map((x) => [x.id, x.qty]));
    byFo = open.map((n) => ({
      fulfillmentOrderId: n.id,
      fulfillmentOrderLineItems: n.lineItems.nodes.flatMap((li) => {
        const left = want.get(li.lineItem.id) ?? 0;
        const take = Math.min(left, li.remainingQuantity);
        if (take <= 0) return [];
        want.set(li.lineItem.id, left - take);
        return [{ id: li.id, quantity: take }];
      }),
    })).filter((x) => x.fulfillmentOrderLineItems.length);
    if (!byFo.length) throw new HttpError(409, "None of those items are left to fulfill in Shopify");
  }
  const res = await shopify<{ fulfillmentCreate: { fulfillment: { id: string } | null; userErrors: { message: string }[] } }>(
    env,
    `mutation Fulfill($f: FulfillmentInput!) {
      fulfillmentCreate(fulfillment: $f) { fulfillment { id } userErrors { message } }
    }`,
    {
      f: {
        lineItemsByFulfillmentOrder: byFo,
        ...(tracking ? { trackingInfo: tracking } : {}),
        notifyCustomer,
      },
    },
  );
  if (res.fulfillmentCreate.userErrors.length) {
    throw new HttpError(422, "Shopify: " + res.fulfillmentCreate.userErrors.map((e) => e.message).join("; "));
  }
  return res.fulfillmentCreate.fulfillment;
}

/** One-off discount code from the composer (needs the write_discounts scope). */
export async function createDiscountCode(
  env: Env,
  input: { code: string; kind: "percentage" | "amount"; value: number; title?: string; days?: number },
) {
  const value =
    input.kind === "percentage"
      ? { percentage: Math.min(1, Math.max(0.01, input.value / 100)) }
      : { discountAmount: { amount: input.value.toFixed(2), appliesOnEachItem: false } };
  const startsAt = new Date().toISOString();
  const res = await shopify<{
    discountCodeBasicCreate: { codeDiscountNode: { id: string } | null; userErrors: { field: string[] | null; message: string }[] };
  }>(
    env,
    `mutation Discount($d: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $d) { codeDiscountNode { id } userErrors { field message } }
    }`,
    {
      d: {
        title: input.title || `Support: ${input.code}`,
        code: input.code,
        startsAt,
        ...(input.days ? { endsAt: new Date(Date.now() + input.days * 86400_000).toISOString() } : {}),
        usageLimit: 1,
        appliesOncePerCustomer: true,
        context: { all: "ALL" },
        customerGets: { value, items: { all: true } },
      },
    },
  );
  const errs = res.discountCodeBasicCreate.userErrors;
  if (errs.length) throw new HttpError(422, "Shopify: " + errs.map((e) => e.message).join("; "));
  return { id: res.discountCodeBasicCreate.codeDiscountNode!.id, code: input.code };
}
