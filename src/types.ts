/** A non-empty, readonly array. */
export type NonEmptyArray<T> = readonly [T, ...T[]];

/**
 * Property-list values this package can render: strings, safe integers,
 * booleans, arrays, and dictionaries. XML property lists also define
 * `<real>`, `<date>`, and `<data>`, but no public launchd key needs them,
 * so they are intentionally unsupported; non-integer numbers are rejected
 * at validation time.
 */
export type PlistValue =
  | string
  | number
  | boolean
  | readonly PlistValue[]
  | PlistDictionary;

/** A string-keyed dictionary of property-list values. */
export interface PlistDictionary {
  /** A property-list key and its serializable value. */
  readonly [key: string]: PlistValue;
}

/** Resource policy classifications understood by launchd. */
export type ProcessType = "Background" | "Standard" | "Adaptive" | "Interactive";

/** Login session types to which an agent may be restricted. */
export type SessionType =
  | "Aqua"
  | "Background"
  | "LoginWindow"
  | "StandardIO"
  | "System";

/** One launchd calendar rule. Omitted fields act as wildcards. */
export interface CalendarInterval {
  /** Minute of the hour, from 0 through 59. */
  readonly minute?: number;
  /** Hour of the day, from 0 through 23. */
  readonly hour?: number;
  /** Day of the month, from 1 through 31. */
  readonly day?: number;
  /** 0 and 7 are Sunday. */
  readonly weekday?: number;
  /** Month of the year, from 1 through 12. */
  readonly month?: number;
}

/** Conditions launchd ORs together to determine whether a job stays alive. */
export interface KeepAliveConditions {
  /** Keep the job alive after a successful or unsuccessful exit. */
  readonly successfulExit?: boolean;
  /** Keep the job alive after a crash, or after a non-crash when false. */
  readonly crashed?: boolean;
  /** Map absolute paths to the existence state that keeps the job alive. */
  readonly pathState?: Readonly<Record<string, boolean>>;
  /**
   * Map other service labels to the loaded state that keeps this job alive.
   * launchd evaluates whether the other job is loaded, not whether it is
   * running or `enable`d. Apple discourages this key.
   */
  readonly otherJobEnabled?: Readonly<Record<string, boolean>>;
}

/** Soft or hard per-process resource limits. */
export interface ResourceLimits {
  /** Maximum core-file size in bytes. */
  readonly core?: number;
  /** Maximum CPU time in seconds. */
  readonly cpu?: number;
  /** Maximum data-segment size in bytes. */
  readonly data?: number;
  /** Maximum created file size in bytes. */
  readonly fileSize?: number;
  /** Maximum locked-memory size in bytes. */
  readonly memoryLock?: number;
  /** Maximum number of open files. */
  readonly numberOfFiles?: number;
  /** Maximum number of simultaneous processes. */
  readonly numberOfProcesses?: number;
  /** Maximum resident-set size in bytes. */
  readonly residentSetSize?: number;
  /** Maximum stack size in bytes. */
  readonly stack?: number;
}

/** Options for a Mach service advertised by an agent. */
export interface MachServiceOptions {
  /**
   * Destroy and atomically recreate the port when the service releases its
   * receive right, sending clients port-death notifications. By default the
   * port is recycled instead. Not compatible with XPC; use with care.
   */
  readonly resetAtClose?: boolean;
  /** Hide the service name until the job checks in. */
  readonly hideUntilCheckIn?: boolean;
}

/** A Mach service declaration or its detailed options. */
export type MachService = true | MachServiceOptions;

