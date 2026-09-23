# Versioning and releases

Tinpost follows [Semantic Versioning](https://semver.org): `MAJOR.MINOR.PATCH`.
It is in the `0.x` series and stays there until Christos says it is 1.0. The current
version is whatever `package.json` says — it is not restated here, because a number
written in two places is a number that goes stale in one of them.

## What each number means

**MAJOR — `0.x` → `1.0.0`. By explicit decision only.**
Going to 1.0 is a promise, not a milestone: it says the SMTP behaviour, the stored
data layout, the CLI flags and the data directory are stable, and that none of them
will change again without a migration path and a major bump. Nothing else triggers
it. After 1.0, a major bump means a break that an existing lab would notice — a
renamed flag, a moved data directory, a schema change that old data cannot be read
through.

**MINOR — `0.1.0` → `0.2.0`. A capability that was not there before.**
Something the operator can now do: a new view, a new admin control, a new protocol
feature, a new way of getting mail in or out. Reset PATCH to 0.

While in `0.x`, a breaking change also goes here rather than in MAJOR — SemVer allows
this before 1.0, and it is what keeps the road to 1.0 open. Any release that breaks
something **must say so as the first line of its changelog entry**, and say what to
do about it. After 1.0 this exemption ends.

**PATCH — `0.1.0` → `0.1.1`. Everything else.**
Fixes, wording, performance, dependencies, tests, refactoring. No new capability and
nothing an operator has to react to.

## Deciding which one

Ask what the release means for someone running a lab:

| The release… | Bump |
|---|---|
| lets them do something they could not do before | MINOR |
| makes something work that was meant to work already | PATCH |
| requires them to change a command, a config or their data | MINOR (with a warning, while in `0.x`) |
| changes nothing they can observe | PATCH |
| declares the interfaces stable | MAJOR — only on Christos's word |

When a release contains both a new capability and fixes, it is a MINOR. When in
doubt between MINOR and PATCH, choose MINOR: overstating a change costs nothing,
understating one surprises people.

## Cutting a release

`package.json` is the single source of truth for the version. The steps:

1. `npm test` — every test passes. A release is never cut on a red suite.
2. `npm version <major|minor|patch> --no-git-tag-version` — bumps `package.json`.
3. Add the entry to `CHANGELOG.md`, newest first, dated, in plain language.
4. Commit: `Release vX.Y.Z`.
5. Tag: `git tag -a vX.Y.Z -m "vX.Y.Z"`.
6. `git push && git push --tags`.

Steps 1–6 are one motion. A version bump without a changelog entry and a tag is not a
release, and a tag that is not on `main` does not exist.

## Writing the changelog

`CHANGELOG.md` is for the person running Tinpost, not for whoever wrote the code.
It says what changed for them and, when something was broken, what it looked like
from their side. Every entry begins **New**, **Changed**, **Fixed** or **Removed**.

Write "the inbox now updates on its own as mail arrives", not "added an SSE
endpoint". Name the symptom a fix addresses — someone should be able to recognise
the problem they hit. Skip refactors and dependency bumps that change nothing
observable; they belong in the git history, not here.
