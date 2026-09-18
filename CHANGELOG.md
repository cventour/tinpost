# What's new

Every release, in plain language. Newest first.

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