/** Shared fields in a LaunchAgent definition. */
export interface LaunchAgentOptions {
  /** A stable, reverse-DNS-style identifier, such as `dev.example.indexer`. */
  readonly label: string;
  /** Launch once when the definition is loaded. */
  readonly runAtLoad?: boolean;
  /** Keep the job alive unconditionally or under selected conditions. */
  readonly keepAlive?: boolean | KeepAliveConditions;
  /** Mark the job disabled by default; persistent launchctl state can override it. */
  readonly disabled?: boolean;
  /** Absolute working directory selected before the process starts. */
  readonly workingDirectory?: string;
  /**
   * String-valued environment variables added to the process environment.
   * Rendered plists are world-readable (mode 0644) and loaded values are
   * visible to `launchctl print`; do not put secrets here.
   */
  readonly environment?: Readonly<Record<string, string>>;
  /** Absolute path connected to standard input. */
  readonly standardInPath?: string;
  /** Absolute path receiving standard output. */
  readonly standardOutPath?: string;
  /** Absolute path receiving standard error. */
  readonly standardErrorPath?: string;
  /** Absolute paths whose changes may start the job. */
  readonly watchPaths?: readonly string[];
  /** Absolute directories whose non-empty state keeps the job alive. */
  readonly queueDirectories?: readonly string[];
  /** Start the job when a filesystem is mounted. */
  readonly startOnMount?: boolean;
  /** Start the job every this many seconds. */
  readonly startInterval?: number;
  /** One or more calendar rules that start the job. */
  readonly startCalendarInterval?: CalendarInterval | readonly CalendarInterval[];
  /** High-level resource policy classification. */
  readonly processType?: ProcessType;
  /** Minimum seconds between launch attempts. */
  readonly throttleInterval?: number;
  /**
   * Seconds allowed for graceful termination before launchd sends SIGKILL.
   * launchd interprets 0 as infinity and warns that it can stall system
   * shutdown forever.
   */
  readonly exitTimeOut?: number;
  /** Process nice value from -20 through 20. */
  readonly nice?: number;
  /** File creation mask as decimal integer or an octal string such as `022`. */
  readonly umask?: number | string;
  /**
   * Historical flag asking launchd to glob program arguments.
   * @deprecated launchd has ignored EnableGlobbing since OS X 10.10;
   * arguments are never globbed on any macOS this package supports.
   */
  readonly enableGlobbing?: boolean;
  /** Let XPC transactions indicate whether the job is active. */
  readonly enableTransactions?: boolean;
  /** Allow reclamation under memory pressure when the job is inactive. */
  readonly enablePressuredExit?: boolean;
  /** Leave processes in the job's process group alive when the job exits. */
  readonly abandonProcessGroup?: boolean;
  /** Apply low-priority filesystem I/O policy. */
  readonly lowPriorityIO?: boolean;
  /** Apply low-priority I/O while the process is background-throttled. */
  readonly lowPriorityBackgroundIO?: boolean;
  /** Select whether dataless files should be materialized. */
  readonly materializeDatalessFiles?: boolean;
  /** Prevent the job from being launched more than once before reboot. */
  readonly launchOnlyOnce?: boolean;
  /** Spawn the job into a new security audit session. */
  readonly sessionCreate?: boolean;
  /**
   * Request legacy, less-coalesced timer behavior. May have no effect
   * unless `processType` is `"Interactive"`.
   */
  readonly legacyTimers?: boolean;
  /**
   * Restrict the agent to one or more login session types. In the `gui`
   * and `user` domains this package manages, only `Aqua` and `Background`
   * sessions are ordinarily present; `System` is the daemon context and
   * will not load as a per-user agent.
   */
  readonly sessionTypes?: SessionType | readonly SessionType[];
  /** Bundle identifiers associated with this job in Login Items settings. */
  readonly associatedBundleIdentifiers?: string | readonly string[];
  /** Soft resource limits applied by launchd. */
  readonly softResourceLimits?: ResourceLimits;
  /** Hard resource limits applied by launchd. */
  readonly hardResourceLimits?: ResourceLimits;
  /** Mach services registered in the bootstrap namespace. */
  readonly machServices?: Readonly<Record<string, MachService>>;
  /**
   * Escape hatch for launchd keys not modeled by this package. Managed keys may
   * not be overridden here.
   */
  readonly extra?: PlistDictionary;
}

/**
 * A per-user LaunchAgent definition. Either `program` or a non-empty
 * `programArguments` array is required.
 */
export type LaunchAgentConfig =
  & LaunchAgentOptions
  & (
    | {
      readonly program: string;
      readonly programArguments?: NonEmptyArray<string>;
    }
    | {
      readonly program?: undefined;
      readonly programArguments: NonEmptyArray<string>;
    }
  );

