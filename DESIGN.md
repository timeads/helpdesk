---
name: Tuft the World Support
description: A self-hosted three-pane helpdesk dressed in the Tuft the World shopfront, with a teal rail, ochre actions, and warm stone hairlines.
colors:
  teal: "#213838"
  teal-2: "#2b4646"
  teal-3: "#365555"
  teal-ink: "#1a2c2c"
  teal-soft: "#e3eeec"
  on-teal: "#f3efe9"
  on-teal-2: "#b9c8c4"
  ochre: "#c78c2b"
  ochre-hover: "#b57b1d"
  ochre-text: "#8a5a10"
  ochre-soft: "#f7ecd8"
  brick: "#b03424"
  brick-soft: "#f8e3df"
  mint-soft: "#e2f5e3"
  mint-ink: "#1f5b2b"
  stone: "#cec6bf"
  stone-2: "#e6e0da"
  bg: "#ffffff"
  panel: "#f8f6f3"
  surface: "#ffffff"
  sunken: "#efebe6"
  hover: "#f3efea"
  text: "#2b2b2b"
  text-2: "#565049"
  text-3: "#6c655d"
  out: "#edf3f1"
  out-border: "#d4e2de"
  note: "#fbf2df"
  note-border: "#ecd6a6"
  select: "#fff8ea"
typography:
  display:
    fontFamily: "Abril Fatface, Georgia, serif"
    fontSize: "21px"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.02em"
  headline:
    fontFamily: "Chivo, Chivo Fallback, ui-sans-serif, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Chivo, Chivo Fallback, ui-sans-serif, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  title-sm:
    fontFamily: "Chivo, Chivo Fallback, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15.5px"
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontFamily: "Chivo, Chivo Fallback, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "tnum"
  body-read:
    fontFamily: "Roboto, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14.5px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Chivo, Chivo Fallback, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.3
  label-rail:
    fontFamily: "Chivo, Chivo Fallback, ui-sans-serif, system-ui, sans-serif"
    fontSize: "10.5px"
    fontWeight: 600
    letterSpacing: "0.16em"
rounded:
  sm: "7px"
  md: "10px"
  lg: "12px"
  xl: "16px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "22px"
  2xl: "28px"
components:
  button-primary:
    backgroundColor: "{colors.ochre}"
    textColor: "{colors.teal-ink}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.ochre-hover}"
    textColor: "{colors.teal-ink}"
  button-default:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: "36px"
  button-default-hover:
    backgroundColor: "{colors.hover}"
  button-dark:
    backgroundColor: "{colors.teal}"
    textColor: "{colors.on-teal}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: "36px"
  button-dark-hover:
    backgroundColor: "{colors.teal-2}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: "36px"
  button-ghost-danger:
    backgroundColor: "transparent"
    textColor: "{colors.brick}"
  button-sm:
    padding: "0 10px"
    height: "30px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "7px 11px"
    height: "36px"
  badge-open:
    backgroundColor: "{colors.teal-soft}"
    textColor: "{colors.teal}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
    height: "21px"
  badge-pending:
    backgroundColor: "{colors.ochre-soft}"
    textColor: "{colors.ochre-text}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
    height: "21px"
  badge-good:
    backgroundColor: "{colors.mint-soft}"
    textColor: "{colors.mint-ink}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
    height: "21px"
  badge-bad:
    backgroundColor: "{colors.brick-soft}"
    textColor: "{colors.brick}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
    height: "21px"
  badge-closed:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.text-3}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
    height: "21px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.on-teal-2}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
  nav-item-hover:
    backgroundColor: "{colors.teal-2}"
    textColor: "{colors.on-teal}"
  nav-item-active:
    backgroundColor: "{colors.teal-3}"
    textColor: "#ffffff"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "20px"
  message-in:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    typography: "{typography.body-read}"
  message-out:
    backgroundColor: "{colors.out}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    typography: "{typography.body-read}"
  note:
    backgroundColor: "{colors.note}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: "11px 16px 12px"
  toast:
    backgroundColor: "{colors.teal}"
    textColor: "{colors.on-teal}"
    rounded: "{rounded.md}"
    padding: "11px 16px"
---

# Design System: Tuft the World Support

## Overview

**Creative North Star: "The Shop Counter"**

This is the store's own counter, not a SaaS dashboard. The helpdesk wears the Tuft the World shopfront: the deep teal of the store's top bar becomes a full-height rail, ochre is the colour of the one thing to do next, and everything else is white paper and warm stone hairlines. The work surface is a dense, quiet three-pane desk (queue, conversation, customer with orders) built for fast passes through a short queue, with the brand carried by colour, type and one material detail rather than by decoration.

