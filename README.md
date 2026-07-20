# @nullstyle/launch-agents

A small, dependency-free Deno package for defining and managing per-user macOS LaunchAgents.

It provides:

- typed, camel-cased LaunchAgent definitions;
- validation with all errors reported together;
- deterministic XML plist rendering;
- atomic writes to `~/Library/LaunchAgents`;
- modern `launchctl bootstrap`, `bootout`, `kickstart`, `enable`, and `disable` operations;
- rollback when replacing a loaded agent fails; and
- an injectable command boundary for tests.

The package intentionally does not manage privileged LaunchDaemons.

## Define and render an agent

```ts
import { defineLaunchAgent, renderLaunchAgent } from "./mod.ts";

const agent = defineLaunchAgent({
  label: "dev.example.daily-backup",
  program: "/usr/bin/rsync",
  // launchd does not invoke a shell. argv[0] is included explicitly.
  programArguments: [
    "/usr/bin/rsync",
    "-a",
    "/Users/me/Documents/",
    "/Volumes/Backup/Documents/",
  ],
  startCalendarInterval: { hour: 2, minute: 30 },
  processType: "Background",
  standardOutPath: "/Users/me/Library/Logs/daily-backup.log",
  standardErrorPath: "/Users/me/Library/Logs/daily-backup.error.log",
});

console.log(renderLaunchAgent(agent));
```

Rendering is pure and needs no Deno permissions.

## Build an agent fluently

`launchAgent()` starts an immutable builder: field-named methods replace the whole field, `add*`
methods accumulate, and the shorthands (`every`, `daily`, `weekly`, `logsTo`) desugar onto those
same fields. `build()` runs the exact same validation as `defineLaunchAgent`, reporting all problems
together, and only compiles once `program()` or `programArguments()` has been provided.

```ts
import { launchAgent, renderLaunchAgent } from "./mod.ts";

const agent = launchAgent("dev.example.daily-backup")
  // launchd does not invoke a shell. argv[0] is included explicitly.
  .programArguments([
    "/usr/bin/rsync",
    "-a",
    "/Users/me/Documents/",
    "/Volumes/Backup/Documents/",
  ])
  .daily(2, 30) // one startCalendarInterval rule; minute defaults to 0, never a wildcard
  .processType("Background")
  .lowPriorityIO()
  .logsTo("/Users/me/Library/Logs/daily-backup.log")
  .build();

console.log(renderLaunchAgent(agent));

// Builders are frozen values, so a partial builder is a reusable template:
// specialize a shared base per agent with relabel() and programArguments().
const nightly = launchAgent("dev.example.base").daily(2, 30).processType("Background");
const photos = nightly
  .relabel("dev.example.backup-photos")
  .programArguments(["/usr/bin/rsync", "-a", "/Users/me/Photos/", "/Volumes/Backup/Photos/"])
  .build();

console.log(photos.label);
```

## Install and control an agent

```ts
import { defineLaunchAgent, LaunchAgents } from "./mod.ts";

const agent = defineLaunchAgent({
  label: "dev.example.daily-backup",
  program: "/usr/bin/true",
});
const agents = new LaunchAgents();

await agents.install(agent); // write + bootstrap
await agents.restart(agent.label);

console.log(await agents.isLoaded(agent.label));
console.log(await agents.inspect(agent.label)); // intentionally raw diagnostic text

await agents.disable(agent.label); // persistent launchctl disabled state
await agents.enable(agent.label);
await agents.uninstall(agent.label, { resetDisabled: true }); // bootout + remove plist
```

Use narrowly scoped permissions:

```sh
deno run \
  --allow-env=HOME \
  --allow-sys=uid \
  --allow-read="$HOME/Library/LaunchAgents" \
  --allow-write="$HOME/Library/LaunchAgents" \
  --allow-run=/bin/launchctl \
  manage_agent.ts
```

If `directory` is passed to the constructor, reading `HOME` is unnecessary; if `uid` is passed,
`--allow-sys=uid` is unnecessary. Calling `write()` or using the renderer without lifecycle methods
does not need `--allow-run`.

## Updating safely

Existing, different files are protected by default; if you only want to stage a file without
touching launchctl, use `write()`:

```ts
import { defineLaunchAgent, LaunchAgents } from "./mod.ts";

const agent = defineLaunchAgent({
  label: "dev.example.daily-backup",
  program: "/usr/bin/true",
});
const agents = new LaunchAgents();

await agents.install(agent, { overwrite: true }); // write + reload
await agents.write(agent, { overwrite: true }); // stage the file only
```

When the service is already loaded, `install()` writes the new plist, boots out the old service, and
bootstraps the new definition. If that sequence fails, it attempts to restore both the previous file
and previous loaded service. Restoring the previous service re-runs it under its `runAtLoad` and
`keepAlive` rules, so one-shot jobs may execute again. When the previous plist cannot be restored —
or the replaced service was loaded from a different path — the rollback does not re-bootstrap, and
the reason is reported on `LaunchAgentOperationError.rollbackError`.

## Scheduling notes

- `startCalendarInterval` catches up once after sleep; multiple missed calendar events are
  coalesced.
- `startInterval` misses firings while the Mac sleeps or while the job is still running.
- `keepAlive` implies `RunAtLoad`; rapidly failing jobs are throttled by launchd.
- launchd does not expand `~`, `$VARIABLES`, globs, pipes, or redirections unless you deliberately
  run a shell. This package requires absolute paths where launchd expects them.
- agents remain subject to macOS privacy controls. A background agent may not receive the same
  protected-folder access as the terminal that installed it.
- plist files are written world-readable (mode `0644`), and loaded values are visible to
  `launchctl print`. Do not put secrets in `environment`; have the job read them from the keychain
  or a protected file instead.
- `launchctl disable` state survives uninstalling. Use `uninstall(label, { resetDisabled: true })`
  when a future install of the same label should be able to load.

## API outline

Pure functions:

- `defineLaunchAgent(config)` validates and preserves the inferred type.
- `validateLaunchAgent(config)` reports validation issues.
- `toLaunchdPlist(config)` returns a plist dictionary with Apple's key names.
- `renderLaunchAgent(config)` returns complete XML.
- `launchAgent(label)` starts an immutable fluent builder whose `build()` runs the same validation.

`LaunchAgents` methods:

- filesystem: `agentPath`, `write`, `remove`;
- loading: `bootstrap`, `bootout`, `install`, `uninstall`;
- runtime: `start`, `restart`, `stop`, `isLoaded`, `inspect`;
- persistent state: `enable`, `disable`.

See [DESIGN.md](./DESIGN.md) for scope and architectural decisions.

## Develop

```sh
deno task fmt:check # or `deno task fmt` to format
deno task lint
deno task check # type-checks code plus every JSDoc and README example
deno task test
deno task test:doc # runs the JSDoc examples as tests
deno task coverage
```

The package is named `@nullstyle/launch-agents` in `deno.json`. Before publishing to JSR, add your
chosen `version` and `license` fields; the repository does not guess a license.
