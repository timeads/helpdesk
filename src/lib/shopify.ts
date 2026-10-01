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

const ORDER_FIELDS_TEMPLATE = `
  id name createdAt cancelledAt closed note email phone tags
  displayFinancialStatus displayFulfillmentStatus
  totalPriceSet { shopMoney { amount currencyCode } }
  totalShippingPriceSet { shopMoney { amount currencyCode } }
  shippingAddress { ${ADDRESS} }
  shippingLines(first: 1) { nodes { title } }
  lineItems(first: __LINES__) {
    nodes {
      id title variantTitle quantity sku
      image { url(transform: { maxWidth: 120 }) }
      __VARIANT__
    }
  }
  fulfillments(first: 3) {
    status createdAt displayStatus
    trackingInfo(first: 3) { company number url }
  }
`;

const orderFields = (lines: number, variant: boolean) =>
  ORDER_FIELDS_TEMPLATE.replace("__LINES__", String(lines)).replace("__VARIANT__", variant ? "variant { id }" : "");

/** Runs an order query; if product access is missing, retries without variant fields. */
async function withOrderFields<T>(lines: number, run: (fields: string) => Promise<T>): Promise<T> {
  try {
    return await run(orderFields(lines, true));
  } catch (e) {
    if (e instanceof ShopifyAccessError && /read_products|variant/i.test(e.message)) return run(orderFields(lines, false));
    throw e;
  }
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
  shippingAddress: Record<string, string | null> | null;
  shippingLines: { nodes: { title: string }[] };
  lineItems: {
    nodes: {
      id: string;
      title: string;
      variantTitle: string | null;
      quantity: number;
      sku: string | null;
      image: { url: string } | null;
      variant?: {
        id: string;
        barcode?: string | null;
        inventoryItem?: { measurement: { weight: { value: number; unit: string } | null } } | null;
      } | null;
    }[];
  };
  fulfillments: {
    status: string;
    createdAt: string;
    displayStatus: string | null;
    trackingInfo: { company: string | null; number: string | null; url: string | null }[];
  }[];
  adminUrl?: string;
}

function decorate(env: Env, o: ShopifyOrder): ShopifyOrder {
  return { ...o, tags: o.tags ?? [], adminUrl: adminOrderUrl(env, o.id) };
}

/** Adds barcode + weight to each line's variant with one batched lookup per 50 variants. */
async function enrichVariants(env: Env, orders: ShopifyOrder[]): Promise<ShopifyOrder[]> {
  const ids = [...new Set(orders.flatMap((o) => o.lineItems.nodes.map((l) => l.variant?.id).filter(Boolean) as string[]))];
  if (!ids.length) return orders;
  const info = new Map<string, { barcode: string | null; inventoryItem: any }>();
  try {
    for (let i = 0; i < ids.length; i += 50) {
      const data = await shopify<{ nodes: ({ id: string; barcode: string | null; inventoryItem: any } | null)[] }>(
        env,
        `query Variants($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id barcode inventoryItem { measurement { weight { value unit } } } } } }`,
        { ids: ids.slice(i, i + 50) },
      );
      for (const n of data.nodes) if (n?.id) info.set(n.id, n);
    }
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

export async function fulfillOrder(
  env: Env,
  orderId: string,
  tracking: { number: string; url: string; company: string },
  notifyCustomer: boolean,
) {
  const fo = await shopify<{ order: { fulfillmentOrders: { nodes: { id: string; status: string }[] } } }>(
    env,
    `query FO($id: ID!) { order(id: $id) { fulfillmentOrders(first: 10) { nodes { id status } } } }`,
    { id: orderId },
  );
  const open = fo.order.fulfillmentOrders.nodes.filter((n) => ["OPEN", "IN_PROGRESS"].includes(n.status));
  if (!open.length) throw new HttpError(409, "This order has nothing left to fulfill in Shopify");
  const res = await shopify<{ fulfillmentCreate: { fulfillment: { id: string } | null; userErrors: { message: string }[] } }>(
    env,
    `mutation Fulfill($f: FulfillmentInput!) {
      fulfillmentCreate(fulfillment: $f) { fulfillment { id } userErrors { message } }
    }`,
    {
      f: {
        lineItemsByFulfillmentOrder: open.map((n) => ({ fulfillmentOrderId: n.id })),
        trackingInfo: tracking,
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
