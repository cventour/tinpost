/**
 * Whether this process may bind a privileged port, and what to tell the operator
 * when it may not.
 *
 * The rule is not the same everywhere, and pretending otherwise would produce a
 * warning that is simply wrong on Windows:
 *
 * - macOS and Linux reserve ports below 1024 for root.
 * - Linux can also grant `CAP_NET_BIND_SERVICE` to an unprivileged process, so a
 *   non-root process there may still succeed. That cannot be read reliably without
 *   parsing /proc, so it is discovered by trying rather than predicted.
 * - Windows does not reserve low ports at all. An ordinary user can bind 25, so
 *   there is nothing to elevate and no warning to show.
 */

/** The standard SMTP port, and the one the operator wants when they can have it. */
export const STANDARD_SMTP_PORT = 25;

/** The unprivileged fallback. */
export const FALLBACK_SMTP_PORT = 2525;

export function isPosix() {
  return process.platform !== 'win32';
}

/** True when this process is root. Always false on Windows, which has no uid. */
export function isRoot() {
  return isPosix() && typeof process.getuid === 'function' && process.getuid() === 0;
}

/**
 * Whether binding a port below 1024 is expected to work.
 *
 * On Windows this is always true. On POSIX it is true only for root — a Linux
 * process holding CAP_NET_BIND_SERVICE will report false here and then succeed
 * anyway, which is the safe direction to be wrong in: we try, and it works.
 */
export function mayBindPrivilegedPorts() {
  return !isPosix() || isRoot();
}

/**
 * How the process is running, in the words the interface uses.
 *
 * @returns {{ root: boolean, platform: string, privilegedPortsReserved: boolean }}
 */
export function privilegeState() {
  return {
    root: isRoot(),
    platform: process.platform,
    privilegedPortsReserved: isPosix(),
  };
}

/**
 * Which SMTP port to use when the operator has not chosen one.
 *
 * Running as root is taken as intent to be a real mail server on the real port;
 * anything else falls back to 2525. An explicit flag or a saved setting always wins
 * over this, and is resolved before we get here.
 */
export function defaultSmtpPort() {
  return mayBindPrivilegedPorts() ? STANDARD_SMTP_PORT : FALLBACK_SMTP_PORT;
}

/**
 * The sentence shown when the standard port is not in use, or null when there is
 * nothing to say. Split into a headline and a remedy so the page can weight them.
 *
 * @param {{ smtpPort: number, chosenExplicitly: boolean }} state
 */
export function portNotice({ smtpPort, chosenExplicitly }) {
  if (smtpPort === STANDARD_SMTP_PORT) return null;

  // A port the operator picked is not a problem to warn about.
  if (chosenExplicitly) return null;

  if (!isPosix()) {
    // Windows does not reserve the port, so if we are not on it something else is.
    return {
      headline: `Listening on port ${smtpPort} rather than the standard port 25.`,
      detail: 'Port 25 could not be bound — another program on this machine is most likely already using it.',
    };
  }

  return {
    headline: `Listening on port ${smtpPort}, not the standard port 25.`,
    detail:
      'Port 25 is reserved for root on this system, and Tinpost is not running as root. ' +
      'Senders must be pointed at this port explicitly. To use port 25 instead, start it with sudo.',
  };
}
