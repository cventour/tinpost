# What's new

Every release, in plain language. Newest first.

---

## v0.7.5 — 24 September 2026

- New: **`SECURITY.md` — security and intended use.** The MIT licence grants permission
  but says nothing about what Tinpost is for, so this does: authorised testing in
  environments you control, and plainly not deception of people who have not consented
  to a test. It also collects what Tinpost deliberately does not protect — no passwords
  anywhere, `AUTH` that proves nothing, an unencrypted relay — and sets out what is in
  and out of scope for a vulnerability report, with a private channel for sending one.
  The licence itself is untouched.

- Removed: **the design skill's JSON sidecar is no longer tracked.** Nothing read
  `.impeccable/design.json`, and it described the UI as it stood at v0.2.0 — before the
  logs page, the timeline, the relay and the pill switch. `DESIGN.md` is the current
  account.

## v0.7.4 — 24 September 2026

- New: **Tinpost has a logo.** An open tin with a letter in it — the name, drawn. It
  sits to the left of the wordmark in the top bar and is now the favicon and the
  Apple touch icon, replacing the drawn envelope that stood in for it. The mark
  follows the theme: it carries the light accent on a light page and the lighter dark
  accent on a dark one, so it never sits a shade off from the "post" beside it.

- New: **the README opens with the horizontal lockup**, with a dark-mode variant so
  the near-black "Tin" does not disappear against GitHub's dark theme. The brand
  files live in `docs/brand/`, background removed, as transparent PNGs.

## v0.7.3 — 24 September 2026

- Changed: **the README is written for someone meeting Tinpost for the first time.**
  It opens with what the project is and why it exists, then what it is for, what it is
  **not** for, and a one-line summary of each feature — before any command appears.

- New: **"What it is not for".** Tinpost is a sink and must not be used as a production
  mail server: no MX lookup, no queue, no retry, and a message addressed to a real
  person goes nowhere. It is not a security boundary either — there are no passwords
  anywhere — and it should not be put on a network you do not control. The section says
  so plainly and names what to use instead.

- New: **screenshots.** The inbox, the timeline, the upstream relay, attachment
  scanning and the logs, in light theme, under *How it looks*.

- Changed: **install instructions are split by platform**, macOS and Windows each with
  a copy-paste block from installing Node through to a first test message, and the
  command-line options are now a table with one short sentence each.

## v0.7.2 — 23 September 2026

- Removed: **the duplicate Compose link in the top bar.** The inbox already carries a
  Compose button beside the list it acts on, so the same action appeared twice on the
  same screen. The button stays; the top bar drops back to the mailbox you are reading
  and the controls that switch or leave it.

## v0.7.1 — 23 September 2026

- Changed: **the Timeline's filter pills are on/off switches.** Each category —
  Delivered locally, Relayed to gateway, Returned by gateway, Relay failed, Refused,
  Connections — can be shown or hidden on its own, and the chart follows, so hiding
  Connections removes both their rows and their grey bars. **All** turns every one
  back on. The categories no longer overlap: "Relay involved", which included
  failures and returns, is replaced by "Relayed to gateway". Each pill carries its
  colour from the chart.

- Changed: **a relay failure and a refusal are told apart.** "Failed" used to hold
  both the gateway saying no and Tinpost itself saying no. They are now two switches
  and two colours, Relay failed (red) and Refused (amber), so everything that touched
  the gateway is exactly Relayed + Returned + Relay failed.

- Fixed: **the live "new events" count respects the switches and the search.** With
  Connections hidden, the gateway's health checks no longer announce new events that
  the view would not show.

## v0.7.0 — 23 September 2026

- New: **a Timeline page.** Beside Admin in the top bar: every message and
  connection the instance has seen, across all mailboxes, in one table, newest
  first, under a small activity chart that collapses to a single line. Each row
  gives the time to the millisecond, the source IP and whether it came in over SMTP,
  from the webmail or from the gateway, sender and recipients, the result, whether
  the upstream relay was involved and in which direction, and the relay's exact
  reply. Windows of 15 minutes, 1 hour, 24 hours, 7 days or a custom start and end;
  filters for relay traffic, failures, local deliveries, gateway returns and bare
  connections; search across addresses, IPs, subjects and responses.

