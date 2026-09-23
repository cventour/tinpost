# Tinpost

A self-contained mail server for lab environments. It listens on SMTP, accepts mail
for any domain you point at it, and shows every mailbox in a webmail UI that anyone
can open by typing an address. You can reply and compose from the UI, and those
messages are delivered back into the same instance.

Nothing leaves the machine unless you tell it to. Out of the box there is no outbound
relay, no DNS lookup and no network call of any kind — which is the point: it lets you
rehearse realistic email conversations in an isolated environment. The one exception
is opt-in: an [upstream relay](#upstream-relay) that hands outbound mail to a security
gateway for scanning and takes it back once scanned.

## What it is for

- Phishing and security-awareness exercises, with real attachments and HTML bodies
- Incident-response and forensics training, where `.eml` files and full headers matter
- Testing an application's signup, password-reset or notification flows
- Demos that need believable mail without touching anyone's real inbox

## Requirements

Node.js 22.5 or newer; Node 24 LTS or later is recommended. **That is the whole
list.** There is no database to install, nothing that compiles, and no native module
anywhere in the dependency tree — mail storage uses Node's built-in SQLite plus
ordinary files on disk. Tinpost never shells out to another program, so there is no
`sudo`, no service manager and no container it depends on. It runs the same on macOS,
Windows and Linux.

If you do not have Node yet:

| | |
|---|---|
| macOS | `brew install node` — or the installer from [nodejs.org](https://nodejs.org) |
| Windows | `winget install OpenJS.NodeJS.LTS` — or the `.msi` from [nodejs.org](https://nodejs.org) |
| Debian / Ubuntu | `curl -fsSL https://deb.nodesource.com/setup_24.x \| sudo -E bash - && sudo apt install nodejs` |

Check it with `node --version`. Anything below 22.5 has no built-in SQLite, and
Tinpost says so plainly rather than failing with a stack trace.

## Installing

Tinpost is not published to the npm registry, so install it from the repository.
The same three commands work on all three platforms — use PowerShell on Windows,
any shell elsewhere:

```bash
git clone https://github.com/cventour/tinpost.git
cd tinpost
npm ci
```

`npm ci` downloads pure JavaScript only; no build step runs and no compiler is
needed. Then start it:

```bash
npm start
```

To get a `tinpost` command on your PATH instead, install the checkout globally:

```bash
npm install -g .
tinpost serve
```

On Windows that creates `tinpost.cmd` in your npm prefix, so `tinpost serve` works
from PowerShell and from `cmd.exe` alike.

## Quick start

```bash
npm start
```

That prints the URLs:

```
  Webmail   http://127.0.0.1:8025
  Admin     http://127.0.0.1:8025/admin   (no password)
  SMTP      127.0.0.1:2525   (any credentials, no TLS)
  Data      /home/you/.tinpost
```

Open the webmail URL, type any address — `alice@lab.local` will do — and you are in
that mailbox. Send something to it:

PowerShell, on any platform:

```powershell
$smtp = [System.Net.Mail.SmtpClient]::new('127.0.0.1', 2525)
$smtp.Send('bob@corp.test', 'alice@lab.local', 'Hello', 'A first message.')
```

Or with `swaks`, if you have it:

```bash
swaks --to alice@lab.local --from bob@corp.test --server 127.0.0.1:2525 --body "hello"
```

It appears in the open page within a second, without a reload.

## Running it

Every example assumes you are in the directory you cloned into. Stop it with
`Ctrl+C`. If you installed globally with `npm install -g .`, write `tinpost serve`
wherever these say `node src/cli.js serve`.

### macOS and Linux

```bash
# Defaults: SMTP on 2525, web on 8025, loopback only
npm start

# The same thing, when you want to pass options
node src/cli.js serve

# Choose the ports
node src/cli.js serve --smtp-port 2525 --http-port 8025

# The standard SMTP port. Needs root on macOS and Linux — see below
sudo node src/cli.js serve --smtp-port 25 --data-dir /usr/local/var/tinpost

# Reachable from other machines on an isolated lab network
node src/cli.js serve --host 0.0.0.0

# Keep the mail somewhere of your choosing
node src/cli.js serve --data-dir ~/labmail
```

### Windows (PowerShell)

```powershell
# Defaults: SMTP on 2525, web on 8025, loopback only
npm start

# The same thing, when you want to pass options
node src\cli.js serve

# Choose the ports
node src\cli.js serve --smtp-port 2525 --http-port 8025

# The standard SMTP port. No elevation needed on Windows — see below
node src\cli.js serve --smtp-port 25

# Reachable from other machines on an isolated lab network
node src\cli.js serve --host 0.0.0.0

# Keep the mail somewhere of your choosing
node src\cli.js serve --data-dir C:\labmail
```

Exposing it with `--host 0.0.0.0` on Windows also needs a firewall rule — see
[Keeping it running](#windows--task-scheduler).

### Port 25 needs root — except on Windows

Ports below 1024 are reserved for root on macOS and Linux. That is a rule of those
systems, not a choice Tinpost makes, and it is why the default is 2525.

| | Default port 2525 | Standard port 25 |
|---|---|---|
| macOS | ordinary user | **`sudo` required** |
| Linux | ordinary user | **`sudo` required**, or grant `CAP_NET_BIND_SERVICE` |
| Windows | ordinary user | ordinary user — Windows does not reserve low ports |

Run as root with no port flag at all and Tinpost takes 25 by itself, because running
as root is read as intent to be a real mail server:

```bash
sudo node src/cli.js serve --data-dir /usr/local/var/tinpost
```

Run as an ordinary user on macOS or Linux and it falls back to 2525 and says why, on
the entry page and in the log. It never refuses to start over this.

**Pass `--data-dir` whenever you use `sudo`.** Under `sudo` the default location
resolves against root's environment rather than yours, so a sudo run and an ordinary
run would otherwise keep two separate mail stores and each would look empty to the
other. Anything written under `sudo` also belongs to root, so a later ordinary run
cannot delete it — the admin page says so plainly if it happens, but naming the
directory once avoids the whole business.

On Linux there is a third way, and it is the one the reference deployment uses: leave
the process unprivileged and grant the one capability it needs. See the systemd unit
under [Keeping it running](#linux--systemd).

## Sending mail to it

Point any client or library at `127.0.0.1:2525`. There is no TLS, because lab senders
are scripts on loopback. `AUTH` is offered and accepts any credential at all, but is
never required — see [Authentication](#authentication).

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
- Point Tinpost at an **ICAP server** and have every attachment scanned before a
  message is accepted &mdash; see below.
- Send outbound mail through an **upstream relay**, such as an email security
  gateway, and take it back once scanned &mdash; see below.
- See every mailbox with its message counts, open one, or delete its mail.
- See how much disk the stored files use, reclaim space, or purge everything to reset
  the lab between runs.
- Read the server's own log, and follow it live &mdash; see below.

## Logs

**Admin ▸ Logs** shows what the instance has written since it started: the raw
lines, newest at the bottom, with a find box that highlights every match as you type
and hides everything else until you clear it. Plain text by default, or tick
**Regex** for a pattern. Channel (SMTP, Scanning, Admin, Web) and level are query
parameters, so a filtered view can be bookmarked and shared, and the page works with
JavaScript switched off.

**Follow** tails the log while you watch, asking only for lines newer than the last
one on screen. **Refresh** pulls the newest lines without reloading, so whatever you
have typed in the find box survives. **Download** saves what is on screen as a plain
`.log` file, and **Clear log** empties the buffer when the last hour is no longer
interesting.

The log is held in memory only &mdash; the last 3,000 lines, and nothing survives a
restart. A lab instance is started, used and thrown away; a file on disk would have
to be rotated, permissioned and cleaned up to answer a question that the last few
thousand lines already answer.

Every connection is logged as it arrives, whether or not anything is then sent: a
sender that connects and gets no further still leaves `smtp: connection from …` and
`… closed without sending a message`, which is usually the whole diagnosis.

In the action bar is a pill switch for the **SMTP conversation**: with it on, every command
and reply is recorded &mdash; `C: MAIL FROM:<…>`, `S: 250 Accepted` and the rest
&mdash; tagged with the connection it belongs to so overlapping senders stay apart.
It is off by default because it is several lines per command, and it is only ever
written to this page, never to the terminal.

## Authentication

There is nothing to authenticate to: every mailbox is readable by anyone who can
reach the web port, by design. But a sender that finds no `AUTH` advertised may
simply hang up rather than deliver, and then the lab cannot receive the mail it
exists to receive. So Tinpost advertises `AUTH` and accepts **anything at all** —
any username, any password, any token, over `PLAIN`, `LOGIN`, `CRAM-MD5` or
`XOAUTH2`. It proves nothing, and is not meant to.

Authentication is never *required*. A sender that skips it is accepted exactly as
before, so nothing that worked yesterday stops working. The username offered is
written to the log, which is often the fastest way to catch a client that
authenticates as one identity and then puts something else in `MAIL FROM`.

Turn the offer off under **SMTP ▸ Authentication** on the admin page if you want to
test how a client behaves against a server that refuses it.

`STARTTLS` is still not offered. A lab sender would need a certificate it could
trust, and issuing one for a `.lab` name is a great deal of ceremony for a server
whose whole point is that nothing about it is secret.

## Keeping it running

Nothing below is required — `npm start` in a terminal is a perfectly good way to run
a lab for an afternoon, and Tinpost needs no service manager. These are only for when
you want it back after a reboot. Each uses what the platform already ships; none
needs extra software.

Replace `/path/to/tinpost` and the Node path with your own. `node --version` and
`which node` (`Get-Command node` on Windows) will tell you them.

### macOS — launchd

Save as `~/Library/LaunchAgents/local.tinpost.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.tinpost</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/path/to/tinpost/src/cli.js</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/tinpost.log</string>
  <key>StandardErrorPath</key><string>/tmp/tinpost.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/local.tinpost.plist
```

`launchctl unload` the same path to stop it. A LaunchAgent runs as you, so it cannot
bind port 25; leave the SMTP port at 2525, or use a LaunchDaemon in
`/Library/LaunchDaemons` if you need the standard port.

### Windows — Task Scheduler

Built into Windows, so there is nothing to install. From an elevated PowerShell:

```powershell
$node = (Get-Command node).Source
$action  = New-ScheduledTaskAction -Execute $node -Argument 'C:\path\to\tinpost\src\cli.js serve' -WorkingDirectory 'C:\path\to\tinpost'
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'Tinpost' -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest
Start-ScheduledTask -TaskName 'Tinpost'
```

`Stop-ScheduledTask -TaskName 'Tinpost'` stops it; `Unregister-ScheduledTask` removes
it. Windows does not reserve ports below 1024, so an ordinary account can bind port 25
there — `-User 'SYSTEM'` is only so the task runs with nobody logged in.

You will likely need a firewall rule before another machine can reach it:

```powershell
New-NetFirewallRule -DisplayName 'Tinpost SMTP' -Direction Inbound -Protocol TCP -LocalPort 2525 -Action Allow
New-NetFirewallRule -DisplayName 'Tinpost web'  -Direction Inbound -Protocol TCP -LocalPort 8025 -Action Allow
```

### Linux — systemd

Save as `/etc/systemd/system/tinpost.service`:

```ini
[Unit]
Description=Tinpost lab mail server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=tinpost
WorkingDirectory=/path/to/tinpost
ExecStart=/usr/bin/node /path/to/tinpost/src/cli.js serve --host 0.0.0.0 --data-dir /var/lib/tinpost
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/tinpost

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now tinpost
```

To take port 25 without running as root, add `AmbientCapabilities=CAP_NET_BIND_SERVICE`
and `CapabilityBoundingSet=CAP_NET_BIND_SERVICE` to the `[Service]` block, then
`--smtp-port 25` to `ExecStart`. Debian's standard image enables `postfix` on
`127.0.0.1:25`, which will hold the port — `systemctl disable --now postfix` first.

## Attachment scanning over ICAP

Tinpost can hand every attachment to an ICAP server — a virus scanner such as c-icap
with ClamAV, a commercial content filter, a sandbox — and accept the message only if
it comes back approved. The same check covers both directions: mail arriving over
SMTP and mail sent from the webmail go through it.

Turn it on under **Scanning** on the admin page and give it the address, port and
service path of your ICAP server (the standard port is 1344; c-icap typically calls
its scanning service `/avscan`). The field also accepts a whole
`icap://host:port/service` URL, which then supplies the host and port itself. "Test
the connection" sends an ICAP `OPTIONS` request and reports what the service says it
supports, without sending any mail.

What happens then:

- A message **with no attachment is never scanned**. There is nothing for a scanner
  to look at, and no message is delayed for one. Inline images count as attachments
  here: they are files a message carries, whatever a mail client chooses to show.
- Each attachment is sent on its own, as a `RESPMOD` request (or `REQMOD` if that is
  all your service does), wrapped in the synthetic HTTP message the protocol requires.
  `Preview` is supported: set one and only the first N bytes go over first, with the
  rest following if the scanner asks for them.
- The verdict is read from the `X-Response-Info` header where the scanner sets one,
  because the status line is not reliable across products: MetaDefender ICAP Server
  answers `RESPMOD` with a `200` whether it refused the file or merely rewrote it, and
  reserves `403` for a method Tinpost does not use. Where there is no such header, a
  `204` is clean, a `403` is a refusal, and a `200` carrying replacement content is
  read as one too.
- A refusal stops the message. Over SMTP the sender gets a `550` naming the threat and
  the file; from the webmail the compose form says the same and keeps the draft.
- A file the scanner **sanitised or redacted** rather than refused is approved, and is
  delivered. Tinpost stores mail exactly as it arrived and has nowhere to put a
  rewritten MIME part, so what lands is the original, not the scanner's cleaned copy —
  and the log says so on every such message.
- If **no verdict comes back** — the scanner is down, times out, or returns an error —
  the default is to refuse the message, and you can switch that to deliver anyway,
  which is then said plainly in the log. A scanner that is merely unreachable gets a
  `451`, a real MTA's "come back later". A **misconfiguration** gets a `550` instead:
  a wrong service path or an unsupported method will not fix itself on a retry, and
  answering `451` would hide the fault behind a queue that never drains. The message
  names the fix.
- Nothing is written to a mailbox until the verdict is in, so a refused message never
  appears anywhere. Its raw file is cleaned up by the next pass of "Reclaim space".

Scanning is configured **per domain** as well. Each domain can be set to scan, not to
scan, or to follow the global default, and a message is scanned when either side asks
for it — the sender's domain or any recipient's — so one entry covers a domain's mail
in both directions.

## Upstream relay

**Admin ▸ Upstream relay** hands mail crossing into or out of your local domains to
another SMTP server — in practice a security gateway such as OPSWAT MetaDefender Email
Security — which scans it and sends it back to Tinpost's SMTP port for delivery. Give it the gateway's host and port,
optionally a username and password, and the list of **local domains**. It speaks plain
SMTP; there is no TLS.

How each message is routed:

| Message | What happens |
|---|---|
| From a local domain to the **same** domain | Delivered directly. Never leaves. ICAP scanning applies as usual. |
| From a local domain to **any other** domain | Handed to the gateway. The sender's copy is marked *relayed, awaiting scan*; the recipients get it when the gateway sends it back. Tinpost's own ICAP scan is skipped. |
| From any other domain **to a local domain** | Handed to the gateway too, whether it was written in the webmail or arrived over SMTP. The local recipients get it when the gateway sends it back. |
| Sent back by the gateway | Delivered to the recipients it was relayed for, and never relayed again. |
| Gateway unreachable, or it refuses the message | Delivered locally **without scanning**, with a footnote in the body giving the error, SMTP reply included. |
| Between two domains that are **not local** | Delivered directly. ICAP scanning applies as usual. |

A message addressed to both kinds of recipient is split: colleagues in the sender's
domain get it straight away, and everyone else gets it through the gateway. Mail that
the gateway itself delivers to Tinpost — including inbound mail it has already
scanned — is recognised by its address and delivered directly, never sent round again.

Tinpost recognises the gateway's returned mail by the address it connects from, not by
anything in the message, because a sender cannot forge its source address. Under
**Gateway return addresses**, list the IP addresses or host names the gateway sends
from; leave the field empty if that is the same address it listens on. Every message
handed to the gateway is stamped with an `X-Tinpost-Relayed` header. If one comes back
from an address that is not listed, Tinpost refuses it with `554` as a mail loop and
logs which setting to fix, rather than relaying it forever.

There is no queue. A message the gateway cannot take is delivered, not retried, so
"Test the connection" is worth pressing before a session: it connects, greets and logs
in, and sends nothing. Relay activity is under the **Relay** channel on the Logs page.

Mail on its way out is accepted even under the allowlist policy, since the allowlist
is about which domains Tinpost hosts, and outbound recipients are not hosted here.

Anything that sends straight to Tinpost's SMTP port from another domain into a local
one — a script, a product's notification mail — now goes through the gateway as well.
If a sender should bypass the gateway, list its address under gateway return
addresses; its mail is then delivered directly.

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

A port you choose yourself — by flag, or on the admin page — always wins over the
default and is never warned about. For which platforms need elevation to take port 25,
and the `sudo` caveat that comes with it, see
[Port 25 needs root](#port-25-needs-root--except-on-windows).

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
- Sender-chosen text sent to an ICAP server (attachment names, addresses, subject)
  is stripped of line breaks and quotes, so a hostile message cannot forge a
  protocol header
- The upstream relay password is stored in the Tinpost database as typed and is
  never shown on the page again. The relay uses plain SMTP, so it and every relayed
  message cross the network unencrypted — keep the gateway on the lab network

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
