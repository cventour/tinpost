---
name: Tinpost
description: A quiet, native-feeling lab mail client that gets out of the way of the mail.
colors:
  bg: "#f6f7f9"
  panel: "#ffffff"
  sunk: "#f0f2f5"
  ink: "#1b1f24"
  ink-dim: "#5b6572"
  line: "#dfe3e8"
  accent: "#2b5fd9"
  accent-ink: "#ffffff"
  warn-bg: "#fff6e5"
  warn-line: "#e0b050"
  err-bg: "#fdecec"
  err-line: "#d05050"
  ok-bg: "#e9f5ec"
  ok-line: "#4d9f66"
typography:
  wordmark:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "19.5px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.4px"
  display:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: "-0.3px"
  headline:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "21px"
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: "normal"
  title:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: "normal"
  body:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  section-label:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0.6px"
  micro-label:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0.7px"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
rounded:
  code: "4px"
  tip: "5px"
  control: "6px"
  nav-item: "7px"
  panel: "8px"
  shell: "12px"
  pill: "999px"
spacing:
  hair: "6px"
  xs: "8px"
  sm: "10px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  section: "26px 30px 30px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.control}"
    padding: "9px 16px"
    typography: "{typography.body}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "9px 16px"
  button-danger:
    backgroundColor: "{colors.err-line}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    padding: "9px 16px"
  button-small:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.control}"
    padding: "5px 11px"
    typography: "{typography.label}"
  button-tiny:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.control}"
    padding: "3px 8px"
  input-text:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "9px 11px"
    width: "100%"
  panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "{spacing.xl}"
  tab:
    backgroundColor: "transparent"
    textColor: "{colors.ink-dim}"
    rounded: "{rounded.pill}"
    padding: "6px 12px"
  tab-on:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "6px 12px"
  chip:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "3px 6px 3px 10px"
  tag:
    backgroundColor: "transparent"
    textColor: "{colors.ink-dim}"
    rounded: "{rounded.pill}"
    padding: "1px 7px"
    typography: "{typography.micro-label}"
  ribbon-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink-dim}"
    rounded: "{rounded.nav-item}"
    padding: "8px 9px"
  ribbon-item-on:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.nav-item}"
    padding: "8px 9px"
  theme-btn:
    backgroundColor: "transparent"
    textColor: "{colors.ink-dim}"
    rounded: "{rounded.panel}"
    height: "30px"
    width: "30px"
    padding: "0"
---

# Design System: Tinpost

## Overview

**Creative North Star: "The House Utility"**

Tinpost looks like something that came with the operating system. It is a lab
instrument — a mail server you point a phishing simulation or an app's signup flow
at, and a webmail UI where you type any address and read that mailbox. Nothing it
shows is precious; everything it shows is evidence. So the interface spends no
attention on itself: one system font stack, one accent, flat panels on a faintly
tinted field, and enough border to tell surfaces apart without drawing them.

Both surfaces are task surfaces. Reading mail wants scanning speed and native
expectations (rows, folders, an unread weight). Configuring an instance is done
rarely, so every control carries a written label and a hint sentence rather than
relying on remembered icon positions. The density is moderate: rows at 11px
vertical padding, panels at 24px, settings sections at 26/30/30 — tight enough
to see a screenful, loose enough not to misclick.

The colour work is entirely tonal. A light theme and a dark theme are declared
from the same token block and the whole interface — including the browser's own
selection, placeholder, focus ring and scrollbar surfaces — is repainted from
those tokens, so nothing inherits a stray default and gives away that this is a
web page rather than a client.

**Key Characteristics:**
- System UI font everywhere; monospace reserved for machine text (addresses, MIME types, source, composed bodies).
- One accent (`--accent`) for links, focus, primary action and counts; everything else is ink, dim ink and line.
- Flat by default: 1px `--line` borders do the separating; the single `--shadow` appears once, on the active ribbon item.
- Light/dark is a three-state choice (follow system, explicit light, explicit dark), applied before first paint.
- Labels over icon memory; icons are always paired with text, or with a tooltip when the ribbon is collapsed.

## Colors

