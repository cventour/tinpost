# Tinpost

A self-contained mail server for lab environments. It listens on SMTP, accepts mail
for any domain you point at it, and shows every mailbox in a webmail UI that anyone
can open by typing an address. You can reply and compose from the UI, and those
messages are delivered back into the same instance.

Nothing ever leaves the machine. There is no outbound relay, no DNS lookup and no
network call of any kind — which is the point: it lets you rehearse realistic email
conversations in an isolated environment.

## What it is for

- Phishing and security-awareness exercises, with real attachments and HTML bodies
- Incident-response and forensics training, where `.eml` files and full headers matter
- Testing an application's signup, password-reset or notification flows
- Demos that need believable mail without touching anyone's real inbox

## Requirements

Node.js 22.5 or newer; Node 24 LTS or later is recommended. That is the whole list.
There is no database to install and nothing that compiles — mail storage uses Node's
built-in SQLite plus ordinary files on disk. It runs the same on macOS, Linux and
Windows.

## Quick start

```bash
npx tinpost serve
```

That prints the URLs:

```
  Webmail   http://127.0.0.1:8025
  Admin     http://127.0.0.1:8025/admin   (no password)
  SMTP      127.0.0.1:2525   (no AUTH, no TLS)
  Data      /home/you/.tinpost
```

Open the webmail URL, type any address — `alice@lab.local` will do — and you are in
that mailbox. Send something to it:

```bash
swaks --to alice@lab.local --from bob@corp.test --server 127.0.0.1:2525 --body "hello"
```

It appears in the open page within a second, without a reload.

## Sending mail to it

Point any client or library at `127.0.0.1:2525`. There is no authentication and no
TLS, because lab senders are scripts on loopback.

Node:

```js
import nodemailer from 'nodemailer';

const transport = nodemailer.createTransport({ host: '127.0.0.1', port: 2525, secure: false });

await transport.sendMail({
  from: '"IT Helpdesk" <helpdesk@corp.test>',
  to: 'alice@lab.local',
  subject: 'Action required',
  html: '<p>Please review the <b>attached</b> report.</p>',
  attachments: [{ filename: 'report.pdf', path: './report.pdf' }],
});
```

Python:

```python
import smtplib
from email.message import EmailMessage

msg = EmailMessage()
msg["From"] = "helpdesk@corp.test"
msg["To"] = "alice@lab.local"
msg["Subject"] = "Action required"
msg.set_content("Please review the attached report.")
msg.add_attachment(open("report.pdf", "rb").read(),
                   maintype="application", subtype="pdf", filename="report.pdf")

with smtplib.SMTP("127.0.0.1", 2525) as s:
    s.send_message(msg)
```

An application under test usually just needs its SMTP settings pointed at
`127.0.0.1:2525` with authentication and TLS turned off.

## Reading mail

Type an address on the entry page and you are reading that mailbox. There is no
password, because in a lab the whole point is that anyone can look at any mailbox.
A mailbox is not something you create: it exists as soon as mail is addressed to it.

Addresses this instance has already seen complete as you type. With one candidate the
rest of the address fills in and stays selected, so carrying on typing replaces it;
with several, they are listed and the arrow keys pick one. A new address is never
harder to enter than an existing one.

Each message can be read three ways:

- **HTML** — rendered in a sandboxed frame with scripts disabled and every network
  source blocked. Inline `cid:` images are embedded directly, so embedded graphics
  still display while nothing is fetched from outside.
- **Plain text** — the text part, or a readable rendering of the HTML when the
  message has no text part.
- **Source** — the full original message, headers and all, with a **Download .eml**
  button for feeding it into another tool.

Attachments are listed with their type and size and always download; they are never
rendered or executed in the browser. That matters when the lab scenario deliberately
involves a hostile file.

The inbox updates on its own as mail arrives, using a server-sent event stream with a
polling fallback.

## Sending from the webmail

Compose and Reply work from any mailbox you are reading. Recipients can be on any
domain the accept policy allows, and delivery is internal — the message simply lands
in the recipient's mailbox on the same instance. You can attach files, and choose
whether the body is sent as plain text or HTML (a plain-text alternative is generated
either way, so the message is readable in both views).

Mail composed in the UI goes through exactly the same delivery path as mail that
arrived over SMTP, so it is stored as a genuine RFC822 message and is
indistinguishable from received mail.

## Admin

