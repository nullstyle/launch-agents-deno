# Design

## Scope

This package manages user-owned LaunchAgents in a `gui/<uid>` domain by default. It may target
`user/<uid>` when explicitly configured. It does not elevate privileges or write to
`/Library/LaunchDaemons`.

The intended use cases are scheduled commands, long-running per-user helpers, path/queue-triggered
jobs, and Mach-service-backed user agents.

## Layers

1. **Definition and validation** accepts an idiomatic TypeScript object and catches unsafe
   filenames, missing programs, relative launchd paths, invalid calendar values, unsupported plist
   values, and managed-key collisions.
2. **Plist rendering** maps to Apple's exact key names and emits deterministic XML without a runtime
   dependency.
3. **Filesystem management** writes complete temporary files in the destination directory, applies
   mode `0644`, and atomically moves or links them into place.
4. **Lifecycle management** passes literal argument arrays to `/bin/launchctl`. It uses
   `bootstrap`/`bootout`, not deprecated `load`/`unload` operations.

The command runner is injectable. Tests can verify exact commands and failure paths without changing
the current user's launchd domain.

A fluent builder (`launchAgent`/`LaunchAgentBuilder`) sits on top of layer 1 as a pure, immutable
assembly convenience: it re-implements no validation rules, adds no plist semantics, and hands its
assembled definition to the same validator at `build()`. A phantom type parameter makes `build()` a
compile error until a program is provided; the validator remains the runtime authority.

## Important invariants

- A label is also a filename component, so it is restricted to a conservative set of characters and
  can never escape the configured directory.
- `Program` is absolute. Program arguments and environment values are never interpreted by a shell.
- Existing different files require explicit `overwrite: true`. Writing the same definition is
  idempotent.
- Replacing a loaded service is treated as a small transaction. If the new bootstrap fails, the
  manager restores the old plist and attempts to bootstrap it again. When the old plist cannot be
  restored — or the replaced service was not loaded from this file — the manager deliberately does
  not re-bootstrap, because that would load the wrong definition. Rollback failures and skipped
  restorations remain available on `LaunchAgentOperationError`.
- The `extra` escape hatch cannot replace any key modeled by the package.
- `launchctl print` is exposed only as raw diagnostic text. Apple explicitly does not treat its
  format as an API, so this package does not parse it into a brittle status object.

## Explicit non-goals

- privileged LaunchDaemons and sudo orchestration;
- shell command construction;
- parsing arbitrary existing binary or XML plists;
- promising that macOS privacy consent transfers from an installer process to the launched agent;
- modeling every private or obsolete launchd key.

Less common public launchd keys can be supplied through `extra` while retaining plist-value
validation.

## Error model

- `LaunchAgentValidationError` contains every discovered validation issue.
- `LaunchAgentFileExistsError` means an overwrite decision is required.
- `LaunchctlError` preserves the command, exit code, stdout, and stderr. It also covers launchctl
  output the package cannot use, such as an unparseable `kickstart -p` PID.
- `LaunchAgentOperationError` wraps a composite install/uninstall failure after the transaction has
  begun and separately exposes a rollback error — always an `AggregateError` when present — when
  recovery also failed or was impossible.
- Argument errors throw `TypeError`. Pre-flight failures before any state changes — an unreadable
  plist, a spawn failure from the loaded-state probe, or `Deno.errors.NotFound` from
  `uninstall(label, { ignoreMissing: false })` — are thrown as-is, not wrapped.

## Publishing

The package is named `@nullstyle/launch-agents` and is ready to import by path or URL. A license is
a user decision, so the checked-in `deno.json` leaves the `license` and `version` fields unset. Add
them before publication.
