# SMTP listener: configuration capabilities

What `smtp-server` 3.19 exposes, what MailButler sets today, and what is worth
putting on the admin page. Priorities here are scalability, protection against
abuse, and not letting a single oversized or hostile sender take the instance down.

Measured against the code in `node_modules/smtp-server/lib/`, not from memory.

## The finding that matters most

**`size` does not stop an oversized transfer.** The library's own README is explicit:
declared sizes in `MAIL FROM:<addr> SIZE=nnn` are checked, "but the actual transfer
size is not enforced by the server itself". The stream sets `sizeExceeded = true` and
keeps going to the terminating dot.

Measured on MailButler with a 1 MB limit, a client that ignores the advertised SIZE:

| | Result |
|---|---|
| Bytes the client managed to push | **60 MB**, all read off the wire |
| Messages stored | 0 |
| Blob bytes left on disk | 0 |
| Peak bytes in the temp directory | 640 KB |
| Server reply | `552 Message exceeds the configured size limit` |
| Connection cut early | **No** |

So disk and memory are already safe — the blob store aborts its write, cleans up the
partial file, and nothing is stored. What is *not* bounded is the reading: one client
can stream unlimited bytes at the process and we will keep consuming them until they
choose to stop. That is the gap to close, and it is a few lines rather than a
redesign, because `sizeExceeded` and `byteLength` update in real time during the
transfer.

## Full option inventory

Every option the library accepts, grouped by what it is for.

### Limits and resource protection

| Option | Default | What it does |
|---|---|---|
| `size` | unset | Advertises a maximum in the EHLO `SIZE` capability and refuses a `MAIL FROM` that *declares* a larger size with `552`. Does **not** stop the transfer itself. |
| `hideSize` | `false` | When true, advertises `SIZE` with no number **and skips the `MAIL FROM SIZE=` check entirely**. Turning this on removes the only limit the library enforces on its own. |
| `maxClients` | unset (unlimited) | Caps concurrent connections; over the cap the server answers `421 Too many connected clients`. |
| `socketTimeout` | 60 s | Idle time before a connection is dropped. |
| `closeTimeout` | 30 s | How long `close()` waits for connections still in flight. |
| `maxCommandLength` | 4096 bytes | Longest single protocol line before the connection is torn down. Bounds memory for a client that sends a line and never a newline. |
| `maxAllowedUnauthenticatedCommands` | 10 | Commands allowed before authentication. **Inert when `authOptional` is set**, which is MailButler's case, so it offers nothing here. |

### Protocol and identity

| Option | Default | What it does |
|---|---|---|
| `name` | OS hostname | The server name used in greetings and responses. |
| `banner` | none | Extra text on the `220` greeting. |
| `heloResponse` | none | Overrides the text of the EHLO/HELO reply. |
| `lmtp` | `false` | Speak LMTP instead of SMTP: one response per recipient rather than one per message. |
| `hideSTARTTLS` / `hideENHANCEDSTATUSCODES` / `hideDSN` / `hideREQUIRETLS` | last three `true` | Suppress individual EHLO capabilities. |
| `lenientAddressParsing` | `false` | Accept malformed addresses that a strict parser rejects. |
| `disableReverseLookup` | `false` | Skip the reverse-DNS lookup of the client address. |
| `resolver` | Node default | A custom DNS resolver. |
| `disabledCommands` | `[]` | Refuse named commands outright, e.g. `AUTH`, `STARTTLS`. |

### Authentication and transport security

| Option | Default | What it does |
|---|---|---|
| `authOptional` | `false` | Allow mail without authentication while still offering AUTH. |
| `authMethods` | `LOGIN`, `PLAIN` | Which SASL mechanisms to offer. |
| `allowInsecureAuth` | `false` | Permit plaintext auth on an unencrypted connection. |
| `authRequiredMessage` | default text | Wording of the auth-required refusal. |
| `secure` / `key` / `cert` / `pfx` / `SNICallback` / `sniOptions` | unset | Implicit TLS and its certificate material. |
| `needsUpgrade` | `false` | Socket starts plain and is upgraded immediately. |

### Proxy and deployment