- New: **open a message straight from the timeline.** Clicking a row switches to a
  mailbox that holds the message and shows it in the ordinary message view, with a
  banner saying which mailbox you are now reading and a way back.

- New: **refusals and empty connections are recorded.** A message refused at the
  SMTP layer, or a client that connected and left without sending, now has a row of
  its own, so the timeline shows what never became a message too. Stored in the
  database, so it survives a restart; mail from earlier versions is added once on
  first start. Purging the lab clears it.

## v0.6.1 — 23 September 2026

- Fixed: **mail between two local domains is internal.** With more than one local
  domain listed, mail from one to another was sent through the gateway, because only
  "the same domain" was exempt. The rule is now whether exactly one side is local:
  local to local is delivered directly, whichever local domains are involved. A
  product sending notifications from a local address to local recipients — MetaDefender
  Core writing from `mdcore@ops.lab` — is delivered directly, as it was.

## v0.6.0 — 23 September 2026

- **Changes behaviour when the relay is on:** mail from any other domain *to* a local
  domain now goes through the upstream gateway too, whether it is written in the
  webmail or arrives over SMTP. Before, it was delivered directly. A script or a
  product that sends straight to Tinpost's SMTP port into a local domain will now
  have its mail scanned by the gateway first; to let a sender bypass the gateway,
  list its address under gateway return addresses. With the relay off, nothing
  changes.

- New: **the relay routes by whether mail crosses a local domain's boundary.** Out of
  a local domain to any other: through the gateway. Into a local domain from any
  other: through the gateway, and back into the local mailbox once scanned. Within
  one domain, or between two domains neither of which is local: delivered directly,
  with ICAP scanning as set. The routing table on the relay page and in the README
  now lists all four cases.

## v0.5.2 — 23 September 2026

- Changed: **"Test connection" sits on the same line as the upstream server
  address.** v0.5.1 put the test on a row of its own under the port, labelled "Save
  and test the connection", where it was easy to miss. It is now a plain "Test
  connection" button beside the address field. It still saves every setting on the
  page before testing, and Save settings at the foot of the page is unchanged.

## v0.5.1 — 23 September 2026

- Changed: **testing the relay connection saves first, and sits beside the address.**
  The button is now "Save and test the connection", directly under the upstream
  server's address and port, so it always tests what you just typed rather than what
  was last saved. A failed test says the settings were saved and gives the error; a
  setting that does not validate is neither saved nor tested. Pressing Enter in a
  field still saves without testing.

## v0.5.0 — 23 September 2026

- New: **an upstream relay for outbound mail.** Admin ▸ Upstream relay hands mail
  from your local domains to an SMTP server of your choosing — built for an email
  security gateway such as OPSWAT MetaDefender Email Security — and delivers it once
  the gateway sends it back. Host, port and optional login; plain SMTP, no TLS.
  Mail between two addresses in the same domain never leaves and is still scanned by
  ICAP if that is on; relayed mail skips the ICAP scan, since the gateway does it.
  The sender's copy is marked *relayed, awaiting scan*, and the recipients see
  nothing until the scanned copy comes back, so a message the gateway blocks never
  reaches them. The returned copy is recognised by the IP address or host name it
  comes from, and is never relayed twice. A message stamped as relayed that comes
  back from anywhere else is refused as a loop.

- New: **a relay failure is written into the message.** There is no queue: when the
  gateway is unreachable or refuses a message, it is delivered locally without
  scanning, with a footnote in the body naming the gateway, the affected recipients
  and the exact error, including the gateway's SMTP reply. A "Test the connection"
  button checks the gateway and the login without sending anything.

- Changed: **"nothing ever leaves the machine" now has one opt-in exception.** With
  the relay off, which is the default, nothing changes.

