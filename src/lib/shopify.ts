import type { Env } from "../env";
import { HttpError, cachedToken } from "./util";

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

export async function shopify<T = any>(env: Env, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`https://${env.SHOPIFY_SHOP}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-shopify-access-token": await token(env) },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new HttpError(502, `Shopify ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (j.errors?.length) throw new HttpError(502, "Shopify: " + j.errors.map((e) => e.message).join("; "));
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

const ORDER_FIELDS = `
  id name createdAt cancelledAt closed note email phone
  displayFinancialStatus displayFulfillmentStatus
  totalPriceSet { shopMoney { amount currencyCode } }
  shippingAddress { ${ADDRESS} }
  shippingLines(first: 1) { nodes { title } }
  lineItems(first: 30) {
    nodes {
      id title variantTitle quantity sku
      originalUnitPriceSet { shopMoney { amount currencyCode } }
      image { url(transform: { maxWidth: 120 }) }
      variant { inventoryItem { measurement { weight { value unit } } } }
    }
  }
  fulfillments(first: 10) {
    status createdAt displayStatus
    trackingInfo(first: 5) { company number url }
  }
`;

export interface ShopifyOrder {
  id: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  closed: boolean;
  note: string | null;
  email: string | null;
  phone: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  shippingAddress: Record<string, string | null> | null;
  shippingLines: { nodes: { title: string }[] };
  lineItems: {
    nodes: {
      id: string;
      title: string;
      variantTitle: string | null;
      quantity: number;
      sku: string | null;
      originalUnitPriceSet: { shopMoney: { amount: string; currencyCode: string } };
      image: { url: string } | null;
      variant: { inventoryItem: { measurement: { weight: { value: number; unit: string } | null } } | null } | null;
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
  return { ...o, adminUrl: adminOrderUrl(env, o.id) };
}

function quoteSearch(v: string) {
  return `"${v.replace(/["\\]/g, "")}"`;
}

export async function customerProfile(env: Env, email: string) {
  const data = await shopify<{
    customers: { nodes: any[] };
    orders: { nodes: ShopifyOrder[] };
  }>(
    env,
    `query Customer($cq: String!, $oq: String!) {
      customers(first: 1, query: $cq) {
        nodes {
          id displayName email phone note tags createdAt
          numberOfOrders
          amountSpent { amount currencyCode }
          defaultAddress { ${ADDRESS} }
        }
      }
      orders(first: 20, query: $oq, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } }
    }`,
    { cq: `email:${quoteSearch(email)}`, oq: `email:${quoteSearch(email)}` },
  );
  const customer = data.customers.nodes[0] ?? null;
  return {
    customer: customer ? { ...customer, adminUrl: adminCustomerUrl(env, customer.id) } : null,
    orders: data.orders.nodes.map((o) => decorate(env, o)),
  };
}

/** Orders for the shipping screen: unfulfilled by default, or a search by order number / name / email. */
export async function searchOrders(env: Env, search: string) {
  const s = search.trim();
  let query = "fulfillment_status:unfulfilled AND status:open";
  if (s) {
    if (/^#?\d+$/.test(s)) query = `name:${quoteSearch("#" + s.replace("#", ""))}`;
    else if (s.includes("@")) query = `email:${quoteSearch(s)}`;
    else query = s.replace(/["\\]/g, "");
  }
  const data = await shopify<{ orders: { nodes: ShopifyOrder[] } }>(
    env,
    `query Orders($q: String!) { orders(first: 50, query: $q, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } } }`,
    { q: query },
  );
  return data.orders.nodes.map((o) => decorate(env, o));
}

export async function getOrder(env: Env, id: string) {
  const data = await shopify<{ order: ShopifyOrder | null }>(
    env,
    `query Order($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`,
    { id },
  );
  if (!data.order) throw new HttpError(404, "Order not found");
  return decorate(env, data.order);
}

/** Mark every open fulfillment order on this order as shipped with the given tracking. */
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