The material detail is yarn. The rail carries a faint cut-pile texture, a 7px grid of dots like the back of a tufted rug, fading in from the top. The same material returns in the inbox-zero art, a round tufted rug seen from above in brand yarns. Mail is set in Roboto so customers' words read like a letter; the interface around them is set in Chivo; Abril Fatface appears only in the wordmark.

The system ships both schemes from one token set. Dark mode keeps the teal rail, warms the neutrals to a dark brown-grey paper, and lightens ochre and brick so they still read as text.

**Key Characteristics:**
- Teal rail, white work surface, warm-stone hairlines; a second neutral layer (panel) behind the list and customer columns.
- One ochre primary action per screen; everything else is outlined, dark teal, or ghost.
- Chivo for UI, Roboto for mail and descriptive copy, Abril Fatface for the wordmark only.
- Status is spoken in brand tones: teal open, ochre pending, mint good, brick bad, sunken closed.
- Flat surfaces with hairline borders; shadows are a whisper (shadow-sm) except for floating layers.
- Motion is short and decelerating (150–250ms on a single ease-out curve), and is removed under reduced motion.

## Colors

A brand-matched palette: one deep teal, one ochre, one brick, and warm stone neutrals on white, each with a soft tint for badges and states.

### Primary
- **Workshop Ochre** (ochre): the single primary action (Send & close, Get UPS rates, Buy label, Print label, a dirty Save), the active nav count, the unread dot, the caret, focus rings, selected rate, and the active underline tab. Its darker sibling **Ochre Ink** (ochre-text) is ochre dark enough to sit as text on white: links, pending badges, unread timestamps, note headers. **Ochre Wash** (ochre-soft) is the selection colour, the focus halo and the pending-badge ground.

### Secondary
- **Storefront Teal** (teal): the rail, the dark button (Ship, Add note, Sign in), toasts, the shipping success card, the customer avatar, checkbox accent and the open status text. **Teal 2** and **Teal 3** are its hover and active steps inside the rail; **Teal Ink** is the text colour on ochre. **Teal Wash** (teal-soft) is the open badge and open status select ground. **Rail Cream** (on-teal) and **Rail Sage** (on-teal-2) are primary and secondary text on teal.

### Tertiary
- **Brick** (brick): danger only. Ghost-danger buttons (Delete, Remove, Void, Disconnect), the bad badge, the error toast, error notices, link hover, attachment remove hover. **Brick Wash** (brick-soft) grounds it.
- **Mint Leaf** (mint-soft ground, mint-ink text): the good badge only (Paid, Fulfilled).

### Neutral
- **Paper** (bg / surface): the conversation pane, cards, messages, inputs.
- **Warm Panel** (panel): the second layer behind the ticket list, customer column and settings/shipping pages.
- **Sunken Stone** (sunken): closed badges, active composer tab, skeleton bars, placeholders, neutral notices.
- **Hover Linen** (hover): the hover ground for rows, menu items, default buttons.
- **Stone Hairline** (stone-2, as border) and **Warm Stone** (stone, as border-strong): all dividers are stone-2; control outlines and the composer frame are stone.
- **Charcoal** (text), **Umber** (text-2), **Taupe** (text-3): primary, secondary and meta text.
- **Sent Sage** (out / out-border): outgoing message bubbles.
- **Note Parchment** (note / note-border): internal notes and the composer in note mode.
- **Selected Cream** (select): the active order row in Shipping.

### Named Rules
**The One Ochre Rule.** Each screen has at most one filled ochre button. Save buttons render as outlined default buttons and only turn ochre when their own card or saved-reply row becomes dirty; they drop back after a successful save.

**The Brand Tone Rule.** Status is coloured only with brand tones: teal for open, ochre for pending or warning, mint for good, brick for bad, sunken stone for closed. No other hue is introduced for state.

**The Teal Is The Store Rule.** Teal is the structural brand surface (rail, toasts, dark buttons, success). It is never used as a large fill inside the work area other than the shipping success card.

## Typography

**Display Font:** Abril Fatface (with Georgia, serif), self-hosted, font-display block
**UI Font:** Chivo 400–800 (with a metric-adjusted Arial fallback), self-hosted
**Reading Font:** Roboto 400/500/400 italic, self-hosted

**Character:** Chivo is a sturdy grotesque that carries the store's headline voice into every control; Roboto softens the mail into something read rather than scanned. Abril Fatface is the logo face and nothing else.