## v0.4.3 — 23 September 2026

- New: **copy-paste run examples for macOS, Linux and Windows.** A "Running it"
  section with the command lines you actually type — defaults, choosing ports, binding
  `0.0.0.0`, naming a data directory — given twice, once for a Unix shell and once for
  PowerShell, so neither platform has to translate the other's.

- New: **which platforms need elevation for port 25, in a table.** Ports below 1024 are
  reserved for root on macOS and Linux, so port 25 needs `sudo` there; **Windows does
  not reserve low ports**, so an ordinary account binds 25 with no elevation at all.
  The section also names the trap that follows `sudo`: the default data directory then
  resolves against root's environment, so a `sudo` run and an ordinary run keep two
  separate mail stores, each looking empty to the other — pass `--data-dir` and the
  problem disappears. Port 25 was previously explained in a single paragraph under
  Options; that now points at the fuller section rather than repeating it.

## v0.4.2 — 23 September 2026

- Fixed: **the quick start told you to run a command that does not exist.** `npx
  tinpost serve` cannot work — Tinpost is not published to the npm registry. The
  README now gives the install that does work, `git clone` then `npm ci`, in the same
  three commands on all three platforms.

- New: **install and run instructions for macOS, Windows and Linux.** How to get Node
  on each, and how to keep Tinpost running after a reboot using only what the platform
  already ships: a launchd agent on macOS, a scheduled task on Windows (with the
  firewall rules you will need), and a systemd unit on Linux. None of it is required —
  `npm start` in a terminal is still a perfectly good way to run a lab — and none of it
  needs extra software. Sending examples now include PowerShell, which works on all
  three, rather than only `swaks`.

## v0.4.1 — 23 September 2026

- Changed: **the two sides of an SMTP conversation are told apart by tone.** What the
  sender said is at full strength; what Tinpost answered sits one step back. A
  transcript is read by hunting for the turn where the two sides stopped agreeing, and
  that is much quicker to find when they do not share a colour. Both tones clear WCAG
  AA against the log's own background in light and dark, and both are more readable
  than the hint-text grey the transcript used before — the reply is the half that
  carries the refusal you are usually looking for, so it is not dimmed into a whisper.
  Lines with no direction, such as a delivery summary, are left alone, and an error or
  a warning keeps its own colour: a `550` is a refusal first and an outbound line
  second.

## v0.4.0 — 23 September 2026

- New: **Tinpost offers `AUTH`, and accepts anything.** Some senders refuse to talk to
  a server that advertises no way to authenticate — they close the connection rather
  than deliver, and the lab never sees the mail. Tinpost now advertises `AUTH` with
  `PLAIN`, `LOGIN`, `CRAM-MD5` and `XOAUTH2`, and accepts any username, any password
  and any token. It proves nothing and is not meant to: it exists so a client that
  insists on the ritual can complete it. Authentication is never required, so a sender
  that skips it is accepted exactly as before and nothing that worked yesterday stops
  working. The username offered is written to the log, which is the quickest way to
  catch a client that authenticates as one identity and then puts another in
  `MAIL FROM`. Turn the offer off under **SMTP ▸ Authentication** to test a client
  against a server that refuses it. `STARTTLS` is still not offered.

## v0.3.0 — 23 September 2026

- New: **the version is shown beside the wordmark**, on every page, so it is obvious
  at a glance which build a lab is running without opening a terminal. It comes from
  `package.json`, which stays the one place a version is declared.

- Changed: **the SMTP conversation switch is now a pill in the action bar**, beside
  Clear log, rather than a section with its own Save button at the foot of the page.
  It is the control you reach for while reading the log, so it belongs with the others
  — one press flips it, with no banner afterwards saying what the switch already shows.
  It is still a plain form post, so it works with JavaScript off.

- Fixed: **a connection that sent nothing left no trace.** Only a delivered or refused
  message was logged, so a sender that connected and then failed to get any further —
  the exact thing you look at a log to diagnose — was invisible unless the full SMTP
  transcript happened to be switched on. Every connection now logs a line of its own,
  and a session that closes without sending anything says so. "Did it even reach me?"
  is the first question asked of a lab mail server, and it should not need a setting
  to answer.