A near-neutral cool grey field with a single confident blue, tuned so the dark
theme is a re-declaration of the same token names rather than a different palette.

### Primary
- **Signal Blue** (`--accent`): Links, the wordmark's "post" half, the unread count, every focus ring, primary buttons, the active ribbon item's icon, and the 5% unread row wash / 22–26% selection and arrival tints via `color-mix`. In dark it lightens to a softer periwinkle so it stays readable on `--panel` without glowing.
- **Accent Ink** (`--accent-ink`): Text on a filled accent surface. Pure white in light, near-black in dark — the pairing flips, the token name does not.

### Neutral
- **Field** (`--bg`): The page behind everything, and the recessed fill of inputs, code spans, `.stat` tiles and hovered rows. Panels sit on it; controls sink into it.
- **Panel** (`--panel`): Every card, the top bar, the admin shell, and the active ribbon item. The one surface that reads as "in front".
- **Sunk** (`--sunk`): Only the settings ribbon column — a third tone that puts the navigation behind the section content without a shadow.
- **Ink** (`--ink`): Body text, subjects, unread rows, active tabs, and the tooltip background (inverted against `--panel` text).
- **Dim Ink** (`--ink-dim`): Secondary everything — senders, snippets, metadata, hints, section headings, placeholders, inactive tabs and ribbon items, the footer.
- **Line** (`--line`): All 1px borders, table rules, row dividers, and the scrollbar thumb at rest.

### Status
- **Warn** (`--warn-bg` / `--warn-line`): The exposed-binding banner and the "port saved but not running" notice; also the amber live-dot when the event stream has fallen back to polling.
- **Error** (`--err-bg` / `--err-line`): Form errors, destructive-action forms, and the danger button fill.
- **OK** (`--ok-bg` / `--ok-line`): Save notices, and the green live-dot when the stream is connected.

### Named Rules
**The One Accent Rule.** There is exactly one accent. Anything that needs to stand out and is not a status uses `--accent` or a `color-mix` of it; never introduce a second hue for emphasis.

**The Mirrored Token Rule.** Dark is not a separate palette — it is the same fourteen token names re-declared. It is declared twice on purpose: under `@media (prefers-color-scheme: dark)` scoped to `:root:not([data-theme="light"])` so an explicit light choice beats the system, and again under `:root[data-theme="dark"]` for an explicit dark choice. Add a colour token and you add it in all three blocks or it is broken in one of the three states.

**The Painted Chrome Rule.** The browser's own surfaces are part of the palette. `::selection`, `::placeholder`, `:focus-visible`, `scrollbar-color` and the `::-webkit-scrollbar` family are all themed from tokens, and `color-scheme` is set alongside them so native form controls follow. A new surface that leaves one of these at the default has a visible seam.

**The Foreign Content Rule.** The rendered HTML body is the one region the palette does not own. `.html-body` is pinned to `background: #fff; color-scheme: light` because the sender's mail was authored against white — do not theme it.

## Typography

**UI Font:** system-ui (with -apple-system, "Segoe UI", Roboto, sans-serif)
**Mono Font:** ui-monospace (with SFMono-Regular, Menlo, Consolas, monospace)

**Character:** Deliberately faceless. The interface borrows the host OS's voice so
it reads as a tool rather than a product, and the only typographic expression is
weight and case. Base is 15px/1.5 with antialiasing on.

### Hierarchy
- **Wordmark** (700, 19.5px, -0.4px tracking): `.brand` in the top bar, and only there. Set in three tones — "Tin" in `--ink`, a `·` separator in `--ink-dim`, "post" in `--accent` — so the mark carries the palette without needing a logo. The dot is decoration and is `aria-hidden`: the product reads and copies as "Tinpost".
- **Display** (700, 22px, -0.3px tracking): `h1` on webmail panels and login — the page's one title.
- **Headline** (700, 21px): The message subject in the message view (`.message .subject`).
- **Title** (700, 18px): `h1` inside an admin section, where the ribbon already says where you are.
- **Section label** (400, 15px, 0.6px tracking, uppercase, dim): `h2`. The only uppercase at body size; it divides a form or panel without weight.
- **Body** (400, 15px/1.5): Default. Long prose is capped — `.setting-hint` at 62ch, `.policy-form label` at 72ch.
- **Label** (400, 13px, dim): Field captions, hints, metadata, save notes, the `.who` pill, small buttons.
- **Micro label** (400, 11px, 0.5–0.7px tracking, uppercase, dim): `.tag`, `.live-dot`, `.ribbon-group`, `.mailboxes thead th`. Tracking is what makes 11px uppercase legible; do not drop it.
- **Mono** (13–13.5px): Machine text only — addresses in the top-bar `.who`, `code` spans, attachment content types, plain-text and source bodies, and the compose textarea.