### Hierarchy
- **Display** (Abril Fatface 400, 21px rail / 30px login, line-height 1, uppercase, 0.02em): the "Tuft the World" wordmark only. Below 1240px it collapses to its first letter at 26px as the rail monogram.
- **Headline** (Chivo 700, 24px, 1.2, -0.015em): page titles on Settings and Shipping.
- **Title** (Chivo 700, 18–19px, 1.2–1.3, -0.01em, balanced wrap): the ticket subject and the list pane title. 16.5px on phones.
- **Title small** (Chivo 700, 15.5–17px): card titles, customer name, empty-state headings.
- **Body** (Chivo 400, 14px/1.45, tabular numerals): all interface text. 15px on phones.
- **Reading body** (Roboto 400, 14.5px/1.6, max 72ch): message bodies, the composer textarea, notes, snippets (12.5px), page subtitles and card descriptions.
- **Label** (Chivo 600–700, 11.5–12px): field labels, badges, sub-labels, table headers, meta.
- **Rail label** (Chivo 600, 10.5px, 0.16em, uppercase, on-teal-2 at 80%): the Tickets and Store group headers inside the rail only.
- **Mono** (ui-monospace, 12.5px; 20px bold for a purchased tracking number): IDs and tracking numbers.

### Named Rules
**The Wordmark Only Rule.** Abril Fatface sets the brand wordmark and nothing else: never a heading, number, or empty-state title.

**The Letter And Desk Rule.** Words the customer wrote, or words that will be sent to them, are set in Roboto. Words the interface speaks are set in Chivo.

**The Tabular Rule.** Numerals are tabular everywhere so counts, times and prices align in lists.

## Layout

A full-height app grid: the rail (228px) plus a main area that holds the ticket list (344px, panel ground), the conversation (fluid, white), and the customer column (352px, panel ground). Panes are divided by stone hairlines, not gaps. Pane gutters are 22px; the thread caps at 760px wide, the composer at 900px; settings and shipping pages centre at 1200px max with 28px gutters (settings narrows to 880px).

Spacing is a tight 4px-based rhythm: 2–4px inside rows, 8px between controls, 12px within cards and between grid cells, 16px between cards, 22px pane gutters, 28px page gutters.

Responsive behaviour, as built:
- **≤1320px:** list 300px, customer 312px.
- **≤1240px:** the rail collapses to a 64px icon rail. Labels hide, the wordmark becomes its first letter, counts become small pills pinned to the icon corner. Three panes remain (list 280px, customer 296px), gutters drop to 16px.
- **≤1023px:** the customer column stacks under the conversation; shipping becomes one column.
- **≤760px:** one pane at a time. The rail moves to the bottom as a teal tab bar (Mine, Unassigned, Open, Pending, Settings with short labels and count pills; Closed and Shipping are hidden on the phone). Opening a ticket hides the list and shows a back link. The customer opens as a full-screen sheet from the underlined customer name in the crumbs. The composer is sticky at the bottom, its textarea grows from 52px to 140px on focus. Inputs go to 16px to stop zoom; safe-area insets are respected.

## Elevation & Depth

Mostly flat, layered by tone: white surfaces sit on the warm panel, separated by stone hairlines. Shadows are teal-tinted and small. Only things that float above the page (menus, toasts, the login card) get a real lift.

### Shadow Vocabulary
- **Hairline lift** (`box-shadow: 0 1px 2px rgba(33, 56, 56, .08)`): incoming messages, cards, the primary button, the active ticket row, an open order.
- **Float** (`box-shadow: 0 2px 4px rgba(33, 56, 56, .06), 0 12px 32px -8px rgba(33, 56, 56, .18)`): the saved-replies menu and toasts.
- **Focus halo** (`box-shadow: 0 0 0 3px var(--ochre-soft)`): focused inputs, the composer frame, a selected rate.

In dark mode both shadows switch to black at higher opacity.

### Named Rules
**The Whisper Rule.** Resting surfaces get at most the hairline lift. The float shadow is reserved for layers that overlap content.

**The Outgoing Is Flat Rule.** Outgoing messages drop their shadow and take the sage tint; incoming messages keep the hairline lift.

## Shapes

Gently rounded and consistent: 7px on controls (buttons, inputs, nav items, row hovers, notices), 10px on contained blocks (stats strip, order cards, rate options, toasts), 12px on conversation-scale containers (messages, notes, cards, composer, menus), 16px on the login card, full pills for badges, counts and the demo flag. Borders are 1px. The internal note is the one dashed border in the system, used to say "not sent".

The recurring motif is the dot: unread dots, badge leading dots, connection status dots, and the cut-pile dot grid on the rail and login screen.

## Components

### Buttons
Compact and solid, 36px tall (30px small, 44px on login), Chivo 600 13.5px, 7px corners, a 1px press-down on active.
- **Primary (ochre):** ochre fill, teal-ink text, hairline lift. One per screen.
- **Default (outline):** white with a warm-stone outline. The resting state of every Save and of secondary actions (Send, Add to reply, Add).
- **Dark (teal):** teal fill, rail-cream text, for a strong secondary that belongs to the store (Ship, Add note, Sign in with Google).
- **Ghost:** no border, umber text; ghost-danger turns the text brick with a brick-wash hover.
- **Keyboard hints:** a kbd chip can sit inside a button; it hides below 1500px in the composer bar.

