/**
 * A fluent, immutable builder for LaunchAgent definitions — and a guided tour
 * of what launchd can do for a per-user job.
 *
 * A LaunchAgent is a per-user program managed by launchd, defined by a plist
 * in `~/Library/LaunchAgents` and loaded into the user's `gui/<uid>` domain at
 * login. launchd replaces cron jobs, login items, and hand-rolled daemons with
 * one declarative model:
 *
 * - **Launch triggers** — start on load ({@linkcode LaunchAgentBuilder.runAtLoad}),
 *   on a calendar schedule ({@linkcode LaunchAgentBuilder.startCalendarInterval},
 *   {@linkcode LaunchAgentBuilder.daily}, {@linkcode LaunchAgentBuilder.weekly}),
 *   every N seconds ({@linkcode LaunchAgentBuilder.startInterval}), when watched
 *   paths change ({@linkcode LaunchAgentBuilder.watchPaths}), while a work-queue
 *   directory is non-empty ({@linkcode LaunchAgentBuilder.queueDirectories}),
 *   when a filesystem mounts ({@linkcode LaunchAgentBuilder.startOnMount}), or
 *   on demand when a client messages a registered Mach service
 *   ({@linkcode LaunchAgentBuilder.machServices}) — Apple's preferred trigger.
 * - **Lifecycle** — keep the job alive unconditionally or by condition
 *   ({@linkcode LaunchAgentBuilder.keepAlive}), space out respawns
 *   ({@linkcode LaunchAgentBuilder.throttleInterval}), bound graceful shutdown
 *   ({@linkcode LaunchAgentBuilder.exitTimeOut}), or make idle exit safe with
 *   XPC transactions ({@linkcode LaunchAgentBuilder.enableTransactions},
 *   {@linkcode LaunchAgentBuilder.enablePressuredExit}).
 * - **Execution environment** — argv with no shell in the picture
 *   ({@linkcode LaunchAgentBuilder.programArguments}), working directory,
 *   environment variables, umask, and stdio redirection to files
 *   ({@linkcode LaunchAgentBuilder.logsTo}).
 * - **Resource policy** — coarse classification the system throttles by
 *   ({@linkcode LaunchAgentBuilder.processType}), plus fine-grained nice,
 *   rlimits, and low-priority I/O knobs.
 *
 * launchd expects agents to cooperate: never daemonize (no `fork` + parent
 * exit), handle SIGTERM by winding down quickly, and prefer on-demand launches
 * over always-running processes.
 *
 * Builder contract, stated once: field-named methods replace the whole field;
 * `add*` methods accumulate; the shorthands (`every`, `daily`, `weekly`,
 * `logsTo`) desugar onto those same fields. Every method returns a new frozen
 * builder, so a partial builder is a reusable template. The builder performs
 * no validation of its own: `build()` assembles a plain definition object and
 * delegates every rule to `validateLaunchAgent`, the package's single source
 * of validation truth. A phantom type parameter makes `build()` a compile
 * error until `program()` or `programArguments()` has been provided; the
 * validator remains the runtime authority when that compile-time gate is
 * defeated with a cast.
 */
import { validateLaunchAgent } from "./plist.ts";
import type {
  CalendarInterval,
  KeepAliveConditions,
  LaunchAgentConfig,
  LaunchAgentOptions,
  MachService,
  NonEmptyArray,
  PlistDictionary,
  PlistValue,
  ProcessType,
  ResourceLimits,
  SessionType,
} from "./types.ts";

/** Compile-time phase of a builder: whether a program has been provided. */
export type LaunchAgentBuilderState = "needs-program" | "has-program";

declare const state: unique symbol;

type Draft =
  & { -readonly [K in keyof LaunchAgentOptions]?: LaunchAgentOptions[K] }
  & { program?: string; programArguments?: NonEmptyArray<string> };

let construct!: (draft: Draft) => LaunchAgentBuilder<LaunchAgentBuilderState>;

/**
 * Assembles a LaunchAgent definition incrementally. Instances are immutable
 * and frozen; obtain one from `launchAgent()` or `LaunchAgentBuilder.from()`.
 */
