# Security and intended use

Tinpost is a lab tool. It is licensed under the [MIT License](LICENSE), which grants
broad permission to use, modify and redistribute it, and disclaims all warranty and
liability. This note does not change those terms. It describes what Tinpost is built
for, what it deliberately does not protect, and how to report a problem.

## Intended use

Tinpost is for **authorised testing in environments you control**: your own machines,
your own lab network, your own test domains, or a client's systems where you have
written permission to conduct the work.

Typical, legitimate uses:

- Security-awareness and phishing-simulation exercises run for your own organisation,
  or for a client who has engaged you to run them
- Incident-response and forensics training on messages you generated yourself
- Testing an application's signup, password-reset or notification flows
- Exercising a mail gateway, ICAP scanner or content filter you are responsible for

Tinpost accepts mail for any domain, composes messages with arbitrary sender
addresses, and carries real attachments. Those are the features that make it useful
for the work above, and the same features make misuse possible. **Using it to deceive
people who have not consented to a test, to impersonate a real organisation outside an
authorised exercise, or to develop or stage an attack against systems you do not own
is not an intended use, and in most jurisdictions is a criminal offence.** The licence
permits a great deal; the law still applies.

## What Tinpost does not protect

**There are no passwords anywhere, by design.** Anyone who can reach the web port can
read every mailbox, change every setting and delete all the mail. A lab that makes you
manage credentials is a lab nobody uses, so the trade was made deliberately and is not
a defect.

It follows that:

- **Tinpost is not a security boundary.** Do not place anything behind it that you
  would not hand to everyone who can reach the host.
- **It binds `127.0.0.1` by default.** `--host 0.0.0.0` exposes every mailbox to the
  whole network — use it only on an isolated lab segment. The admin page and the
  startup log both warn while it is in effect.
- **Do not put it on the internet**, or on any network you do not control.
- **Do not put real credentials or real personal data into it.** It is a test fixture,
  not a mail system. There is no encryption at rest and no access control.
- **`AUTH` proves nothing.** Tinpost advertises it and accepts any username, password
  or token, so that clients which refuse to talk to a server without it can connect.
  It is not authentication in any meaningful sense.
- **The upstream relay speaks plain SMTP**, with no TLS. The relay password and every
  relayed message cross the network unencrypted. Keep the gateway on the lab network.

Within that model, the *reader* is protected from the *mail* — HTML bodies render in a
sandboxed frame with no scripts and a CSP that denies every network source, attachments
always download rather than execute, stored files are named by content hash so hostile
filenames cannot traverse paths, and sender-chosen text sent to an ICAP server is
stripped of anything that could forge a protocol header. Those protections are in
scope. See [Security](README.md#security) in the README for the detail.

## Reporting a vulnerability

Report privately through
[GitHub Security Advisories](https://github.com/cventour/tinpost/security/advisories/new),
which keeps the report confidential until a fix exists. Please do not open a public
issue for a security problem.

A useful report says what you did, what happened, and what you expected. Proof-of-
concept code is welcome. There is no bounty — this is a personal project — but
credit is given in the changelog unless you would rather it were not.

**In scope**, because these are the promises Tinpost does make:

- Escaping a message body's sandbox, or getting a stored message to execute script
  in the reader's browser
- Reading or writing a file outside the data directory, by any route
- Crashing or hanging the server from a single SMTP connection or HTTP request
- Injecting a forged header or command into the ICAP or SMTP protocol streams
- Anything that lets one mailbox's content leak into another where the UI says it
  should not

**Out of scope**, because they follow from the design stated above:

- The absence of authentication on the webmail or the admin page
- `AUTH` accepting any credential
- Mailboxes being readable by anyone who can reach the port
- The relay and SMTP being unencrypted
- Anything that requires the operator to have exposed the instance to a hostile
  network against the guidance here

If you are unsure which side of the line something falls on, report it. A clear
explanation of why a documented trade-off is worse than it looks is a useful report
in itself.
