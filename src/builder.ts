/**
 * A fluent, immutable builder for LaunchAgent definitions.
 *
 * State model, stated once: field-named methods replace the whole field;
 * `add*` methods accumulate; the scheduling and logging shorthands (`every`,
 * `daily`, `weekly`, `logsTo`) desugar onto those same fields. Every method
 * returns a new frozen builder, so a partial builder is a reusable template.
 *
 * The builder performs no validation of its own: `build()` assembles a plain
 * definition object and delegates every rule to `validateLaunchAgent`, the
 * package's single source of validation truth. A phantom type parameter makes
 * `build()` a compile error until `program()` or `programArguments()` has been
 * provided; the validator remains the runtime authority when that compile-time
 * gate is defeated with a cast.
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

  /** Seed a builder from an existing definition; validation waits for build(). */
  static from(config: LaunchAgentConfig): LaunchAgentBuilder<"has-program"> {
    return new LaunchAgentBuilder({ ...config }) as LaunchAgentBuilder<"has-program">;
  }

  #derive<T extends LaunchAgentBuilderState>(patch: Partial<Draft>): LaunchAgentBuilder<T> {
    return new LaunchAgentBuilder({ ...this.#draft, ...patch }) as LaunchAgentBuilder<T>;
  }

  /** Derive a builder identical except for its label; the template affordance. */
  relabel(label: string): LaunchAgentBuilder<S> {
    return this.#derive<S>({ label });
  }

  /** Set the absolute executable path. Unlocks build(). */
  program(path: string): LaunchAgentBuilder<"has-program"> {
    return this.#derive<"has-program">({ program: path });
  }

  /** Replace the complete argv, argv[0] included. Unlocks build(). */
  programArguments(argv: NonEmptyArray<string>): LaunchAgentBuilder<"has-program"> {
    return this.#derive<"has-program">({
      programArguments: Object.freeze([...argv]) as NonEmptyArray<string>,
    });
  }

  /**
   * Append program arguments in call order. When only `program()` was called,
   * the argv is first initialized to `[program]`, mirroring launchd's implicit
   * argv — so a later `program()` change leaves a stale argv[0] behind.
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

  /** Launch once when the definition is loaded. */
  runAtLoad(value = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({ runAtLoad: value });
  }

  /** Replace the keep-alive policy; conditions are never merged across calls. */
  keepAlive(value: boolean | KeepAliveConditions = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({
      keepAlive: typeof value === "boolean" ? value : Object.freeze({ ...value }),
    });
  }

  /** Mark the job disabled by default. */
  disabled(value = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({ disabled: value });
  }

  /** Set the absolute working directory. */
  workingDirectory(path: string): LaunchAgentBuilder<S> {
    return this.#derive<S>({ workingDirectory: path });
  }

  /**
   * Replace the whole environment dictionary; use addEnvironment() to merge.
   * Rendered plists are world-readable — do not put secrets here.
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

  /** Set the absolute path connected to standard input. */
  standardInPath(path: string): LaunchAgentBuilder<S> {
    return this.#derive<S>({ standardInPath: path });
  }

  /** Set the absolute path receiving standard output. */
  standardOutPath(path: string): LaunchAgentBuilder<S> {
    return this.#derive<S>({ standardOutPath: path });
  }

  /** Set the absolute path receiving standard error. */
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

  /** Replace the whole watch-path list; use addWatchPaths() to append. */
  watchPaths(paths: readonly string[]): LaunchAgentBuilder<S> {
    return this.#derive<S>({ watchPaths: Object.freeze([...paths]) });
  }

  /** Append watch paths in call order; duplicates are kept verbatim. */
  addWatchPaths(...paths: NonEmptyArray<string>): LaunchAgentBuilder<S> {
    return this.#derive<S>({
      watchPaths: Object.freeze([...this.#draft.watchPaths ?? [], ...paths]),
    });
  }

  /** Replace the whole queue-directory list; use addQueueDirectories() to append. */
  queueDirectories(directories: readonly string[]): LaunchAgentBuilder<S> {
    return this.#derive<S>({ queueDirectories: Object.freeze([...directories]) });
  }

  /** Append queue directories in call order; duplicates are kept verbatim. */
  addQueueDirectories(...directories: NonEmptyArray<string>): LaunchAgentBuilder<S> {
    return this.#derive<S>({
      queueDirectories: Object.freeze([...this.#draft.queueDirectories ?? [], ...directories]),
    });
  }

  /** Start the job when a filesystem is mounted. */
  startOnMount(value = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({ startOnMount: value });
  }

  /** Start the job every this many seconds. */
  startInterval(seconds: number): LaunchAgentBuilder<S> {
    return this.#derive<S>({ startInterval: seconds });
  }

  /** Shorthand for startInterval(): start the job every this many seconds. */
  every(seconds: number): LaunchAgentBuilder<S> {
    return this.startInterval(seconds);
  }

  /**
   * Replace the calendar rule(s); use addCalendarIntervals(), daily(), or
   * weekly() to append. An omitted field is a launchd wildcard — in
   * particular, an omitted minute fires once per minute for the whole hour.
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

  /** Set the resource policy classification. */
  processType(type: ProcessType): LaunchAgentBuilder<S> {
    return this.#derive<S>({ processType: type });
  }

  /** Set the minimum seconds between launch attempts. */
  throttleInterval(seconds: number): LaunchAgentBuilder<S> {
    return this.#derive<S>({ throttleInterval: seconds });
  }

  /**
   * Set the seconds allowed for graceful termination before SIGKILL.
   * launchd interprets 0 as infinity and warns against it.
   */
  exitTimeOut(seconds: number): LaunchAgentBuilder<S> {
    return this.#derive<S>({ exitTimeOut: seconds });
  }

  /** Set the process nice value. */
  nice(value: number): LaunchAgentBuilder<S> {
    return this.#derive<S>({ nice: value });
  }

  /** Set the file creation mask as a decimal integer or octal string such as "022". */
  umask(mask: number | string): LaunchAgentBuilder<S> {
    return this.#derive<S>({ umask: mask });
  }

  /**
   * Historical flag asking launchd to glob program arguments.
   * @deprecated launchd has ignored EnableGlobbing since OS X 10.10.
   */
  enableGlobbing(value = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({ enableGlobbing: value });
  }

  /** Let XPC transactions indicate whether the job is active. */
  enableTransactions(value = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({ enableTransactions: value });
  }

  /** Allow reclamation under memory pressure when the job is inactive. */
  enablePressuredExit(value = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({ enablePressuredExit: value });
  }

  /** Leave processes in the job's process group alive when the job exits. */
  abandonProcessGroup(value = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({ abandonProcessGroup: value });
  }

  /** Apply low-priority filesystem I/O policy. */
  lowPriorityIO(value = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({ lowPriorityIO: value });
  }

  /** Apply low-priority I/O while the process is background-throttled. */
  lowPriorityBackgroundIO(value = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({ lowPriorityBackgroundIO: value });
  }

  /** Select whether dataless files should be materialized. */
  materializeDatalessFiles(value = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({ materializeDatalessFiles: value });
  }

  /** Prevent the job from being launched more than once before reboot. */
  launchOnlyOnce(value = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({ launchOnlyOnce: value });
  }

  /** Spawn the job into a new security audit session. */
  sessionCreate(value = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({ sessionCreate: value });
  }

  /** Request legacy timer behavior; may need processType "Interactive". */
  legacyTimers(value = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({ legacyTimers: value });
  }

  /** Replace the session-type restriction, keeping the scalar or array form given. */
  sessionTypes(types: SessionType | readonly SessionType[]): LaunchAgentBuilder<S> {
    return this.#derive<S>({
      sessionTypes: typeof types === "string" ? types : Object.freeze([...types]),
    });
  }

  /** Replace the associated bundle identifiers, keeping the scalar or array form given. */
  associatedBundleIdentifiers(
    identifiers: string | readonly string[],
  ): LaunchAgentBuilder<S> {
    return this.#derive<S>({
      associatedBundleIdentifiers: typeof identifiers === "string"
        ? identifiers
        : Object.freeze([...identifiers]),
    });
  }

  /** Replace the whole soft resource-limit dictionary. */
  softResourceLimits(limits: ResourceLimits): LaunchAgentBuilder<S> {
    return this.#derive<S>({ softResourceLimits: Object.freeze({ ...limits }) });
  }

  /** Replace the whole hard resource-limit dictionary. */
  hardResourceLimits(limits: ResourceLimits): LaunchAgentBuilder<S> {
    return this.#derive<S>({ hardResourceLimits: Object.freeze({ ...limits }) });
  }

  /** Replace the whole Mach-service record; use addMachService() to merge. */
  machServices(services: Readonly<Record<string, MachService>>): LaunchAgentBuilder<S> {
    return this.#derive<S>({ machServices: Object.freeze({ ...services }) });
  }

  /**
   * Merge one Mach service; a repeated name replaces that entry wholesale.
   * Omitting the options stores the `true` shorthand.
   */
  addMachService(name: string, service: MachService = true): LaunchAgentBuilder<S> {
    return this.#derive<S>({
      machServices: Object.freeze({ ...this.#draft.machServices, [name]: service }),
    });
  }

  /** Replace the whole raw-plist escape hatch; use addExtra() to merge. */
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
   */
  build(this: LaunchAgentBuilder<"has-program">): LaunchAgentConfig {
    const config: unknown = { ...this.#draft };
    validateLaunchAgent(config);
    return config;
  }
}

/** Start a fluent LaunchAgent definition for the given label. */
export function launchAgent(label: string): LaunchAgentBuilder<"needs-program"> {
  return construct({ label }) as LaunchAgentBuilder<"needs-program">;
}