export class LaunchAgentBuilder<
  S extends LaunchAgentBuilderState = LaunchAgentBuilderState,
> {
  /** Phantom compile-time state; never present at runtime. */
  declare readonly [state]: S;
  readonly #draft: Draft;

  private constructor(draft: Draft) {
    this.#draft = Object.freeze(draft);
    Object.freeze(this);
  }

  static {
    construct = (draft) => new LaunchAgentBuilder(draft);
  }

  /**
   * Seed a builder from an existing definition; validation waits for build().
   *
   * @example Adjust an existing definition
   * ```ts
   * import { assertEquals } from "@std/assert";
   *
   * const existing = { label: "dev.example.worker", program: "/usr/local/bin/worker" };
   * const tuned = LaunchAgentBuilder.from(existing).keepAlive({ crashed: true }).build();
   * assertEquals(tuned.keepAlive, { crashed: true });
   * assertEquals(tuned.label, "dev.example.worker");
   * ```
   */
  static from(config: LaunchAgentConfig): LaunchAgentBuilder<"has-program"> {
    return new LaunchAgentBuilder({ ...config }) as LaunchAgentBuilder<"has-program">;
  }

  #derive<T extends LaunchAgentBuilderState>(patch: Partial<Draft>): LaunchAgentBuilder<T> {
    return new LaunchAgentBuilder({ ...this.#draft, ...patch }) as LaunchAgentBuilder<T>;
  }

  /**
   * Derive a builder identical except for its label — the template
   * affordance. The label is the job's unique identity within its launchd
   * domain and, by convention, the plist filename (`<label>.plist`); use a
   * stable reverse-DNS name such as `dev.example.indexer`.
   *
   * @example Specialize one shared template per agent
   * ```ts
   * import { assertEquals } from "@std/assert";
   *
   * const nightly = launchAgent("dev.example.nightly").daily(2, 30).processType("Background");
   * const photos = nightly.relabel("dev.example.photos").program("/usr/local/bin/backup-photos");
   * const music = nightly.relabel("dev.example.music").program("/usr/local/bin/backup-music");
   * assertEquals(photos.build().label, "dev.example.photos");
   * assertEquals(music.build().startCalendarInterval, { hour: 2, minute: 30 });
   * ```
   */
  relabel(label: string): LaunchAgentBuilder<S> {
    return this.#derive<S>({ label });
  }

  /**
   * Set the absolute path of the executable launchd hands to execv(3). No
   * shell is ever involved. When `programArguments` is also set, this names
   * the binary while the argument array supplies the full argv (argv[0]
   * included). Unlocks build().
   */
  program(path: string): LaunchAgentBuilder<"has-program"> {
    return this.#derive<"has-program">({ program: path });
  }

  /**
   * Replace the complete argv, argv[0] included, passed to the job with
   * execvp(3) semantics. launchd expands nothing: `~`, `$VARIABLES`, globs,
   * pipes, and redirections are all passed through as literal text. When
   * `program` is absent, argv[0] names the binary (a relative value resolves
   * against the standard system path, not the user's PATH). Unlocks build().
   */
  programArguments(argv: NonEmptyArray<string>): LaunchAgentBuilder<"has-program"> {
    return this.#derive<"has-program">({
      programArguments: Object.freeze([...argv]) as NonEmptyArray<string>,
    });
  }

  /**
   * Append program arguments in call order. When only `program()` was called,
   * the argv is first initialized to `[program]`, mirroring launchd's implicit
   * argv — so a later `program()` change leaves a stale argv[0] behind.
   *
   * @example Accumulate argv across calls
   * ```ts
   * import { assertEquals } from "@std/assert";
   *
   * const agent = launchAgent("dev.example.sync")
   *   .program("/usr/bin/rsync")
   *   .addArguments("-a", "--delete")
   *   .addArguments("/Users/me/Documents/", "/Volumes/Backup/")
   *   .build();
   * assertEquals(agent.programArguments, [
   *   "/usr/bin/rsync", // initialized from program()
   *   "-a",
   *   "--delete",
   *   "/Users/me/Documents/",
   *   "/Volumes/Backup/",
   * ]);
   * ```
   */
  addArguments(
    this: LaunchAgentBuilder<"has-program">,
    ...args: NonEmptyArray<string>
  ): LaunchAgentBuilder<"has-program"> {
    const base = this.#draft.programArguments ??
      (this.#draft.program === undefined ? [] : [this.#draft.program]);
    return this.#derive<"has-program">({
      programArguments: Object.freeze([...base, ...args]) as NonEmptyArray<string>,
    });
  }

  /**
   * Launch the job once at the moment it is loaded into the domain — for a
   * LaunchAgent, at login. Defaults to false. Apple discourages it: every
   * speculative launch slows boot and login, and most jobs can wait for a
   * demand trigger (Mach service, schedule, or watched path) instead.
   */
  runAtLoad(value = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({ runAtLoad: value });
  }

  /**
   * Control whether launchd keeps the job running rather than launching it
   * purely on demand. `true` restarts the job whenever it exits — a
   * permanent service. A conditions dictionary restarts it selectively,
   * with the conditions ORed together: `successfulExit` (restart while
   * exits are clean, or unclean when false), `crashed` (restart after
   * crash signals such as SIGSEGV), `pathState` (alive while filesystem
   * paths exist, or while absent), and `otherJobEnabled` (alive while
   * another label is loaded — discouraged; coordinate over IPC instead).
   * Any keep-alive implies `runAtLoad`, and jobs that exit quickly and
   * repeatedly are throttled per `throttleInterval`. Conditions are never
   * merged across calls; the whole policy is replaced.
   */
  keepAlive(value: boolean | KeepAliveConditions = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({
      keepAlive: typeof value === "boolean" ? value : Object.freeze({ ...value }),
    });
  }

  /**
   * Hint that the job should not be loaded by default. The persistent
   * `launchctl enable`/`disable` state overrides this key and lives outside
   * the plist, so a disabled label stays disabled across rewrites of the
   * file (and across reboots) until explicitly re-enabled.
   */
  disabled(value = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({ disabled: value });
  }

  /** Absolute directory launchd chdir(2)s to before running the job. */
  workingDirectory(path: string): LaunchAgentBuilder<S> {
    return this.#derive<S>({ workingDirectory: path });
  }

  /**
   * Replace the extra environment variables set before the job runs; use
   * addEnvironment() to merge instead. A launchd job does not inherit a
   * login shell's environment — no shell rc files, no user PATH — so
   * anything the program needs must be declared here or read by the job
   * itself. Rendered plists are world-readable; never put secrets in the
   * environment.
   */
  environment(variables: Readonly<Record<string, string>>): LaunchAgentBuilder<S> {
    return this.#derive<S>({ environment: Object.freeze({ ...variables }) });
  }

  /** Merge environment variables; a repeated variable name takes the later value. */
  addEnvironment(name: string, value: string): LaunchAgentBuilder<S>;
  addEnvironment(variables: Readonly<Record<string, string>>): LaunchAgentBuilder<S>;
  addEnvironment(
    nameOrVariables: string | Readonly<Record<string, string>>,
    value = "",
  ): LaunchAgentBuilder<S> {
    const additions = typeof nameOrVariables === "string"
      ? { [nameOrVariables]: value }
      : nameOrVariables;
    return this.#derive<S>({
      environment: Object.freeze({ ...this.#draft.environment, ...additions }),
    });
  }

  /**
   * Absolute file mapped to the job's stdin. If the file does not exist the
   * job simply receives no input.
   */
  standardInPath(path: string): LaunchAgentBuilder<S> {
    return this.#derive<S>({ standardInPath: path });
  }

  /**
   * Absolute file that receives the job's stdout. launchd creates the
   * file if missing (with permissions honoring the umask key, when set);
   * in practice output accumulates forever and launchd never rotates it,
   * so long-running agents should manage their own log growth.
   */
  standardOutPath(path: string): LaunchAgentBuilder<S> {
    return this.#derive<S>({ standardOutPath: path });
  }

  /**
   * Absolute file that receives the job's stderr. Same creation and
   * accumulation behavior as standardOutPath(). Without it, stderr is
   * discarded — set one before debugging a misbehaving agent.
   */
  standardErrorPath(path: string): LaunchAgentBuilder<S> {
    return this.#derive<S>({ standardErrorPath: path });
  }

  /**
   * Set both log paths at once; standard error defaults to the same file.
   * The one method that touches two fields: standardOutPath and
   * standardErrorPath.
   */
  logsTo(standardOut: string, standardError: string = standardOut): LaunchAgentBuilder<S> {
    return this.#derive<S>({
      standardOutPath: standardOut,
      standardErrorPath: standardError,
    });
  }

  /**
   * Replace the list of absolute paths whose modification starts the job;
   * use addWatchPaths() to append. Apple warns that filesystem monitoring
   * is race-prone and lossy: changes can be missed, and the file may
   * still be mid-write when the job launches. launchd also does not tell
   * the job which path fired — it must inspect the world itself. Prefer
   * demand-based IPC where possible.
   */
  watchPaths(paths: readonly string[]): LaunchAgentBuilder<S> {
    return this.#derive<S>({ watchPaths: Object.freeze([...paths]) });
  }

  /** Append watch paths in call order; duplicates are kept verbatim. */
  addWatchPaths(...paths: NonEmptyArray<string>): LaunchAgentBuilder<S> {
    return this.#derive<S>({
      watchPaths: Object.freeze([...this.#draft.watchPaths ?? [], ...paths]),
    });
  }

  /**
   * Replace the list of directories that act as filesystem work queues;
   * use addQueueDirectories() to append. launchd keeps the job alive as
   * long as any listed directory is non-empty — the classic drop-folder
   * pattern: the job drains files as they appear and exits once every
   * queue is empty.
   */
  queueDirectories(directories: readonly string[]): LaunchAgentBuilder<S> {
    return this.#derive<S>({ queueDirectories: Object.freeze([...directories]) });
  }

  /** Append queue directories in call order; duplicates are kept verbatim. */
  addQueueDirectories(...directories: NonEmptyArray<string>): LaunchAgentBuilder<S> {
    return this.#derive<S>({
      queueDirectories: Object.freeze([...this.#draft.queueDirectories ?? [], ...directories]),
    });
  }

  /**
   * Start the job every time a filesystem is mounted — external drives,
   * disk images, network shares. There is no per-volume filter; the job
   * decides for itself whether the new mount is interesting.
   */
  startOnMount(value = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({ startOnMount: value });
  }

  /**
   * Start the job every N seconds. Two caveats distinguish this from a
   * wall-clock schedule: a firing that occurs while the Mac sleeps is
   * missed entirely (not queued for wake), and a firing that occurs while
   * the previous run is still executing is skipped. For calendar-time jobs
   * that should catch up after sleep, use startCalendarInterval() instead;
   * the two trigger types are evaluated independently.
   */
  startInterval(seconds: number): LaunchAgentBuilder<S> {
    return this.#derive<S>({ startInterval: seconds });
  }

  /** Shorthand for startInterval(): start the job every this many seconds. */
  every(seconds: number): LaunchAgentBuilder<S> {
    return this.startInterval(seconds);
  }

  /**
   * Replace the cron-like calendar rule(s); use addCalendarIntervals(),
   * daily(), or weekly() to append. Every omitted field is a wildcard — an
   * omitted minute fires sixty times across the matching hour. When both
   * day and weekday are set, the rule fires when EITHER matches, exactly
   * as in crontab. Unlike cron, launchd catches up after sleep: intervals
   * that pass while the machine sleeps fire once on wake, with multiple
   * missed intervals coalesced into a single launch.
   */
  startCalendarInterval(
    value: CalendarInterval | readonly CalendarInterval[],
  ): LaunchAgentBuilder<S> {
    const stored = Array.isArray(value)
      ? Object.freeze(value.map((interval) => Object.freeze({ ...interval })))
      : Object.freeze({ ...value });
    return this.#derive<S>({ startCalendarInterval: stored });
  }

  #appendCalendar(intervals: readonly CalendarInterval[]): LaunchAgentBuilder<S> {
    const existing = this.#draft.startCalendarInterval;
    const current = existing === undefined
      ? []
      : Array.isArray(existing)
      ? existing
      : [existing as CalendarInterval];
    const merged = [...current, ...intervals.map((interval) => Object.freeze({ ...interval }))];
    return this.#derive<S>({
      startCalendarInterval: merged.length === 1 ? merged[0] : Object.freeze(merged),
    });
  }

  /** Append calendar rules in call order; values pass through unfiltered. */
  addCalendarIntervals(...intervals: NonEmptyArray<CalendarInterval>): LaunchAgentBuilder<S> {
    return this.#appendCalendar(intervals);
  }

  /**
   * Append one daily rule at the given hour. The minute defaults to 0
   * explicitly, because an omitted minute is a launchd wildcard that fires
   * sixty times in the hour.
   *
   * @example daily() and weekly() append calendar rules
   * ```ts
   * import { assertEquals } from "@std/assert";
   *
   * const digest = launchAgent("dev.example.digest")
   *   .program("/usr/local/bin/digest")
   *   .daily(7)
   *   .weekly([1, 5], 9, 30)
   *   .build();
   * assertEquals(digest.startCalendarInterval, [
   *   { hour: 7, minute: 0 },
   *   { weekday: 1, hour: 9, minute: 30 },
   *   { weekday: 5, hour: 9, minute: 30 },
   * ]);
   * ```
   */
  daily(hour: number, minute = 0): LaunchAgentBuilder<S> {
    return this.#appendCalendar([{ hour, minute }]);
  }

  /**
   * Append one weekly rule per weekday at the given time. 0 and 7 are Sunday;
   * the minute defaults to 0 explicitly (see daily()).
   */
  weekly(
    weekday: number | readonly number[],
    hour: number,
    minute = 0,
  ): LaunchAgentBuilder<S> {
    const weekdays = typeof weekday === "number" ? [weekday] : weekday;
    return this.#appendCalendar(weekdays.map((day) => ({ weekday: day, hour, minute })));
  }

  /**
   * Tell the system what kind of job this is so it can throttle
   * appropriately — Apple prefers this over hand-tuning nice() and
   * rlimits. Left unset, the system applies light resource limits,
   * throttling CPU and I/O; "Standard" is defined as equivalent to
   * leaving it unset. "Background" is throttled so the job cannot
   * disrupt the user experience. "Adaptive" shifts between Background
   * and Interactive as XPC transaction activity rises and falls.
   * "Interactive" is app-like and unthrottled — reserve it for jobs the
   * user is actively waiting on.
   */
  processType(type: ProcessType): LaunchAgentBuilder<S> {
    return this.#derive<S>({ processType: type });
  }

  /**
   * Minimum seconds between launches of this job (default 10). launchd's
   * philosophy is that jobs should linger for their next request rather
   * than churn: a job respawning faster than this interval is delayed, and
   * with keepAlive that manifests as visible restart backoff.
   */
  throttleInterval(seconds: number): LaunchAgentBuilder<S> {
    return this.#derive<S>({ throttleInterval: seconds });
  }

  /**
   * Seconds launchd waits between SIGTERM and SIGKILL when stopping the
   * job; the default is system-defined. launchd interprets 0 as infinity
   * and warns against it — an unkillable job can stall system shutdown
   * forever.
   */
  exitTimeOut(seconds: number): LaunchAgentBuilder<S> {
    return this.#derive<S>({ exitTimeOut: seconds });
  }

  /**
   * nice(3) scheduling priority for the job. Prefer processType(), which
   * lets the system manage priority holistically.
   */
  nice(value: number): LaunchAgentBuilder<S> {
    return this.#derive<S>({ nice: value });
  }

  /**
   * umask(2) applied before the job runs, shaping the permissions of every
   * file it creates (including launchd-created log files). Plist integers
   * cannot be written in octal, so the number form is the literal value
   * (18 == octal 022); the string form is parsed per strtoul(3), where a
   * leading "0" means octal — "022" is the familiar spelling.
   */
  umask(mask: number | string): LaunchAgentBuilder<S> {
    return this.#derive<S>({ umask: mask });
  }

  /**
   * Historical flag asking launchd to glob(3) program arguments.
   * @deprecated launchd has ignored EnableGlobbing since OS X 10.10;
   * arguments are always passed literally.
   */
  enableGlobbing(value = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({ enableGlobbing: value });
  }

  /**
   * Declare that the job tracks its busy state with XPC transactions
   * (xpc_transaction_begin/end). launchd then knows the difference between
   * active and idle: stopping an active process sends SIGTERM with a grace
   * period, while an idle one is killed immediately and safely. This is
   * the foundation of clean idle-exit behavior for on-demand services.
   */
  enableTransactions(value = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({ enableTransactions: value });
  }

  /**
   * Opt into Pressured Exit: when the job is idle (no open XPC
   * transactions), the system may reclaim it under memory pressure, and it
   * is relaunched automatically if it exits or crashes while holding open
   * transactions. Implies enableTransactions. launchd ignores this for
   * jobs with keepAlive true, and opted-in jobs ignore SIGTERM by default —
   * handle that signal with a dispatch source.
   */
  enablePressuredExit(value = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({ enablePressuredExit: value });
  }

  /**
   * When a job exits, launchd normally kills every remaining process in
   * the job's process group — stray children do not outlive the job. Set
   * true to disable that cleanup, for jobs that intentionally leave
   * long-lived children behind.
   */
  abandonProcessGroup(value = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({ abandonProcessGroup: value });
  }

  /** Ask the kernel to treat the job's filesystem I/O as low priority. */
  lowPriorityIO(value = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({ lowPriorityIO: value });
  }

  /**
   * Apply low-priority filesystem I/O only while the process is throttled
   * with the Darwin background classification.
   */
  lowPriorityBackgroundIO(value = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({ lowPriorityBackgroundIO: value });
  }

  /**
   * Choose whether reading dataless files (cloud-evicted placeholders, as
   * created by iCloud Drive and similar) triggers their download. True
   * materializes them; false does not; unset defers to the system policy.
   * A backup or indexing agent usually wants an explicit decision here.
   */
  materializeDatalessFiles(value = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({ materializeDatalessFiles: value });
  }

  /**
   * Declare that the job can run at most once per boot — for programs that
   * cannot be safely respawned without a full reboot.
   */
  launchOnlyOnce(value = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({ launchOnlyOnce: value });
  }

  /**
   * Spawn the job into a new security audit session (see auditon(2))
   * instead of the default session of the context it belongs to.
   */
  sessionCreate(value = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({ sessionCreate: value });
  }

  /**
   * Opt the job's timers out of coalescing. Since OS X 10.9 the system
   * batches timers with similar deadlines to save energy; this requests
   * precise, uncoalesced firing instead. May have no effect unless
   * processType is "Interactive".
   */
  legacyTimers(value = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({ legacyTimers: value });
  }

  /**
   * Restrict which login-session types load the agent, keeping the scalar
   * or array form given. Modern launchctl documents three: "Aqua", the
   * ordinary GUI login session and the default for agents; "Background",
   * per-user contexts that do not require the GUI; and "LoginWindow", the
   * pre-login login-window context. Two more survive from older releases:
   * "StandardIO" (non-GUI sessions such as SSH logins) and "System" (the
   * daemon context, not loadable through this package's per-user domains).
   */
  sessionTypes(types: SessionType | readonly SessionType[]): LaunchAgentBuilder<S> {
    return this.#derive<S>({
      sessionTypes: typeof types === "string" ? types : Object.freeze([...types]),
    });
  }

  /**
   * Associate the agent with one or more app bundle identifiers so the
   * System Settings Login Items UI attributes it to the app by name
   * instead of showing a bare label. Keeps the scalar or array form given.
   */
  associatedBundleIdentifiers(
    identifiers: string | readonly string[],
  ): LaunchAgentBuilder<S> {
    return this.#derive<S>({
      associatedBundleIdentifiers: typeof identifiers === "string"
        ? identifiers
        : Object.freeze([...identifiers]),
    });
  }

  /**
   * Replace the soft setrlimit(2) caps for the job. Byte-count keys:
   * core, data, fileSize, memoryLock, residentSetSize, and stack. The
   * rest: cpu is CPU seconds; numberOfFiles and numberOfProcesses (per
   * UID) are counts. For general throttling prefer processType(); rlimits
   * are the precision tool.
   */
  softResourceLimits(limits: ResourceLimits): LaunchAgentBuilder<S> {
    return this.#derive<S>({ softResourceLimits: Object.freeze({ ...limits }) });
  }

  /** Replace the hard setrlimit(2) caps; same keys as softResourceLimits(). */
  hardResourceLimits(limits: ResourceLimits): LaunchAgentBuilder<S> {
    return this.#derive<S>({ hardResourceLimits: Object.freeze({ ...limits }) });
  }

  /**
   * Replace the Mach services registered for the job in the user's
   * bootstrap namespace; use addMachService() to merge. This is launchd's
   * on-demand IPC trigger and Apple's preferred way to run a job: the name
   * is registered immediately, and the first client message to it launches
   * the job, which must then check in for the service (typically via
   * xpc_connection_create_mach_service). Per-service options: resetAtClose
   * destroys and atomically recreates the port with port-death
   * notifications when the job releases its receive right (incompatible
   * with XPC); hideUntilCheckIn reserves the name but fails lookups until
   * the job has checked in (discouraged — it encourages polling).
   */
  machServices(services: Readonly<Record<string, MachService>>): LaunchAgentBuilder<S> {
    return this.#derive<S>({ machServices: Object.freeze({ ...services }) });
  }

  /**
   * Merge one Mach service; a repeated name replaces that entry wholesale.
   * Omitting the options stores the `true` shorthand — an ordinary
   * demand-launched service registration.
   */
  addMachService(name: string, service: MachService = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({
      machServices: Object.freeze({ ...this.#draft.machServices, [name]: service }),
    });
  }

  /**
   * Replace the raw-plist escape hatch for launchd keys this package does
   * not model; use addExtra() to merge. The notable residents are Sockets
   * (launch-on-demand network sockets whose descriptors the job collects
   * at check-in) and LaunchEvents (higher-level event streams such as
   * IOKit device matching). Values are validated as plist values at
   * build(), and keys the package manages cannot be overridden here.
   */
  extra(dictionary: PlistDictionary): LaunchAgentBuilder<S> {
    return this.#derive<S>({ extra: Object.freeze({ ...dictionary }) });
  }

  /** Merge raw plist keys; a repeated top-level key takes the later value. */
  addExtra(values: Readonly<Record<string, PlistValue>>): LaunchAgentBuilder<S> {
    return this.#derive<S>({
      extra: Object.freeze({ ...this.#draft.extra, ...values }),
    });
  }

  /**
   * Assemble the definition and delegate every check to `validateLaunchAgent`,
   * throwing `LaunchAgentValidationError` with all issues on failure. Only
   * callable once `program()` or `programArguments()` has been provided.
   *
   * @example Every problem is reported in one throw
   * ```ts
   * import { assertStringIncludes, assertThrows } from "@std/assert";
   *
   * const error = assertThrows(
   *   () => launchAgent("dev.example.bad").program("relative/path").daily(26).build(),
   *   Error,
   * );
   * assertStringIncludes(error.message, "program: must be an absolute path");
   * assertStringIncludes(error.message, "startCalendarInterval.hour");
   * ```
   */
  build(this: LaunchAgentBuilder<"has-program">): LaunchAgentConfig {
    const config: unknown = { ...this.#draft };
    validateLaunchAgent(config);
    return config;
  }
}

/**
 * Start a fluent LaunchAgent definition for the given label. The finished
 * definition renders to `~/Library/LaunchAgents/<label>.plist` and loads
 * into the user's `gui/<uid>` domain.
 *
 * @example A polling agent, from label to validated definition
 * ```ts
 * import { assertEquals } from "@std/assert";
 *
 * const agent = launchAgent("dev.example.poller")
 *   .programArguments(["/opt/homebrew/bin/poll", "--once"])
 *   .every(300)
 *   .logsTo("/Users/me/Library/Logs/poller.log")
 *   .build();
 * assertEquals(agent.startInterval, 300);
 * assertEquals(agent.standardErrorPath, "/Users/me/Library/Logs/poller.log");
 * ```
 */
export function launchAgent(label: string): LaunchAgentBuilder<"needs-program"> {
  return construct({ label }) as LaunchAgentBuilder<"needs-program">;
}
