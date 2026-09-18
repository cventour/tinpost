# What's new

Every release, in plain language. Newest first.

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