- Fixed: **the admin page showed the wrong SMTP port.** A port that had never been set
  on the page fell back to the built-in default — 2525 — even when the process was
  listening on something else entirely, which is the normal case: a `--smtp-port` flag,
  or running as root and taking port 25. The field read `2525` beside a listener on
  `25`, and the page then advised a restart to "move" a port that was already where it
  should be. A port nobody has chosen now shows the port actually bound.

- Fixed: **a port fixed on the command line is now named as such.** `--smtp-port` and
  `--http-port` (and `TINPOST_SMTP_PORT` / `TINPOST_HTTP_PORT`) outrank anything saved
  on the page, at this start and at every later one — so "restart Tinpost to move it"
  was false advice, and the field looked editable while doing nothing. The page now
  says which port is fixed and what to drop from the start command, the way the Storage
  page already does for `--data-dir`.

- Fixed: **the scroll wheel could silently retune a number field.** A focused
  `<input type="number">` treats the wheel as an instruction to count, so scrolling the
  settings page with the pointer over one edited it without a word — which is how a
  saved web port of `8025` quietly became `7964` and was then reported as waiting for a
  restart. Number fields now give up focus to a wheel instead of counting it; the arrow
  keys and the spinners still work, because those are asked for.

- New: **a log viewer under Admin ▸ Logs.** The server's own log, raw, newest at the
  bottom, with a find box that highlights every match as you type and hides the rest
  until you clear it — plain text, or a regular expression if you tick the box. It can
  be narrowed to one channel (SMTP, Scanning, Admin, Web) and to a minimum level, both
  of which live in the query string so a filtered view can be bookmarked. **Follow**
  tails it live, asking only for lines newer than the last one on screen; **Refresh**
  pulls the newest without reloading, so what you have typed in the find box survives;
  **Download** saves what is on screen as a plain `.log`; and **Clear log** empties the
  buffer. It is memory only — the last 3,000 lines, gone at a restart — because a lab
  instance is thrown away at the end of the afternoon and a file on disk would only
  bring rotation and permissions with it.

  There is also a switch for the **full SMTP conversation**: with it on, every command
  and reply is recorded, tagged with the connection it belongs to so overlapping
  senders stay apart. That is the raw SMTP log — `C: RCPT TO:<…>`, `S: 250 Accepted`,
  the lot. It is off by default, and those lines only ever go to this page, never to
  the terminal, so the startup banner and the one-line delivery summaries stay
  readable.

- New: **attachments can be scanned by an ICAP server before a message is accepted.**
  Point Tinpost at a virus scanner or content filter — address, port and service path,
  under **Scanning** on the admin page — and every attachment is sent for a verdict
  first. Nothing is delivered unless the scanner approves it: over SMTP the sender
  gets a `550` naming the threat and the file, and from the webmail the compose form
  says the same and keeps the draft. It covers both directions, because mail arriving
  over SMTP and mail sent from the webmail go through the same check. **A message with
  no attachment is never scanned**, so plain mail is never delayed. If the scanner
  cannot be reached the message is refused with a `451` — an unscanned message is not
  an approved one — and you can switch that to deliver anyway if the lab matters more
  than the verdict. Scanning is configurable **per domain** as well as globally, and a
  message is scanned when either side asks for it. There is a "Test the connection"
  button that asks the service what it supports without sending any mail.

  The verdict is read from the scanner's `X-Response-Info` header where it sets one,
  because the ICAP status line is not reliable across products: MetaDefender ICAP
  Server answers with a `200` both for a file it refused and for one it merely
  sanitised. A sanitised file is therefore delivered rather than rejected — as the
  original, since Tinpost stores mail as it arrived, which the log says on every such
  message. And a misconfigured scanner is refused with a `550` rather than a `451`: a
  wrong service path does not come right on a retry, so the sender is told plainly
  instead of being asked to queue forever.

