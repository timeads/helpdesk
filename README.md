# Tuft the World Support

A small, self-hosted helpdesk that replaces Redo's ticketing for **support@tufttheworld.com**.

- Every customer email becomes a **ticket**. Replies stay threaded in Gmail.
- **Statuses:** Open, In progress (waiting on the customer), Snoozed (comes back at a set time), Closed, Archived, Spam and Trash. Customer replies reopen a ticket.
- **Organize:** assign (manually, round robin or balanced), priority, tags in groups, saved **views** with live counts, filters, bulk actions, merge (automatic within 24 h, or by hand), CSV export.
- **Reply** with rich text: reply, reply all, forward, cc/bcc, attachments, **macros** with variables (`{{customer.first_name}}`, `{{order.tracking_url}}` …) and automations, **Shopify discount codes**, undo send. **Internal notes** support @mentions (see the Mentions view).
- **Rules** run when a ticket is created, a customer writes, a teammate replies or the status changes: tag, set priority/status, assign, or auto-reply with a macro. Every run shows in the ticket's Activity tab.
- The customer's **Shopify orders** sit beside the conversation: items, payment and fulfillment status, tracking, and ship-to address. Use **Add to reply** to paste an order summary into your reply.
- **Send & close** sends the reply, closes the ticket, archives the Gmail thread and opens the next ticket.
- **Shipping:** pick an unfulfilled order, enter the box and weight, compare **UPS rates** (your negotiated prices) and buy a **4×6 label**. You can print it from the browser or download ZPL for a thermal printer. The tracking number is written back to Shopify and the customer gets Shopify's shipping email.
- **AI** (optional, your own Anthropic key): drafts replies (about 1–2¢ each) from the conversation, the customer's orders and your **AI knowledge** entries, and writes on-demand **insights** (summary, mood, request type).
- **History:** Settings → Email → *Import older email* brings past conversations (up to 5 years, inbox and archived) in as closed tickets for customer history, search and analytics.

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
   `read_customers, read_orders, read_products, read_fulfillments, write_fulfillments, read_merchant_managed_fulfillment_orders, write_merchant_managed_fulfillment_orders, write_discounts` (the last one is only needed for discount codes from the composer)
3. Install or release it on **Tuft the World**.
4. After you've signed in (step 6), open **Settings → Credentials → Shopify**. Enter the store address and **either** the Client ID + Client secret (Dev Dashboard apps) **or** the Admin API access token (`shpat_…`, older custom apps). Click **Save**, and the connection test runs automatically.

### 4. UPS: rates and labels

1. Sign in at [developer.ups.com](https://developer.ups.com) with your UPS.com login and go to **Apps → Add Apps**.
2. Link your **UPS shipper account**, then add the **Authorization (OAuth)**, **Rating**, **Shipping** and **Address Validation – Street Level** products.
3. In the app, open **Settings → Credentials → UPS**. Enter the Client ID, Client secret and your 6-character UPS account number, then click **Save**.

Mode starts on **test**, so labels aren't billed. When a test label prints correctly, switch Mode to **production** in the same place.

> **International:** orders going abroad get a customs list (plain description, HS code, country of origin, value per item) filled from the order. HS codes and origin set on products in Shopify are used first, and whatever you enter is remembered per product. UPS gets a commercial invoice (printable PDF next to the label, or paperless if UPS Paperless Invoice is on for your account); USPS international goes through EasyPost with its customs form. Defaults (signer, duties paid by, contents type) are in **Settings → International & customs**. Shipments over $2,500 per HS code need an export filing (AES) first and are stopped.

### 4b. (Optional) USPS through EasyPost

1. Create an account at [easypost.com](https://www.easypost.com) and add a payment method. ACH (bank) avoids the 3.75% card fee on wallet top-ups.
2. Go to **Account → API Keys** and copy the **Production** key (starts with `EZAK`).
3. In the app: **Settings → Credentials → USPS (EasyPost)**, paste it, **Save**. USPS Ground Advantage, Priority Mail and Priority Mail Express then show next to UPS everywhere rates appear, each with its margin. USPS labels are US-only for now.

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

### Deploying from GitHub (Cloudflare Workers Builds)

In the Worker's **Settings → Build**:

- **Deploy command:** `npm run deploy:ci`
- **Variables and secrets** (Build): `SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

Every deploy then uploads those three to the running app (`scripts/write-secrets.mjs` → `wrangler deploy --secrets-file`), so a deploy can never leave the app without them. The build log lists the *names* of the secrets it included, never the values.

## Shipping day to day

- **Shipping → Orders** lists every open, unshipped Shopify order (oldest first) with saved views: Ready to ship, Priority, Payment pending, On hold, International, All open. Tick orders to **buy labels in bulk** (by rule, cheapest, fastest or a specific UPS service), **print packing slips**, or **hold / release**. The **UPS quote · margin** column fills in by itself (hover it to see every service), and the bulk bar shows the estimated spend and margin for the selected orders. Click an order for the full label builder: UPS rates load automatically and refresh as you change the box, weight or address, each service shows your margin (shipping paid − label), and the Buy button shows the margin of the service you picked.
- **Address checks:** every US ship-to address is checked once (UPS Address Validation in production mode, else EasyPost at about 2¢) and marked Verified, Suggested fix or Address not found. The label screen offers the corrected address in one click and sets residential/business automatically; bulk buying skips orders whose address needs a look.
- **Big orders:** *Add a box* splits a shipment into several boxes. Assign items to each box (or *Split evenly*); box weights fill in from Shopify product weights. You get one UPS shipment with a label and tracking number per box, plus printable "Box 2 of 3" contents slips.
- **Shipping rules** (Settings) pick the box, signature, service, or hold an order. When no rule applies, the box and weight you used last time for the same items are reused (package learning).
- **Scan & pack**: scan the barcode on the packing slip, scan each item (SKU or barcode), then **Verify & print label**.
- **Label batches**: every label run is a batch you can reprint or void.
- **Dashboard** (top of the sidebar): label spend vs shipping collected, margin, negotiated savings, order-to-ship time, service mix, destinations, plus support volume and first-reply time.

### Printing straight to the Zebra

1. On the packing computer, install **Zebra Browser Print** (free, from zebra.com) and set the ZT220 as its default printer.
2. Open https://localhost:9101/ssl_support once and accept it.
3. In the helpdesk: **Settings → Printing on this computer → Zebra thermal printer**, then **Print test label**.

Labels then print with no dialog. The setting is per computer; packing slips use the normal print dialog (4×6 or Letter).

## Everyday use

Press `?` in the inbox for the full list.

| Key | Action |
| --- | --- |
| `j` / `k` | next / previous ticket |
| `/` | search |
| `r` / `n` / `f` | reply / internal note / forward |
| `e` or `Alt+C` | close |
| `Alt+R` / `Alt+I` / `Alt+M` | reopen / mark in progress / mark as spam |
| `a` / `m` | assign… / assign to me |
| `s` / `t` / `p` | snooze / tags / priority |
| `x` | select ticket for bulk actions |
| `c` | new email |
| `⌘/Ctrl + Enter` | send (ticket becomes *In progress*) |
| `⌘/Ctrl + Shift + Enter` | send & close, then open the next ticket |
| `⌘/Ctrl + 5` | create a discount code |

- Newsletters, mailing lists and auto-replies don't become tickets. You can also block senders in **Settings → Email**.
- Replies you send from Gmail directly still show up in the ticket, and archiving a thread in Gmail closes its ticket (Settings → Tickets).
- Macros and AI knowledge can be imported from CSV (Settings → Macros / AI knowledge → Import CSV).

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