### Named Rules
**The Machine Text Rule.** Monospace marks text the machine produced or must be copied verbatim: addresses, MIME types, ports, hosts, raw source, and the body being composed. Never use it for prose, and never use the UI font for a raw header dump.

**The Weight-Not-Colour Rule.** Unread rows are signalled by weight (700) plus a 5% accent wash, and read rows by `--ink-dim` sender text. Row state is never signalled by a coloured dot or a hue change to the subject.

**The Tabular Numbers Rule.** Numbers that sit in a column or update in place carry `font-variant-numeric: tabular-nums` — the ribbon footer's message/disk counts and every right-aligned `.setting-control input`.

## Layout

Two shells, one rhythm.

**Webmail** is a centred single column: `main` at `max-width: 900px`, `padding: 24px 16px 48px`, with a fixed `.topbar` strip above (`10px 16px`, bottom-hairline) and a small dim `.foot` below. Admin pages pass `wide`, which lifts the cap to 1040px.

**Admin** is `.admin-shell` — a flex row inside a 12px-radius, overflow-hidden, `--line`-bordered panel with `min-height: 520px`. The left column is `.ribbon` at `var(--ribbon-w)` (190px), on `--sunk`, with its own right hairline; the right column is `.section` (`flex: 1; min-width: 0`) padded `26px 30px 30px`.

**Spacing rhythm** runs in even steps: 6 / 8 / 10 / 12 / 16 / 24. Row padding is `11px 6px`; panel padding 24px; a `.setting` row is `15px 0` between hairlines; `.actions` groups sit 18–22px below with a top rule.

**The message list** is a CSS grid, not a table: `180px minmax(0,1fr) auto` (sender / subject / meta), baseline-aligned. The `.headers` block under a subject is a `70px minmax(0,1fr)` definition grid, and a settings row is `minmax(0,1fr) 150px` with the control right-aligned.

**Breakpoints** — there are exactly two, and they are content-driven:
- **`min-width: 760px`** — the message row gains a fourth column (`180px minmax(0,22ch) minmax(0,1fr) auto`) and the snippet, hidden below this width, appears. Snippets are an enhancement, never the only carrier of meaning.
- **`max-width: 680px`** — `.admin-shell` becomes a column; the ribbon loses its fixed width, its right border becomes a bottom border, and `.ribbon-sections` turns into a wrapping horizontal row of labelled items. The group headings, the collapse toggle and the ribbon footer are hidden outright, and a collapsed ribbon shows its labels again — at phone width there is no collapsed mode. `.setting` drops to one column and number inputs shrink to `8em`, left-aligned, so a value stays next to its label.

### Named Rules
**The Two-Breakpoint Rule.** 760px and 680px are the whole responsive vocabulary, and each exists because a specific element stopped fitting. Add a breakpoint only when you can name the element that broke.

**The Reflow-Instantly Rule.** The ribbon collapse (190px → 62px) is a mode switch, not a transition. Width is not animated: animating a layout property janks the entire column as its content reflows. Colour and opacity may transition (.14–.16s ease); geometry may not.

## Elevation & Depth

This system is flat and tonal. Depth comes from three background tones — `--sunk` behind, `--bg` as the field, `--panel` in front — separated by 1px `--line` hairlines. There is exactly one shadow token and it is used once.