- New: **the data directory can be set from the Storage page**, instead of only with
  `--data-dir`. It is created if it does not exist and proven writable before it is
  saved, so a bad path is refused on the page rather than discovered as a server that
  will not start. It applies at the next start, because the database is open from it.
  **Nothing is copied**: pointing somewhere new starts an empty lab and leaves the old
  mail where it is, and pointing at a directory that already holds a lab uses it as it
  is. The page says which of the two will happen before you save. Leave the field blank
  to go back to the default. A `--data-dir` on the command line still wins, and the
  page says so rather than pretending the field is in charge.

- Fixed: **"Reclaim space" no longer claims to have freed files it could not delete.**
  It counted every attempt as a success, so a file it had no permission to remove was
  reported as reclaimed and the byte total was wrong. It now reports those separately
  and says what they usually are: files written while Tinpost was running under sudo,
  which an ordinary user cannot remove. The same applies to purging and to deleting a
  mailbox.

- New: **Tinpost takes the standard SMTP port 25 when it is allowed to.** Started as
  root, it listens on 25 with no flag — running as root is read as intent to be a real
  mail server. Started as an ordinary user on macOS or Linux, where 25 is reserved, it
  falls back to 2525 and says so on the entry page, on the admin page and in the log:
  what port it is on, that it is not root, and that `sudo` is the fix. It never refuses
  to start over this. On Windows low ports are not reserved, so it takes 25 without
  elevation, and if it cannot the warning names the real cause rather than blaming
  privileges. A port you set yourself still wins and is never warned about.

- Changed: the wordmark now reads **Tin·post** and sits about a third larger in the
  top bar. The dot is decoration only — the product is still called Tinpost, and that
  is what a screen reader announces and what you get if you copy it.

---

## v0.2.0 — 18 September 2026

**The tool is now called Tinpost.** MailButler turned out to be a crowded name online.
Everything follows from that: the command is `tinpost`, the package is `tinpost`, the
environment variables are `TINPOST_*`, and the data directory is `~/.tinpost`
(`%LOCALAPPDATA%\Tinpost` on Windows). To keep mail from an earlier install, rename
the directory and the database inside it:

```
mv ~/.mailbutler ~/.tinpost
mv ~/.tinpost/mailbutler.db ~/.tinpost/tinpost.db
```

Otherwise Tinpost starts empty, which for most labs is the right answer anyway.

**This release also removes the `--admin-password` flag and the
`MAILBUTLER_ADMIN_PASSWORD` environment variable.** If either appears in a start
script, delete it — Tinpost will refuse to start with an option it no longer knows.
There is nothing to replace them with: the admin area no longer asks for a password.

- Changed: **the admin area has no password.** Gating it protected nothing — the
  mailboxes beside it are readable by anyone who can reach the web port, so a lock on
  one of two open doors only added a step. Tinpost now has no passwords anywhere,
  binds to loopback by default, and says so plainly on the page and in the startup log
  when it does not. Purging all mail still needs its typed confirmation: losing the
  password does not make the one irreversible control casual.
- New: the admin area is a settings page with a ribbon down the side — SMTP, Domains,
  Mailboxes and Storage. A button at the top collapses it to icons alone when you want
  the width back, and expands it again; hovering a collapsed icon names it, and the
  choice is remembered.
- New: a light and dark switch in the top bar, shown as a sun or a moon. It starts by
  following your system and only remembers a choice once you make one.
- New: **SMTP settings you can change from the page, with no restart.** Maximum message
  size, maximum concurrent connections, maximum recipients per message, idle connection
  timeout, and the server name and greeting banner a scenario sees. Each one says what
  a sender is told when it trips, so you can predict what a client under test will do.
- New: the web and SMTP ports can be set from the page too. These are the one
  exception to "no restart": a listening port cannot move without dropping the page you
  are reading, so they apply at the next start and the page says so until then. A port
  that is already taken, or that needs root, is refused when you save it rather than at
  the next start — a saved setting can never stop Tinpost from coming back up.
