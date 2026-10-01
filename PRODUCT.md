# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Tim, owner of Tuft the World (rug-tufting supplies, Philadelphia), working the support inbox himself — currently the only agent, with room for more later. Tickets are handled at a desktop in the studio and from a phone on the go; shipping labels are only made at the desktop next to the label printer. Volume is light: under 10 support emails on a normal day, heavier around BFCM.

## Product Purpose
A self-hosted replacement for Redo's helpdesk. Every customer email to support@tufttheworld.com becomes a ticket; the customer's Shopify orders sit beside the conversation so a question can be answered without opening Shopify. Reply, or Send & close to move straight to the next ticket. A shipping area buys UPS labels for Shopify orders and marks them fulfilled. Optional AI drafts, paid per use on the owner's own key. Success: the inbox gets to zero quickly, each reply is accurate to the customer's real order, and Redo's subscription can be cancelled.

## Positioning
Owned outright and built only for Tuft the World's real workflow — one store, one mailbox, UPS — with none of the multi-brand, chatbot, returns or marketing surface area of Redo.

## Operating Context
- Gmail (Google Workspace) mailbox support@tufttheworld.com; replies thread in Gmail and closed tickets are archived there.
- Shopify store "Tuft the World" (tufttheworld.myshopify.com) is the order source. Separate Canada and Superfluous Things stores are out of scope.
- UPS account for labels; 4×6 labels printed from the desktop browser or as ZPL for a thermal printer.
- Hosted on Cloudflare Workers + D1; sign-in with Google.

## Capabilities and Constraints
- Ticket views: assigned to me, unassigned, all open, pending (waiting on customer), closed; search; keyboard shortcuts.
- Internal notes, saved replies with {{first_name}}/{{agent_name}}, attachments both ways.
- Customer panel: Shopify profile, order history with items, payment/fulfillment status, tracking, ship-to; "insert order in reply"; jump to label.
- Shipping: unfulfilled orders, ship-to editing, box presets, multi-package UPS rates (negotiated), buy/print/void, Shopify fulfillment + customer notification.
- US domestic UPS only for now (no customs forms). Website chat widget is a phase-two idea.

## Brand Commitments
Must match the Tuft the World store brand (from the live Shopify theme):
- Colors: deep teal #213838 (top bar, accent), ochre #c78c2b (buttons, links), brick red #b03424 (link hover), charcoal #404040 (text), warm stone #cec6bf (borders), near-black #222222 (footer), mint #b4eaba and khaki #b4b098 (footer accents), teal #0fa0ac ("new" banners).
- Type: Abril Fatface (logo, uppercase), Chivo (headlines and uppercase nav), Roboto (body).
- Logo assets on Shopify Files: Logo_Simple_RGB.png (wordmark), Badge_Circle_RGB.png, Badge_U-Shape_RGB.png.

## Evidence on Hand
No real customer data is committed; scripts/demo-seed.sql holds clearly fake sample tickets for local previews. Do not fabricate customer quotes, metrics or testimonials.

## Product Principles
1. The next ticket is always one keystroke away — speed through the queue beats ornament.
2. The customer's real order context is never more than a glance away.
3. Nothing is sent, bought, or charged without an explicit click; costs are always shown before they happen.
4. Works one-handed on a phone for replies; desktop-first for labels.
5. Small-business ownership: no per-seat fees, no feature sprawl.