### Shadow Vocabulary
- **`--shadow`** (`0 1px 2px rgba(16,20,28,.08), 0 1px 3px rgba(16,20,28,.06)`; in dark, `rgba(0,0,0,.4)` / `rgba(0,0,0,.3)`): The active settings-ribbon item only. It lifts the current section out of the sunk column onto the same plane as the content beside it.

### Named Rules
**The Hairline-First Rule.** Separation is a 1px `--line` border. Reach for a shadow only when an element must read as being on a different plane than the surface it sits on — in the shipped build that is one element.

**The Sunk-Panel Pair Rule.** Navigation chrome sits on `--sunk`, content sits on `--panel`, inputs and hovered rows sink to `--bg`. Recession is tone, never an inset shadow.

## Shapes

Softly rounded rectangles, sized by what the thing is. Controls take 6px (`--radius` derivatives: inputs, buttons, banners, fieldsets, attachment and body panes), navigation items 7px, panels and the theme button 8px (`--radius`), the admin shell 12px, tooltips 5px, inline `code` 4px. Anything that reads as a token or a state — folder and view tabs, `.tag`, `.chips li`, the top-bar address pill, the scrollbar thumb — is fully rounded (999px).

Borders are always exactly 1px and always `--line`, except where a status owns the element (`--err-line` on `.danger-form`, `--warn-line`/`--ok-line` on banners) or where an accent is the fill. Transparent borders are used as placeholders so inactive tabs and the theme button do not shift by a pixel when they become active.

Icons are a single inline SVG sprite on a 24px grid with a 1.6 stroke, rendered at 20px via `<use>`.

### Named Rules
**The Radius-By-Role Rule.** 6px = control, 7px = nav item, 8px = panel, 12px = shell, 999px = state token. Pick by what the element is, not by how large it is.

**The Icon Inheritance Rule.** `fill: none; stroke: currentColor; stroke-width: 1.6` must be set on the `.ico` `<svg>` element itself, never on a descendant selector. `fill` and `stroke` are inherited properties, and a descendant rule cannot reach into the shadow tree a `<use>` creates — a rule written as `.ico use { ... }` renders nothing. This was a live bug; it is now a rule.

**The One Sprite Rule.** Every icon is authored in `partials/icons.ejs` on the same 24px grid at the same 1.6 stroke and referenced by id. Icons are never inline one-offs and never a font.

## Components

### Buttons
- **Shape:** Gently rounded (6px), 1px bordered, never wrapping (`white-space: nowrap`).
- **Primary:** Accent fill with accent-ink text and a matching accent border, `9px 16px`.
- **Ghost:** Transparent fill, `--ink` text, `--line` border. The secondary of record; used for "Download .eml" and non-committal actions.
- **Danger:** `--err-line` fill and border with white text, for destructive admin forms only.
- **Sizes:** `.small` (`5px 11px`, 13px) for in-row actions; `.tiny` (`3px 8px`, 12px) for table row actions.
- **Focus:** A 2px `--accent` outline at 1px offset. There is no hover fill change on buttons — the cursor and the focus ring carry state.
- **Link-as-button:** `.btn` on an `<a>` is identical to `<button>`; and `.linkish` reverses it, rendering a real `<button>` (sign out, chip removal) as dim underlined text so a POST can look like a link without being one.

### Inputs / Fields
- **Style:** Recessed — `--bg` fill inside a 1px `--line` border at 6px radius, `9px 11px`, full width, inheriting the body font.
- **Focus:** 2px `--accent` outline, 1px offset. No border-colour swap, no glow.
- **Caption:** `.field > span` — 13px dim, 4px above the control. In admin, `.setting-label` (500 weight) plus a `.setting-hint` paragraph capped at 62ch.
- **Textarea:** Monospace 13.5px, vertical resize only — it holds a message body, so it is machine text and the reader may grow it.
- **Numeric settings:** Right-aligned with tabular numerals in a 150px column, with an optional dim `.unit` beside them; left-aligned and 8em wide below 680px.