- New: the address you type on the entry page completes against the mailboxes this
  instance already knows. With one candidate the rest of the address fills in and stays
  selected, so carrying on typing replaces it; with several, all of them are listed and
  the arrow keys pick one. A brand-new address is no harder to enter than before.
- Fixed: **an oversized message is now cut off rather than read to the end.** The SMTP
  library advertises a size limit and checks what a sender declares, but does not stop
  the transfer itself, so a sender that ignored the limit could keep streaming.
  Measured against a 1 MB limit, a client that previously pushed 60 MB is stopped after
  about 3 MB, still receives a proper `552`, and has its connection closed.
- Fixed: a refused oversized message no longer leaves a truncated copy on disk.
- Changed: concurrent connections are capped at 50 by default. They were unlimited, and
  400 idle connections were enough to exhaust the process.
- Changed: one message can no longer name unlimited recipients. The default cap is 100,
  with the rest refused with `452`, so a single message cannot fan out to thousands of
  mailboxes.
- Changed: the paperclip on a message with attachments is a drawn icon rather than an
  emoji, so it looks the same on every platform. The same goes for the tab icon.
- Docs: [docs/SMTP-OPTIONS.md](docs/SMTP-OPTIONS.md) records every configuration option
  the SMTP listener supports, what Tinpost sets, and which settings are worth
  exposing — including the measurement behind the oversized-transfer fix above.
- Docs: [DESIGN.md](DESIGN.md) records the interface's design system as built, and
  [VERSIONING.md](VERSIONING.md) how releases are numbered and cut.

---

## v0.1.0 — 18 September 2026

First release. Tinpost is a self-contained mail server for lab environments: it
accepts mail over SMTP for any domain, shows every mailbox in a webmail UI that
anyone can open by typing an address, and lets you reply and compose from that UI
with the message delivered back into the same instance. Nothing ever leaves the
machine.

- New: an SMTP listener on `127.0.0.1:2525` that accepts mail for any domain, with no
  authentication and no TLS, so any script, mail client or application under test can
  send to it by pointing at the port.
- New: a webmail front page where you type any address and start reading that
  mailbox. There is no sign-up and no password — a mailbox exists the moment mail is
  addressed to it.
- New: the inbox updates on its own as mail arrives. Send something from a terminal
  and it appears in the open page within a second, without touching the browser.
- New: every message can be read as HTML, as plain text, or as its original source.
  HTML renders with scripts disabled and all remote content blocked, and images
  embedded in the message still display. If a message has no plain-text part, the
  plain view is generated from its HTML, so the tab is never a dead end.
- New: attachments, both directions. Received attachments are listed with their type
  and size and download intact; you can attach files to anything you send from the
  webmail. Attachments always download and are never rendered in the browser, which
  matters when the scenario deliberately involves a hostile file.
- New: **Download .eml** on every message, for feeding the original into another tool.
- New: Reply and Reply-all prefill the recipient, the quoted body and the threading
  headers, so a conversation reads as a conversation.
- New: an admin page behind a single password, no username. Switch between accepting
  any domain and an allowlist, manage the allowed domains, see every mailbox with its
  counts, open or delete one, and purge everything to reset the lab between runs.
  Under the allowlist, other domains are refused with a `550` at the SMTP layer,
  exactly as a real mail server would, so a client under test sees a realistic
  failure.
- New: the admin page shows how much disk the stored mail is using, with a button to
  reclaim space from anything no message points at any more.
- New: runs natively on macOS, Linux and Windows with `npx tinpost`. Nothing
  compiles and there is no database to install.

Storage is deliberately split: a small SQLite file holds only who sent what to whom
and when, while the messages, HTML parts and attachments are ordinary files on disk,
named by the hash of their contents. The database stays a few kilobytes even after a
10 MB attachment, the same attachment sent to ten mailboxes is stored once, and you
can back up or wipe the store with ordinary file tools.