| Option | Default | What it does |
|---|---|---|
| `useProxy` | `false` | Parse a HAProxy PROXY header for the real client address. Header is capped at 1024 bytes. |
| `useXClient` / `useXForward` | `false` | Honour the `XCLIENT` / `XFORWARD` extensions. |
| `ignoredHosts` | none | Hosts whose mail is accepted and silently dropped. |
| `logger` | `false` | A bunyan-style logger, or `false` for silence. |
| `component` | `'smtp-server'` | Name used in log records. |

### Handlers

`onConnect`, `onAuth`, `onMailFrom`, `onRcptTo`, `onData`, `onClose`. MailButler uses
`onRcptTo` for the domain policy and `onData` for storage.

## What MailButler sets today

```js
name: 'mailbutler',
banner: 'MailButler lab mail server',
authOptional: true,
disabledCommands: ['AUTH', 'STARTTLS'],   // anonymous submission, by design
size: config.maxSize,                      // 25 MB default
disableReverseLookup: true,                // lab senders rarely have rDNS
logger: false,
```

Everything else is at its default, which means **`maxClients` is unlimited**. Measured:
400 idle connections were accepted with none refused. On a default macOS file-descriptor
limit that is comfortably enough to exhaust the process.

## Recommended for the settings page

In priority order. The first two are the ones I would not ship a networked lab without.

### 1. Enforce the size limit during transfer, not after it — code, not a setting

Before adding any dial, close the gap the measurement found. In `onData`, watch the
stream and destroy the connection the moment `sizeExceeded` flips, instead of letting
the sender finish. Keep replying `552` so a client under test still sees the correct
protocol failure. This costs nothing to the honest path and turns an unbounded read
into a bounded one.

### 2. Maximum concurrent connections — `maxClients`

The unlimited default is the sharpest edge. A suggested default of **50** is far above
anything a lab does and far below anything that exhausts descriptors. The library
already answers `421` over the cap, which is the correct and realistic refusal.

### 3. Maximum message size — `size` / `--max-size`

Already a CLI flag; it belongs on the page too, because it is the setting an operator
most often needs to change and restarting to change it is friction. Expose it in MB
with a sane floor, and state plainly that it is enforced by MailButler rather than
merely advertised.

### 4. Idle connection timeout — `socketTimeout`

60 s is reasonable, but a lower value (say **30 s**) frees slots faster when a test
harness abandons connections, which is common. Cheap protection against slow-loris
style holding.

### 5. Maximum recipients per message — needs implementing in `onRcptTo`

The library has no option for this; it is a counter in the handler. Without it, one
message can name thousands of recipients and fan out to thousands of mailbox rows.
A default of **100** is generous for a lab. Refuse beyond it with `452 Too many
recipients`, which is the standard response.

### 6. Server name and banner — `name`, `banner`

Not protection, but the reason a scenario feels real: a phishing exercise reads better
when the server announces itself as `mail.corp.test` rather than `mailbutler`. Cheap
to expose, and it changes what a participant sees in the headers.

### Deliberately not recommended

- **`hideSize: true`** — it removes the `MAIL FROM SIZE=` check, which is the one
  limit the library enforces for us. It would make things worse.
- **`maxAllowedUnauthenticatedCommands`** — inert while `authOptional` is set.
- **`allowInsecureAuth`, `authMethods`, TLS options** — MailButler disables AUTH and
  STARTTLS on purpose. Adding authentication is a product decision, not a setting.
- **`useProxy` / `useXClient` / `useXForward`** — only meaningful behind a real proxy,
  and each one lets a client assert its own address. Not for a loopback lab tool.
- **`lenientAddressParsing`** — accepting malformed addresses makes a lab less
  faithful to what a real MTA would do, which defeats the purpose.

## Settings shape

Two groups on the admin page, with a note that changes take effect on restart:

**Limits** — max message size (MB), max concurrent connections, max recipients per
message, idle timeout (seconds).

**Identity** — server name, greeting banner.

Every one of these needs a floor and a ceiling on input, and a stated default, so an
operator cannot set `maxClients` to 0 and wonder why the lab stopped accepting mail.