`/admin` has no password. Gating it would protect nothing: the mailboxes beside it are
already readable by anyone who can reach the web port, so the honest answer is to bind
to loopback and say so plainly rather than put a lock on one of two open doors.

From there you can:

- Switch between **any domain** (catch-all) and **allowlist only**, and manage the
  list of accepted domains. Under the allowlist, other domains are refused at the
  SMTP layer with a `550`, exactly as a real MTA would, so a client under test sees a
  realistic failure. The compose form honours the same rule.
- See every mailbox with its message counts, open one, or delete its mail.
- See how much disk the stored files use, reclaim space, or purge everything to reset
  the lab between runs.

## Options

```
tinpost serve [options]

  --smtp-port <n>        SMTP listen port (default 2525)
  --http-port <n>        Web listen port (default 8025)
  --host <addr>          Address to bind (default 127.0.0.1)
  --data-dir <path>      Where the database and stored files live
  --max-size <bytes>     Largest accepted message (default 25 MB)
```

Each has an environment-variable equivalent: `TINPOST_SMTP_PORT`,
`TINPOST_HTTP_PORT`, `TINPOST_HOST`, `TINPOST_DATA_DIR`,
`TINPOST_MAX_SIZE`.

The limits, the server name and the ports can also be set from the admin page. The
limits apply to the next connection; the ports apply at the next start, because a
listening port cannot move without dropping the page you are on. A port given on the
command line overrides what is saved.

### Port 25

Tinpost uses the standard SMTP port when it can, and says so when it cannot.

- **Run as root** and it listens on **25** with no flag needed, because running as root
  is taken as intent to be a real mail server:

  ```bash
  sudo tinpost serve
  ```

- **Run as an ordinary user** on macOS or Linux and port 25 is reserved by the system,
  so it falls back to **2525** and carries a warning on the entry page and in the log
  explaining why and how to change it. It never refuses to start over this.

- **On Windows** low ports are not reserved, so it takes 25 without elevation. If 25 is
  unavailable there it is because another program holds it, and the warning says that
  instead.

A port you choose yourself — by flag, or on the admin page — always wins over this, and
is never warned about.

## Where the data goes

The data directory holds a small SQLite file and a `blobs/` directory:

```
~/.tinpost/
  tinpost.db     index only: who sent what, to whom, when
  blobs/            the actual bytes: raw messages, HTML parts, attachments
```

The database stays an index and never grows large — after delivering a 10 MB
attachment it is still a few kilobytes, because the bytes are on the filesystem. That
keeps it fast, keeps `du -sh` honest about how much disk the lab is using, and lets
you back up or wipe the store with ordinary file tools. Files are named by the SHA-256
of their content, so the same attachment sent to ten mailboxes is stored once, and an
attacker-chosen filename never touches a path.

On Windows the default is `%LOCALAPPDATA%\Tinpost`.

You can move it from **Admin ▸ Storage** rather than passing `--data-dir` every time.
The location is remembered in a small pointer file — `~/.config/tinpost/datadir`, or
`%APPDATA%\Tinpost\datadir` on Windows — because it cannot be kept in the database
that lives inside the directory it names. Moving copies nothing: the new location
starts empty unless it already holds a lab, and the old mail stays where it is. A
`--data-dir` flag overrides the saved location for that run.

## Security

This is a lab tool, and it is deliberately open: **there are no passwords anywhere.**
Anyone who can reach the web port can read every mailbox, change the settings and
delete all the mail. That is the feature, not an oversight — a lab that makes you
manage credentials is a lab nobody uses. It binds to `127.0.0.1` by default for that
reason. Use `--host 0.0.0.0` only on an isolated lab network; the admin page and the
startup log both warn you when it is in effect.

Within that model, the reader is protected from the mail:

- HTML bodies render in a sandboxed frame with no scripts and a CSP denying every
  network source, so a message cannot run code or call home
- Attachments are always served as downloads with a neutral content type and
  `nosniff`, so nothing executes in the browser
- Stored files are named by content hash, so hostile filenames cannot traverse paths

Do not put real credentials or real personal data into it, and do not expose it to an
untrusted network.

## Development

```bash
npm install
npm test          # 58 tests, no network access required
npm start         # runs the server from source
```

## Versioning

Tinpost follows Semantic Versioning and is in the `0.x` series. See
[VERSIONING.md](VERSIONING.md) for what each number means and how a release is cut,
and [CHANGELOG.md](CHANGELOG.md) for what has changed.

## Licence

MIT
