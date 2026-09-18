# What's new

Every release, in plain language. Newest first.

---

## Unreleased

- New: the admin area is now a settings page with a vertical ribbon down the side —
  SMTP, Domains, Mailboxes, Storage and Password. A button at the top collapses it to
  icons alone when you want the width back, and expands it again; hovering a collapsed
  icon names it, and the choice is remembered.
- New: a light/dark switch in the top bar, shown as a sun or a moon. It starts by
  following your system and only remembers a choice once you make one.
- New: **SMTP settings you can change from the page**, with no restart. Maximum
  message size, maximum concurrent connections, maximum recipients per message, idle
  connection timeout, and the server name and greeting banner the scenario sees. Each
  one states what a sender is told when it trips.
- New: the web and SMTP ports can be set from the page too. These are the exception:
  a listening port cannot move without dropping the page you are reading, so they
  apply at the next start, and the page says so until then. A port that is already
  taken, or that needs root, is refused when you save it rather than at the next
  start, so a saved setting can never stop MailButler from coming back up.
- Fixed: an oversized message is now cut off rather than read to the end. The library
  advertises a size limit and checks what a sender declares, but does not stop the
  transfer, so a sender ignoring it could stream indefinitely. Measured against a
  1 MB limit, a client that pushed 60 MB is now stopped after about 3 MB, still gets a
  proper `552`, and has its connection closed.
- Fixed: a refused oversized message no longer leaves a truncated copy on disk.
- Changed: concurrent connections are capped at 50 by default. They were unlimited,
  and 400 idle connections were enough to exhaust the process.
- Changed: one message can no longer name unlimited recipients; the default cap is 100,
  with the rest refused with `452`.
- Changed: the paperclip on a message with attachments is now a drawn icon rather than
  an emoji, so it looks the same on every platform. The same goes for the tab icon.
- Changed: you are no longer asked to invent an admin password at first start.
  MailButler generates one, prints it to the server log next to the address it is
  listening on, and treats it as temporary. Signing in with it leads straight to a
  "choose your admin password" page, and nothing else in the admin area works until
  you have replaced it. Changing the password signs out every admin session,
  including the one you changed it from.
- Changed: the sign-in page now says where to find the generated password on a first
  start, instead of leaving you to guess.
- New: **Change password** on the admin page, for changing it later. It asks for the
  current password as well as the new one, so a session cookie on its own is never
  enough to take an instance over.
- Changed: starting with `--admin-password` when a password is already stored now
  says so in the log. Left in a start script, the flag silently undid a password set
  in the admin page on every restart.
- Docs: [docs/SMTP-OPTIONS.md](docs/SMTP-OPTIONS.md) documents every configuration
  option the SMTP listener supports, what MailButler sets today, and which settings
  are worth exposing. It records a measured finding: the `size` limit is advertised
  and checked against a client's declared size, but does not stop an oversized
  transfer, so a sender that ignores it can keep streaming. Nothing is stored and no
  disk is consumed, but the reading is unbounded.

---

## v0.1.0 — 18 September 2026

First release. MailButler is a self-contained mail server for lab environments: it
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
- New: runs natively on macOS, Linux and Windows with `npx mailbutler`. Nothing
  compiles and there is no database to install.

Storage is deliberately split: a small SQLite file holds only who sent what to whom
and when, while the messages, HTML parts and attachments are ordinary files on disk,
named by the hash of their contents. The database stays a few kilobytes even after a
10 MB attachment, the same attachment sent to ten mailboxes is stored once, and you
can back up or wipe the store with ordinary file tools.