### Cards / Containers
- **`.panel` / `.hero` / `.mailbox`:** `--panel` fill, 1px `--line`, 8px radius, 24px padding. `.narrow` centres one at 480px with 40px of air.
- **`.stat`:** A flexible tile (`flex: 1 1 130px`) on `--bg` at 6px, 20px bold value over a 12px dim caption.
- **Banners:** `.error` / `.notice` / `.warn` — status-tinted background with its matching 1px line, 6px radius, `10px 14px`, 14px text. Always a full-width block above the content it concerns.

### Navigation
- **Top bar:** Panel-coloured strip with a bottom hairline. The brand is 700 with its second half in accent; the nav is pushed right with `margin-left: auto`; links are accent, with `.subtle` variants in dim ink for secondary destinations. The current mailbox sits in a monospace pill (`.who`).
- **Folder / view tabs:** Pill-shaped text links, dim by default with a transparent border. Active (`.on`) gains `--line` border, `--bg` fill, `--ink` and 600 weight. View tabs additionally sit on a bottom hairline.
- **Theme toggle:** A 30px square icon button showing the theme you would switch *to* — moon in light, sun in dark. Visibility is driven by the same three-state CSS as the palette, so the glyph is correct before any JS runs. Hovering gives it an `--line` border and `--bg` fill.

### Settings Ribbon (signature component)
The one component that is more than the sum of its tokens.

- **Expanded (default, 190px):** A `--sunk` column of 20px icon + label rows at 7px radius, grouped under uppercase 11px headings "Mail" (SMTP, Domains, Mailboxes) and "Instance" (Storage). A collapse toggle sits on top; a hairline-topped footer at the bottom carries the message count and disk usage in tabular numerals.
- **Active item:** `--panel` fill plus `--shadow`, `--ink` text at 600, and the icon alone in `--accent`.
- **Hover:** `color-mix(in srgb, var(--ink) 6%, transparent)` — a tint of the text colour, so it works identically in both themes.
- **Collapsed (62px):** Group headings, labels and toggle text are hidden; items centre their icons. Each item's label is duplicated as a `.ribbon-tip` that flies out on hover *and* on `:focus-visible` — an inverted `--ink`/`--panel` chip 10px to the right, 5px radius, fading opacity and 4px of travel over .14s. Tooltips exist only in the collapsed state (`.ribbon:not(.collapsed) .ribbon-tip { display: none }`).
- **Persistence:** The collapsed choice is stored in `localStorage` under `mb.ribbon` and applied on `DOMContentLoaded`; the page must render correctly when that read throws.
- **Below 680px:** The whole mechanism is replaced by a labelled wrapping row — no collapse, no tooltips.

### Message View
- **Header block:** Back link, subject headline, then a `70px` definition grid of From / To / Cc / Bcc / Date / Size. Provenance is stated inline as a `.tag` pill ("sent from webmail", "received over SMTP", "envelope only").
- **Attachments:** A bordered 6px box listing filename (500 weight), monospace content type, and a right-aligned size. Every attachment is a download; the panel says so in a `.hint`.
- **HTML body:** A fully sandboxed `<iframe>` with `sandbox` (no scripts, no same-origin) and `referrerpolicy="no-referrer"`, served under a CSP that denies all network sources with inline images inlined as `data:` URIs. Because the frame cannot measure itself, it is given a fixed viewport (`60vh`, `min-height: 300px`) and scrolls internally, with `resize: vertical` so the reader can grow it. Its `src` is assigned from JS, not markup.
- **Text / source:** Monospace 13px panes on `--bg`, `white-space: pre-wrap`, source capped at `70vh` with internal scroll.

### Live Inbox
- **`.live-dot`:** An 11px uppercase label with a 7px dot before it, driven by `data-live-state`: dim = connecting, `--ok-line` = live, `--warn-line` = polling. It reports transport health honestly rather than hiding a fallback.
- **Arrival:** A newly inserted row plays `flash` — a 1.4s ease-out fade from a 22% accent wash to transparent — and is suppressed entirely under `prefers-reduced-motion`.
- **Unread:** 700 weight on sender and subject, `--ink` instead of dim, plus a 5% accent row wash; the count renders in accent 700 at 13px and is mirrored into the document title.