/** One actionable problem found while validating a definition. */
export interface ValidationIssue {
  /** Dot/bracket path to the invalid field. */
  readonly path: string;
  /** Human-readable constraint that was violated. */
  readonly message: string;
}

/** Captured result from an injected command process. */
export interface CommandResult {
  /** Process exit code. */
  readonly code: number;
  /** Decoded standard output. */
  readonly stdout: string;
  /** Decoded standard error. */
  readonly stderr: string;
}

/** Options passed to a command runner invocation. */
export interface CommandRunOptions {
  /** Aborts the running command, killing the spawned process. */
  readonly signal?: AbortSignal;
}

/** Injectable process boundary, primarily for tests and host integrations. */
export interface CommandRunner {
  /** Execute one binary with literal arguments and capture its result. */
  run(
    command: string,
    args: readonly string[],
    options?: CommandRunOptions,
  ): Promise<CommandResult>;
}

/** A command result annotated with the exact launchctl invocation. */
export interface LaunchctlResult extends CommandResult {
  /** Executable followed by its literal arguments. */
  readonly command: readonly string[];
}

/** Supported per-user launchd domain kinds. */
export type LaunchAgentDomain = "gui" | "user";

/** Construction options for a LaunchAgents manager. */
export interface LaunchAgentsOptions {
  /** Defaults to `$HOME/Library/LaunchAgents`. */
  readonly directory?: string;
  /** Defaults to `Deno.uid()`, which requires the `--allow-sys=uid` permission. */
  readonly uid?: number;
  /** `gui` is appropriate for ordinary per-login agents. */
  readonly domain?: LaunchAgentDomain;
  /** Defaults to `/bin/launchctl`. Scope `--allow-run` to this exact path. */
  readonly launchctlPath?: string;
  /** Abort launchctl invocations that run longer than this many milliseconds. */
  readonly timeoutMillis?: number;
  /** Optional process boundary used instead of spawning commands directly. */
  readonly runner?: CommandRunner;
}

/** Controls protection of an existing plist during writes. */
export interface WriteOptions {
  /** Existing, different plist files are protected unless this is true. */
  readonly overwrite?: boolean;
}

/** Outcome of an atomic plist write. */
export interface WriteResult {
  /** Absolute destination path. */
  readonly path: string;
  /** True when no file existed before this operation. */
  readonly created: boolean;
  /** True when new bytes were committed. */
  readonly changed: boolean;
}

/** Controls writing and launchctl behavior during installation. */
export interface InstallOptions extends WriteOptions {
  /** Bootstrap the service after writing it. Defaults to true. */
  readonly load?: boolean;
  /** Reload an already-loaded service when its plist changed. Defaults to true. */
  readonly reloadLoaded?: boolean;
}

/** Outcome of a plist installation and optional bootstrap. */
export interface InstallResult extends WriteResult {
  /** Undefined when `load` was false and launchctl was not consulted. */
  readonly wasLoaded?: boolean;
  /**
   * True when a service with this label is loaded. Undefined when `load` was
   * false and launchctl was not consulted. With `reloadLoaded: false`, a
   * loaded service may still be running the previous definition; that case
   * is detectable as `wasLoaded && changed`.
   */
  readonly loaded?: boolean;
}

/** Controls behavior when a plist is absent during removal. */
export interface RemoveOptions {
  /** Do not fail if the plist is already absent. Defaults to true. */
  readonly ignoreMissing?: boolean;
}

/** Controls behavior while uninstalling an agent. */
export interface UninstallOptions extends RemoveOptions {
  /**
   * Also clear launchctl's persistent disabled state for the label.
   * Without this, a `disable()`d label stays disabled after uninstall and
   * a future install of the same label cannot bootstrap. Defaults to false.
   */
  readonly resetDisabled?: boolean;
}

/** Outcome of booting out and removing an agent. */
export interface UninstallResult {
  /** Absolute plist path. */
  readonly path: string;
  /** Whether the service resolved before uninstalling. */
  readonly wasLoaded: boolean;
  /** Whether a plist file was removed. */
  readonly removed: boolean;
}
