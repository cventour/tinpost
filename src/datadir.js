import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { mkdir, readFile, writeFile, rm, stat, access, unlink } from 'node:fs/promises';
import { constants, readFileSync } from 'node:fs';

/**
 * Where Tinpost keeps its data, and how that can be changed from the admin page.
 *
 * Every other setting lives in the database. This one cannot: the database is
 * *inside* the directory the setting names, so storing it there would mean having to
 * find the data before being able to read where the data is. It is kept instead in a
 * one-line pointer file at a fixed location that never moves.
 *
 * Resolution order, highest first:
 *   1. --data-dir, or TINPOST_DATA_DIR — an explicit instruction for this run
 *   2. the pointer file, written by the admin page
 *   3. the platform default
 */

/** The fixed location of the pointer. This path is the one thing that cannot move. */
export function pointerPath() {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Tinpost', 'datadir');
  }
  return join(homedir(), '.config', 'tinpost', 'datadir');
}

/** The platform's default location, used when nothing else says otherwise. */
export function platformDefaultDataDir() {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Tinpost');
  }
  return join(homedir(), '.tinpost');
}

/** The path the pointer names, or null when there is no pointer. */
export async function readPointer() {
  try {
    const raw = (await readFile(pointerPath(), 'utf8')).trim();
    return raw ? resolve(raw) : null;
  } catch {
    return null;
  }
}

/** Synchronous twin, because config loading is synchronous. */
export function readPointerSync() {
  try {
    const raw = readFileSync(pointerPath(), 'utf8').trim();
    return raw ? resolve(raw) : null;
  } catch {
    return null;
  }
}

export async function writePointer(dir) {
  const target = resolve(dir);
  await mkdir(join(pointerPath(), '..'), { recursive: true });
  await writeFile(pointerPath(), `${target}\n`, 'utf8');
  return target;
}

/** Remove the pointer, so the platform default applies again. */
export async function clearPointer() {
  await unlink(pointerPath()).catch(() => {});
}

/**
 * Can Tinpost actually use this directory?
 *
 * Checked before it is saved rather than discovered at the next start, because a bad
 * path here is the one setting that stops the instance from coming up at all — and
 * unlike a port, it cannot be recovered from in the admin page afterwards.
 */
export async function checkDataDir(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: 'The data directory cannot be empty.' };

  // A relative path would resolve against whatever directory the server happened to
  // be started from, which is not something an operator can predict.
  if (!isAbsolute(raw)) {
    return { ok: false, error: 'Give an absolute path, so it does not depend on where Tinpost was started from.' };
  }
  if (/[\r\n\0]/.test(raw)) {
    return { ok: false, error: 'The path cannot contain line breaks or null characters.' };
  }

  const target = resolve(raw);

  let existed = true;
  try {
    const s = await stat(target);
    if (!s.isDirectory()) {
      return { ok: false, error: `${target} exists but is not a directory.` };
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      return { ok: false, error: `${target} cannot be used: ${err.code}.` };
    }
    existed = false;
    try {
      await mkdir(target, { recursive: true });
    } catch (mkErr) {
      return {
        ok: false,
        error:
          mkErr.code === 'EACCES' || mkErr.code === 'EPERM'
            ? `Tinpost does not have permission to create ${target}.`
            : `${target} could not be created: ${mkErr.code}.`,
      };
    }
  }

  // Existing and writable is not the same as writable by this process.
  try {
    await access(target, constants.W_OK | constants.X_OK);
  } catch {
    return {
      ok: false,
      error:
        `Tinpost cannot write to ${target}. If it was created by another user — for ` +
        'instance while running under sudo — take ownership of it first.',
    };
  }

  // access() can still be optimistic on some filesystems; a real write is the proof.
  const probe = join(target, `.tinpost-write-probe-${process.pid}`);
  try {
    await writeFile(probe, 'probe');
    await rm(probe, { force: true });
  } catch (err) {
    return { ok: false, error: `Tinpost cannot write to ${target} (${err.code}).` };
  }

  const occupied = await hasExistingData(target);
  return { ok: true, path: target, created: !existed, occupied };
}

/** Whether a directory already holds a Tinpost database, so the operator is not surprised. */
export async function hasExistingData(dir) {
  try {
    const s = await stat(join(dir, 'tinpost.db'));
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

/**
 * What to tell the operator about a pending move.
 *
 * Tinpost does not copy anything: a data directory can be large, a half-finished copy
 * is worse than none, and the operator may well be pointing at data that already
 * exists. So it says plainly what will happen and leaves the moving to them.
 */
export function moveNotice({ current, pending, occupied }) {
  if (!pending || pending === current) return null;
  return {
    pending,
    current,
    occupied,
    detail: occupied
      ? 'That directory already contains a Tinpost database, and it will be used as it is.'
      : 'That directory is empty, so Tinpost will start with no mail in it. Nothing is copied or deleted — the current data stays where it is.',
  };
}
