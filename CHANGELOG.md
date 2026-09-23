# What's new

Every release, in plain language. Newest first.

---

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
