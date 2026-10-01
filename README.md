# Tuft the World Support

A small, self-hosted helpdesk that replaces Redo's ticketing for **support@tufttheworld.com**.

- Every customer email becomes a **ticket**. Replies stay threaded in Gmail.
- **Assign** tickets, set them **Open / Pending / Closed**, add **internal notes**, use **saved replies**, and send **attachments**.
- The customer's **Shopify orders** sit beside the conversation: items, payment and fulfillment status, tracking, and ship-to address. Use **Add to reply** to paste an order summary into your reply.
- **Send & close** sends the reply, closes the ticket, archives the Gmail thread and opens the next ticket.
- **Shipping:** pick an unfulfilled order, enter the box and weight, compare **UPS rates** (your negotiated prices) and buy a **4×6 label**. You can print it from the browser or download ZPL for a thermal printer. The tracking number is written back to Shopify and the customer gets Shopify's shipping email.
- **Draft with AI** (optional): uses your own Anthropic API key, about 1–2¢ per draft. It reads the conversation, the customer's orders and your store guidance.

It runs on Cloudflare Workers with a D1 database, which is free at this volume. New mail is pulled from Gmail every minute.

---

## One-time setup

You'll need about 30 minutes. Do the steps in order. **Never paste a secret into chat, email or a file in this repo.**

There are two places keys can go:

- **Cloudflare secrets** (only `SESSION_SECRET`, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` must go here, because the app needs them before anyone can sign in). Add them with `npx wrangler secret put NAME`, or in the dashboard under **Workers & Pages → helpdesk → Settings → Variables and Secrets → Add → Secret**.
- **Settings → Credentials inside the app** for Shopify, UPS and the Anthropic key. Values are encrypted before they're stored, and secrets are never shown again (only their last four characters). Each service has a **Test connection** button. Values entered here override any set in Cloudflare.

### 0. Get the code onto your computer

```bash
git clone https://github.com/timeads/helpdesk && cd helpdesk
npm install
npx wrangler login          # opens Cloudflare in your browser
```

### 1. Create the database and deploy once

```bash
npx wrangler d1 create helpdesk
```

Copy the `database_id` it prints into `wrangler.jsonc` (replace the zeros), then:

```bash
npm run db:migrate                         # creates the tables
npx wrangler secret put SESSION_SECRET     # paste any long random string (e.g. from a password manager)
npm run deploy
```

The deploy prints your app's address, for example `https://helpdesk.<your-subdomain>.workers.dev`. That's **APP_URL** in the steps below.

### 2. Google: sign-in and the support@ mailbox

Sign in to Google Cloud as **tim@thisistimeads.com**. tufttheworld.com is in the same Workspace, so an *Internal* app covers support@ and kingtuft@ without Google review.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project named **helpdesk**.
2. Go to **APIs & Services → Library → Gmail API** and click **Enable**.
3. Go to **Google Auth Platform → Branding → Get started**. Name it "Tuft the World Support", set Audience to **Internal**, then save.
4. Go to **Clients → Create client**:
   - Type: **Web application**
   - Authorized redirect URI: `APP_URL/auth/google/callback`
   - For local testing, also add `http://localhost:8787/auth/google/callback`
5. Copy the client ID and secret into Cloudflare:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

### 3. Shopify: read orders, mark them fulfilled

1. In Shopify admin, go to **Settings → Apps → Develop apps**. If Shopify sends you to the **Dev Dashboard**, create the app there.
2. Create an app named **Helpdesk** with these Admin API scopes:
   `read_customers, read_orders, read_products, read_fulfillments, write_fulfillments, read_merchant_managed_fulfillment_orders, write_merchant_managed_fulfillment_orders`
3. Install or release it on **Tuft the World**.
4. After you've signed in (step 6), open **Settings → Credentials → Shopify**. Enter the store address and **either** the Client ID + Client secret (Dev Dashboard apps) **or** the Admin API access token (`shpat_…`, older custom apps). Click **Save**, and the connection test runs automatically.

### 4. UPS: rates and labels

1. Sign in at [developer.ups.com](https://developer.ups.com) with your UPS.com login and go to **Apps → Add Apps**.
2. Link your **UPS shipper account**, then add the **Authorization (OAuth)**, **Rating** and **Shipping** products.
3. In the app, open **Settings → Credentials → UPS**. Enter the Client ID, Client secret and your 6-character UPS account number, then click **Save**.

Mode starts on **test**, so labels aren't billed. When a test label prints correctly, switch Mode to **production** in the same place.

> Labels are US-domestic for now. International shipments need customs forms, which aren't built yet.

### 5. (Optional) AI drafts

Create a key at [console.anthropic.com](https://console.anthropic.com) and add some credit. Then paste the key into **Settings → Credentials → AI drafts** and pick a model. Each draft costs roughly 1–2¢ on the default model; `claude-haiku-4-5` is cheaper still.

### 6. Deploy, sign in and connect

```bash
npm run deploy
```

1. Open **APP_URL** and click **Sign in with Google** as `kingtuft@tufttheworld.com`. That account is the first admin; the list lives in `ADMIN_EMAILS` in `wrangler.jsonc`.
2. Go to **Settings → Connections → Connect Gmail** and choose **support@tufttheworld.com** on Google's screen. The last 14 days of inbox mail are imported, and new mail arrives every minute.
3. Under **Settings → Shipping**, add your ship-from address (UPS requires a phone number) and your box sizes.
4. Add some **saved replies**, and if AI drafts are on, fill in **AI guidance** with your return policy, shipping times and tone.

Once you're happy, turn off Redo's email forwarding or helpdesk so customers don't get two replies.

---

## Everyday use

| Key | Action |
| --- | --- |
| `j` / `k` | next / previous ticket |
| `r` | reply |
| `a` | assign to me |
| `e` | close ticket |
| `x` | select ticket (then Close / Assign to me / Pending for all selected) |
| `⌘/Ctrl + Enter` | send (ticket becomes *Pending*: waiting on the customer) |
| `⌘/Ctrl + Shift + Enter` | send & close, then open the next ticket |

- When a customer replies to a pending or closed ticket, it **reopens automatically**.
- Newsletters, mailing lists and auto-replies don't become tickets. You can also block senders in **Settings → Email**.
- Replies you send from Gmail directly still show up in the ticket.

## Developing locally

```bash
cp .dev.vars.example .dev.vars        # add DEV_LOGIN_EMAIL=you@… to skip Google sign-in locally
npm run db:migrate:local
npm run seed:demo                     # optional: fake sample tickets
npm run dev                           # http://localhost:8787
npm test && npm run typecheck
```

## How it's built

- `src/index.ts`: Worker entry. Serves `/api/*` and `/auth/*`, and runs the every-minute Gmail sync (cron).
- `src/lib/gmail.ts`: Gmail sync (history API), ticket creation and reopening, sending.
- `src/lib/mime.ts`: email parsing and building threaded replies.
- `src/lib/shopify.ts`: customer and order lookups, fulfillment (Admin GraphQL).
- `src/lib/ups.ts`: UPS OAuth, Rating (`Shop`), Ship and Void.
- `src/lib/ai.ts`: AI reply drafts.
- `migrations/`: D1 schema.
- `public/`: the web app (plain HTML/CSS/JS, no build step).

Gmail, Shopify and UPS access tokens are cached in D1, encrypted with `SESSION_SECRET`.

## Phase two ideas

- Website chat widget that creates tickets
- Return labels emailed to customers
- International (customs) labels
- Pulling in the Canada store's orders