### Badges
Pill, 21px tall, 11.5px Chivo 600, a 6px leading dot in currentColor. Tones follow the Brand Tone Rule. A plain variant drops the dot (customer tags, team role). The status select in the ticket header takes the same tone grounds.

### Cards / Containers
- **Corner Style:** 12px for cards and messages; 10px for order cards and rate options.
- **Background:** white on the warm panel.
- **Shadow Strategy:** hairline lift at rest (see Elevation).
- **Border:** 1px stone hairline.
- **Internal Padding:** 20px cards; 11–13px order cards; 18px customer sections.

### Inputs / Fields
- **Style:** white, 1px warm-stone outline, 7px corners, 36px min height. Selects use a drawn chevron. Textareas switch to Roboto at 14.5px.
- **Hover:** outline darkens to taupe.
- **Focus:** ochre border plus a 3px ochre-wash halo; the caret is ochre.
- **Labels:** 12px Chivo 600 in umber above the field.

### Navigation
- **Rail:** teal with the cut-pile texture, wordmark lockup at top, grouped items, the signed-in agent at the bottom.
- **Items:** 13.5px Chivo 500 in rail sage; hover goes to teal-2 and cream; active is teal-3, white text, ochre icon, and an ochre count pill (inactive counts are a faint white pill).
- **Underline tabs:** settings/shipping sub-navigation uses a 2px ochre underline for the active tab.
- **Composer tabs:** Reply / Internal note, 6px corners, sunken ground when active.

### Ticket Row
Grid row with a 22px left gutter for the 7px ochre unread dot. Unread rows set the name bold and the time in ochre ink; read rows step names to 500 and subjects to umber. Two-line Roboto snippet. Active row becomes a white card with hairline lift. On send-and-close, the row leaves by fading and sliding 12px left.

### Conversation
Incoming messages are white cards left-aligned; outgoing are sage, right-aligned, flat. Internal notes are parchment with a dashed border and an ochre-ink header. Events are centred taupe lines flanked by 36px hairlines. The composer is a 12px-cornered frame that takes the ochre focus halo and turns parchment and dashed in note mode.

### Customer Panel
Avatar and name, a three-cell stats strip, tags, then collapsible order cards with item thumbnails (42px, 7px corners), ship-to in Roboto, and order actions (Add to reply outline, Ship dark).

### Loading and Feedback
- **Skeleton:** 10px bars with a 1.2s sunken-to-hover shimmer, three bars per row at varied widths. Used for list, thread, customer, settings and rates. Spinners only inside busy buttons.
- **Toasts:** teal pills bottom-centre with an ochre icon; errors are brick with white text. They pop in over 250ms.
- **Empty inbox:** the rug art (120px), a round tufted rug in teal, ochre, stone and brick rings with a mint centre and a check, above a 17px title and a 34ch message.

## Do's and Don'ts

### Do:
- **Do** keep a single filled ochre action per screen; render every other action outlined, dark teal, or ghost, and let Save turn ochre only when its own form is dirty.
- **Do** colour status with the brand tones only: teal-soft/teal (open), ochre-soft/ochre-text (pending), mint-soft/mint-ink (good), brick-soft/brick (bad), sunken/text-3 (closed).
- **Do** set customer and outgoing mail in Roboto 14.5px/1.6 and interface text in Chivo 14px/1.45 with tabular numerals.
- **Do** separate panes and rows with 1px stone hairlines and the white-on-panel tonal step before reaching for shadow.
- **Do** animate with the one ease-out curve, cubic-bezier(.16, 1, .3, 1), at 150ms for state changes and 180–250ms for entrances (menus, toasts, sheet), and honour reduced motion.
- **Do** show loading as skeleton rows shaped like the content they replace.
- **Do** use the dot grid (radial dots on a 7–9px pitch, 7–8% opacity) only on teal brand surfaces: the rail and the login ground.

### Don't:
- **Don't** set anything but the wordmark in Abril Fatface.
- **Don't** introduce a second accent hue or a generic success green; good is mint, danger is brick.
- **Don't** use brick for anything but destructive actions, errors and link hover.
- **Don't** put uppercase letter-spaced labels above content headings; tracked uppercase lives only in the wordmark lockup and the rail group headers.
- **Don't** give resting cards anything heavier than the hairline lift, or use offset hard shadows.
- **Don't** fill large areas of the work surface with teal; the rail, toasts, dark buttons and the shipping success card are its places.