### Log Viewer
- **Console pane:** A `58vh` scrolling field on `--sunk` inside a 6px border, padded vertically only so rows rule edge to edge. Newest is at the bottom and the pane opens scrolled there.
- **Row:** A `7ch / 5.5ch / 1fr` monospace grid at 12.5px &mdash; time (dim, tabular), level (10.5px uppercase, 0.4px tracking), text. The text cell is `pre-wrap` so a stack trace or a multi-line SMTP reply keeps its shape. Below `680px` the level column is dropped rather than squeezed.
- **Level colour:** Errors take `--err-line`, warnings `--warn-line`, and protocol detail sits at `--ink-dim` for the whole row &mdash; severity is carried by colour, never by weight, so the monospace rhythm holds.
- **Highlighting:** Matches are wrapped in `<mark>` at a 34% accent wash, rebuilt from the row's `data-text` on every keystroke so highlights never nest. Non-matching rows are hidden, or dropped to `0.45` opacity when "matching lines only" is off.
- **Arrival:** A tailed row plays `log-flash`, a 1.2s ease-out from a 20% accent wash, suppressed under `prefers-reduced-motion` &mdash; the same grammar as an arriving inbox row, one step quieter.
- **Control rows:** Filters wrap with the find box on a row of its own; the action bar below sits under a `--line` rule, with the transcript switch and the destructive control held together at the far end by `margin-left: auto` on the first of them.
- **Pill switch (`.pill`):** A 32x18 track on `--line` with a 14px knob, filling to `--accent` and sliding the knob 14px when on, both over .18s. It is a `<button type="submit">` carrying `role="switch"` and `aria-checked`, inside a form whose hidden field holds the *opposite* value — so one press flips it, the state shown is always the state the server holds, and it needs no JavaScript. Use it for a setting that is genuinely binary and applies at once; a setting that needs saving alongside others stays an On/Off `<select>` in a `.setting` row.

## Do's and Don'ts

### Do:
- **Do** add every new colour to all three theme blocks (`:root`, the `prefers-color-scheme: dark` block scoped to `:root:not([data-theme="light"])`, and `:root[data-theme="dark"]`).
- **Do** set `fill` and `stroke` on the `.ico` `<svg>` itself and add new icons to the single 24px/1.6-stroke sprite in `partials/icons.ejs`.
- **Do** pair every icon with a visible label, or with a `.ribbon-tip` when the label is hidden by the collapsed state.
- **Do** use monospace for machine text — addresses, ports, MIME types, raw source, composed bodies — and the UI font for everything a person wrote.
- **Do** cap explanatory prose (62ch for setting hints, 72ch for policy labels) and mark long unbroken strings with `overflow-wrap: anywhere`.
- **Do** guard every `localStorage` read and write in a `try`/`catch`; the page must render correctly when storage is unavailable.
- **Do** use `color-mix(in srgb, var(--token) N%, transparent)` for washes and hover tints so they resolve correctly in both themes.
- **Do** theme the browser's own surfaces (`::selection`, `::placeholder`, `:focus-visible`, scrollbars) on any new root-level surface.
- **Do** give any new animation a `@media (prefers-reduced-motion: reduce)` opt-out, as `.msg.arrived` and the ribbon transitions have.

### Don't:
- **Don't** animate a layout property. The ribbon's 190px → 62px change is instant on purpose; transition colour and opacity only.
- **Don't** introduce a second accent hue. Emphasis is `--accent` or a mix of it; the status trio is for status only.
- **Don't** theme the rendered HTML mail body — `.html-body` stays `#fff` with `color-scheme: light`, and the sandboxed frame must keep `sandbox` and its no-network CSP. It cannot be given scripts, same-origin access, or self-sizing.
- **Don't** render or preview an attachment inline; attachments always download under a neutral content type.
- **Don't** let a snippet, a tooltip, or anything else revealed above 760px carry information that isn't available below it.
- **Don't** replace the system font stack with a webfont; the native voice is the point, and there is no build step to ship one through.
- **Don't** signal message state with colour alone — unread is weight plus a wash.
- **Don't** add a breakpoint you cannot justify by naming the element that stopped fitting.
</content>
