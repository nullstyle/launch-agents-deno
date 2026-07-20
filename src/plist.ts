import { LaunchAgentValidationError } from "./errors.ts";
import type {
  CalendarInterval,
  KeepAliveConditions,
  LaunchAgentConfig,
  MachService,
  PlistDictionary,
  PlistValue,
  ResourceLimits,
  ValidationIssue,
} from "./types.ts";

const MANAGED_KEYS = new Set([
  "Label",
  "Program",
  "ProgramArguments",
  "RunAtLoad",
  "KeepAlive",
  "Disabled",
  "WorkingDirectory",
  "EnvironmentVariables",
  "StandardInPath",
  "StandardOutPath",
  "StandardErrorPath",
  "WatchPaths",
  "QueueDirectories",
  "StartOnMount",
  "StartInterval",
  "StartCalendarInterval",
  "ProcessType",
  "ThrottleInterval",
  "ExitTimeOut",
  "Nice",
  "Umask",
  "EnableGlobbing",
  "EnableTransactions",
  "EnablePressuredExit",
  "AbandonProcessGroup",
  "LowPriorityIO",
  "LowPriorityBackgroundIO",
  "MaterializeDatalessFiles",
  "LaunchOnlyOnce",
  "SessionCreate",
  "LegacyTimers",
  "LimitLoadToSessionType",
  "AssociatedBundleIdentifiers",
  "SoftResourceLimits",
  "HardResourceLimits",
  "MachServices",
]);

const CONFIG_KEYS = new Set([
  "label",
  "program",
  "programArguments",
  "runAtLoad",
  "keepAlive",
  "disabled",
  "workingDirectory",
  "environment",
  "standardInPath",
  "standardOutPath",
  "standardErrorPath",
  "watchPaths",
  "queueDirectories",
  "startOnMount",
  "startInterval",
  "startCalendarInterval",
  "processType",
  "throttleInterval",
  "exitTimeOut",
  "nice",
  "umask",
  "enableGlobbing",
  "enableTransactions",
  "enablePressuredExit",
  "abandonProcessGroup",
  "lowPriorityIO",
  "lowPriorityBackgroundIO",
  "materializeDatalessFiles",
  "launchOnlyOnce",
  "sessionCreate",
  "legacyTimers",
  "sessionTypes",
  "associatedBundleIdentifiers",
  "softResourceLimits",
  "hardResourceLimits",
  "machServices",
  "extra",
]);

const BOOLEAN_KEYS = [
  "runAtLoad",
  "disabled",
  "startOnMount",
  "enableGlobbing",
  "enableTransactions",
  "enablePressuredExit",
  "abandonProcessGroup",
  "lowPriorityIO",
  "lowPriorityBackgroundIO",
  "materializeDatalessFiles",
  "launchOnlyOnce",
  "sessionCreate",
  "legacyTimers",
] as const;

const PROCESS_TYPES = new Set(["Background", "Standard", "Adaptive", "Interactive"]);
const SESSION_TYPES = new Set(["Aqua", "Background", "LoginWindow", "StandardIO", "System"]);

const RESOURCE_KEYS: Readonly<Record<keyof ResourceLimits, string>> = {
  core: "Core",
  cpu: "CPU",
  data: "Data",
  fileSize: "FileSize",
  memoryLock: "MemoryLock",
  numberOfFiles: "NumberOfFiles",
  numberOfProcesses: "NumberOfProcesses",
  residentSetSize: "ResidentSetSize",
  stack: "Stack",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isXmlString(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const codePoint = value.codePointAt(index)!;
    if (codePoint > 0xffff) index++;
    const valid = codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    if (!valid) return false;
  }
  return true;
}

function addStringIssue(
  issues: ValidationIssue[],
  path: string,
  value: unknown,
  options: { nonEmpty?: boolean; absolute?: boolean } = {},
): void {
  if (typeof value !== "string") {
    issues.push({ path, message: "must be a string" });
    return;
  }
  if (options.nonEmpty && value.length === 0) {
    issues.push({ path, message: "must not be empty" });
  }
  if (options.absolute && !value.startsWith("/")) {
    issues.push({ path, message: "must be an absolute path (launchd does not expand ~)" });
  }
  if (!isXmlString(value)) {
    issues.push({ path, message: "contains a character that XML property lists cannot encode" });
  }
  if (value.includes("\0")) {
    issues.push({ path, message: "must not contain a NUL byte" });
  }
}

function addIntegerIssue(
  issues: ValidationIssue[],
  path: string,
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): void {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    issues.push({ path, message: `must be an integer from ${minimum} through ${maximum}` });
  }
}

/**
 * Shared label rules: a label doubles as a `.plist` filename component, so
 * both the definition validator and the manager's label-only entry points
 * apply exactly this check. Not part of the public API.
 */
export function labelIssues(label: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  addStringIssue(issues, "label", label, { nonEmpty: true });
  if (typeof label !== "string") return issues;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label)) {
    issues.push({
      path: "label",
      message: "may contain only letters, numbers, periods, underscores, and hyphens",
    });
  }
  if (label.length > 249) {
    issues.push({ path: "label", message: "is too long to use as a .plist filename" });
  }
  return issues;
}

function validateAbsolutePaths(
  issues: ValidationIssue[],
  path: string,
  value: unknown,
): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ path, message: "must be a non-empty array" });
    return;
  }
  value.forEach((item, index) =>
    addStringIssue(issues, `${path}[${index}]`, item, {
      nonEmpty: true,
      absolute: true,
    })
  );
}

function validateCalendar(
  issues: ValidationIssue[],
  interval: unknown,
  path: string,
): void {
  if (!isPlainObject(interval)) {
    issues.push({ path, message: "must be a calendar interval object" });
    return;
  }
  const recognized = ["minute", "hour", "day", "weekday", "month"] as const;
  for (const key of Object.keys(interval)) {
    if (!recognized.includes(key as (typeof recognized)[number])) {
      issues.push({ path: `${path}.${key}`, message: "is not a supported calendar field" });
    }
  }
  if (!recognized.some((key) => interval[key] !== undefined)) {
    issues.push({ path, message: "must specify at least one calendar field" });
  }
  if (interval.minute !== undefined) {
    addIntegerIssue(issues, `${path}.minute`, interval.minute, 0, 59);
  }
  if (interval.hour !== undefined) addIntegerIssue(issues, `${path}.hour`, interval.hour, 0, 23);
  if (interval.day !== undefined) addIntegerIssue(issues, `${path}.day`, interval.day, 1, 31);
  if (interval.weekday !== undefined) {
    addIntegerIssue(issues, `${path}.weekday`, interval.weekday, 0, 7);
  }
  if (interval.month !== undefined) addIntegerIssue(issues, `${path}.month`, interval.month, 1, 12);
}

function validateStringBooleanRecord(
  issues: ValidationIssue[],
  value: unknown,
  path: string,
  keyIsPath = false,
): void {
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    issues.push({ path, message: "must be a non-empty dictionary" });
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    addStringIssue(issues, `${path} key`, key, { nonEmpty: true, absolute: keyIsPath });
    if (typeof item !== "boolean") {
      issues.push({ path: `${path}.${key}`, message: "must be a boolean" });
    }
  }
}

function validateKeepAlive(
  issues: ValidationIssue[],
  value: unknown,
  path: string,
): void {
  if (typeof value === "boolean") return;
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    issues.push({ path, message: "must be a boolean or non-empty condition dictionary" });
    return;
  }
  if (value.successfulExit !== undefined && typeof value.successfulExit !== "boolean") {
    issues.push({ path: `${path}.successfulExit`, message: "must be a boolean" });
  }
  if (value.crashed !== undefined && typeof value.crashed !== "boolean") {
    issues.push({ path: `${path}.crashed`, message: "must be a boolean" });
  }
  if (value.pathState !== undefined) {
    validateStringBooleanRecord(issues, value.pathState, `${path}.pathState`, true);
  }
  if (value.otherJobEnabled !== undefined) {
    validateStringBooleanRecord(issues, value.otherJobEnabled, `${path}.otherJobEnabled`);
  }
  const recognized = ["successfulExit", "crashed", "pathState", "otherJobEnabled"];
  for (const key of Object.keys(value)) {
    if (!recognized.includes(key)) {
      issues.push({ path: `${path}.${key}`, message: "is not a supported keep-alive condition" });
    }
  }
  if (!recognized.some((key) => value[key] !== undefined)) {
    issues.push({ path, message: "does not contain a supported keep-alive condition" });
  }
}

function validateResourceLimits(
  issues: ValidationIssue[],
  value: unknown,
  path: string,
): void {
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    issues.push({ path, message: "must be a non-empty resource-limit dictionary" });
    return;
  }
  for (const key of Object.keys(RESOURCE_KEYS) as (keyof ResourceLimits)[]) {
    if (value[key] !== undefined) addIntegerIssue(issues, `${path}.${key}`, value[key], 0);
  }
  for (const key of Object.keys(value)) {
    if (!(key in RESOURCE_KEYS)) {
      issues.push({ path: `${path}.${key}`, message: "is not a supported resource limit" });
    }
  }
}

function validateMachServices(
  issues: ValidationIssue[],
  value: unknown,
  path: string,
): void {
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    issues.push({ path, message: "must be a non-empty dictionary" });
    return;
  }
  for (const [name, service] of Object.entries(value)) {
    addStringIssue(issues, `${path} key`, name, { nonEmpty: true });
    if (service === true) continue;
    if (!isPlainObject(service)) {
      issues.push({ path: `${path}.${name}`, message: "must be true or an options object" });
      continue;
    }
    for (const key of ["resetAtClose", "hideUntilCheckIn"]) {
      if (service[key] !== undefined && typeof service[key] !== "boolean") {
        issues.push({ path: `${path}.${name}.${key}`, message: "must be a boolean" });
      }
    }
    for (const key of Object.keys(service)) {
      if (key !== "resetAtClose" && key !== "hideUntilCheckIn") {
        issues.push({ path: `${path}.${name}.${key}`, message: "is not a supported option" });
      }
    }
  }
}

function validatePlistValue(
  issues: ValidationIssue[],
  value: unknown,
  path: string,
  ancestors: Set<object>,
): void {
  if (typeof value === "string") {
    addStringIssue(issues, path, value);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      issues.push({ path, message: "plist numbers must be safe integers" });
    }
    return;
  }
  if (typeof value === "boolean") return;
  if (value === null || typeof value !== "object") {
    issues.push({ path, message: "is not a supported plist value" });
    return;
  }
  if (ancestors.has(value)) {
    issues.push({ path, message: "must not contain a cycle" });
    return;
  }
  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      validatePlistValue(issues, item, `${path}[${index}]`, nextAncestors)
    );
    return;
  }
  if (!isPlainObject(value)) {
    issues.push({ path, message: "must be a plain dictionary" });
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    addStringIssue(issues, `${path} key`, key, { nonEmpty: true });
    validatePlistValue(issues, item, `${path}.${key}`, nextAncestors);
  }
}

/**
 * Validate an unknown value as a LaunchAgent definition, throwing one error
 * containing all discovered issues. Narrows the value on success.
 *
 * @example Narrow untrusted input, such as parsed JSON
 * ```ts
 * import { assertEquals } from "@std/assert";
 *
 * const parsed: unknown = JSON.parse('{"label":"dev.example.json","program":"/usr/bin/true"}');
 * validateLaunchAgent(parsed); // throws LaunchAgentValidationError on failure
 * assertEquals(parsed.label, "dev.example.json"); // parsed is now a LaunchAgentConfig
 * ```
 */
export function validateLaunchAgent(value: unknown): asserts value is LaunchAgentConfig {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(value)) {
    throw new LaunchAgentValidationError([{ path: "config", message: "must be an object" }]);
  }
  const config = value as unknown as LaunchAgentConfig;

  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      issues.push({
        path: key,
        message: "is not a supported property; use extra for raw plist keys",
      });
    }
  }

  issues.push(...labelIssues(config.label));

  if (config.program === undefined && config.programArguments === undefined) {
    issues.push({ path: "program", message: "program or programArguments is required" });
  }
  if (config.program !== undefined) {
    addStringIssue(issues, "program", config.program, { nonEmpty: true, absolute: true });
  }
  if (config.programArguments !== undefined) {
    if (!Array.isArray(config.programArguments) || config.programArguments.length === 0) {
      issues.push({ path: "programArguments", message: "must be a non-empty array" });
    } else {
      config.programArguments.forEach((argument, index) => {
        addStringIssue(issues, `programArguments[${index}]`, argument);
      });
    }
  }

  for (
    const key of [
      "workingDirectory",
      "standardInPath",
      "standardOutPath",
      "standardErrorPath",
    ] as const
  ) {
    if (config[key] !== undefined) {
      addStringIssue(issues, key, config[key], { nonEmpty: true, absolute: true });
    }
  }

  if (config.environment !== undefined) {
    if (!isPlainObject(config.environment)) {
      issues.push({ path: "environment", message: "must be a dictionary of strings" });
    } else {
      for (const [name, value] of Object.entries(config.environment)) {
        addStringIssue(issues, "environment key", name, { nonEmpty: true });
        if (name.includes("=")) {
          issues.push({
            path: `environment.${name}`,
            message: "variable names must not contain =",
          });
        }
        addStringIssue(issues, `environment.${name}`, value);
      }
    }
  }

  for (const key of BOOLEAN_KEYS) {
    if (config[key] !== undefined && typeof config[key] !== "boolean") {
      issues.push({ path: key, message: "must be a boolean" });
    }
  }

  if (config.processType !== undefined && !PROCESS_TYPES.has(config.processType)) {
    issues.push({ path: "processType", message: "must be a supported launchd process type" });
  }

  if (config.sessionTypes !== undefined) {
    const values = Array.isArray(config.sessionTypes) ? config.sessionTypes : [config.sessionTypes];
    if (values.length === 0) {
      issues.push({ path: "sessionTypes", message: "must not be an empty array" });
    }
    values.forEach((value, index) => {
      if (typeof value !== "string" || !SESSION_TYPES.has(value)) {
        const path = Array.isArray(config.sessionTypes) ? `sessionTypes[${index}]` : "sessionTypes";
        issues.push({ path, message: "must be a supported launchd session type" });
      }
    });
  }

  if (config.associatedBundleIdentifiers !== undefined) {
    const values = Array.isArray(config.associatedBundleIdentifiers)
      ? config.associatedBundleIdentifiers
      : [config.associatedBundleIdentifiers];
    if (values.length === 0) {
      issues.push({ path: "associatedBundleIdentifiers", message: "must not be an empty array" });
    }
    values.forEach((value, index) => {
      const path = Array.isArray(config.associatedBundleIdentifiers)
        ? `associatedBundleIdentifiers[${index}]`
        : "associatedBundleIdentifiers";
      addStringIssue(issues, path, value, { nonEmpty: true });
    });
  }

  if (config.watchPaths !== undefined) {
    validateAbsolutePaths(issues, "watchPaths", config.watchPaths);
  }
  if (config.queueDirectories !== undefined) {
    validateAbsolutePaths(issues, "queueDirectories", config.queueDirectories);
  }
  if (config.startInterval !== undefined) {
    addIntegerIssue(issues, "startInterval", config.startInterval, 1);
  }
  if (config.throttleInterval !== undefined) {
    addIntegerIssue(issues, "throttleInterval", config.throttleInterval, 1);
  }
  if (config.exitTimeOut !== undefined) {
    addIntegerIssue(issues, "exitTimeOut", config.exitTimeOut, 0);
  }
  if (config.nice !== undefined) addIntegerIssue(issues, "nice", config.nice, -20, 20);

  if (config.umask !== undefined) {
    const validNumber = Number.isSafeInteger(config.umask) &&
      (config.umask as number) >= 0 && (config.umask as number) <= 0o777;
    const validString = typeof config.umask === "string" && /^0[0-7]{1,3}$/.test(config.umask);
    if (!validNumber && !validString) {
      issues.push({ path: "umask", message: "must be 0..511 or an octal string such as 022" });
    }
  }

  if (config.keepAlive !== undefined) validateKeepAlive(issues, config.keepAlive, "keepAlive");

  if (config.startCalendarInterval !== undefined) {
    const intervals = Array.isArray(config.startCalendarInterval)
      ? config.startCalendarInterval
      : [config.startCalendarInterval];
    if (intervals.length === 0) {
      issues.push({ path: "startCalendarInterval", message: "must not be an empty array" });
    }
    intervals.forEach((interval, index) => {
      const path = Array.isArray(config.startCalendarInterval)
        ? `startCalendarInterval[${index}]`
        : "startCalendarInterval";
      validateCalendar(issues, interval, path);
    });
  }

  if (config.softResourceLimits !== undefined) {
    validateResourceLimits(issues, config.softResourceLimits, "softResourceLimits");
  }
  if (config.hardResourceLimits !== undefined) {
    validateResourceLimits(issues, config.hardResourceLimits, "hardResourceLimits");
  }
  if (config.machServices !== undefined) {
    validateMachServices(issues, config.machServices, "machServices");
  }

  if (config.extra !== undefined) {
    if (!isPlainObject(config.extra)) {
      issues.push({ path: "extra", message: "must be a plain dictionary" });
    } else {
      for (const key of Object.keys(config.extra)) {
        if (MANAGED_KEYS.has(key)) {
          issues.push({ path: `extra.${key}`, message: "cannot override a managed key" });
        }
      }
      validatePlistValue(issues, config.extra, "extra", new Set());
    }
  }

  if (issues.length > 0) throw new LaunchAgentValidationError(issues);
}

/**
 * Type-friendly identity helper that validates definitions at startup.
 *
 * @example Define a scheduled backup agent
 * ```ts
 * import { assertEquals } from "@std/assert";
 *
 * const agent = defineLaunchAgent({
 *   label: "dev.example.backup",
 *   program: "/usr/bin/rsync",
 *   programArguments: ["/usr/bin/rsync", "-a", "/Users/me/Documents/", "/Volumes/Backup/"],
 *   startCalendarInterval: { hour: 2, minute: 30 },
 *   processType: "Background",
 * });
 * assertEquals(agent.label, "dev.example.backup");
 * ```
 */
export function defineLaunchAgent<const T extends LaunchAgentConfig>(config: T): T {
  validateLaunchAgent(config);
  return config;
}

function calendarToPlist(interval: CalendarInterval): PlistDictionary {
  const output: Record<string, PlistValue> = {};
  if (interval.minute !== undefined) output.Minute = interval.minute;
  if (interval.hour !== undefined) output.Hour = interval.hour;
  if (interval.day !== undefined) output.Day = interval.day;
  if (interval.weekday !== undefined) output.Weekday = interval.weekday;
  if (interval.month !== undefined) output.Month = interval.month;
  return output;
}

function keepAliveToPlist(value: boolean | KeepAliveConditions): PlistValue {
  if (typeof value === "boolean") return value;
  const output: Record<string, PlistValue> = {};
  if (value.successfulExit !== undefined) output.SuccessfulExit = value.successfulExit;
  if (value.crashed !== undefined) output.Crashed = value.crashed;
  if (value.pathState !== undefined) output.PathState = value.pathState;
  if (value.otherJobEnabled !== undefined) output.OtherJobEnabled = value.otherJobEnabled;
  return output;
}

function resourcesToPlist(limits: ResourceLimits): PlistDictionary {
  const output: Record<string, PlistValue> = {};
  for (const key of Object.keys(RESOURCE_KEYS) as (keyof ResourceLimits)[]) {
    const value = limits[key];
    if (value !== undefined) output[RESOURCE_KEYS[key]] = value;
  }
  return output;
}

function machServicesToPlist(
  services: Readonly<Record<string, MachService>>,
): PlistDictionary {
  const output: Record<string, PlistValue> = {};
  for (const [name, service] of Object.entries(services)) {
    if (service === true) {
      output[name] = true;
      continue;
    }
    const options: Record<string, PlistValue> = {};
    if (service.resetAtClose !== undefined) options.ResetAtClose = service.resetAtClose;
    if (service.hideUntilCheckIn !== undefined) options.HideUntilCheckIn = service.hideUntilCheckIn;
    output[name] = options;
  }
  return output;
}

/**
 * Convert an idiomatic TypeScript definition to launchd's key names.
 *
 * @example camelCase fields become launchd's capitalized plist keys
 * ```ts
 * import { assertEquals } from "@std/assert";
 *
 * const plist = toLaunchdPlist({
 *   label: "dev.example.tick",
 *   programArguments: ["/usr/bin/say", "tick"],
 *   startInterval: 300,
 * });
 * assertEquals(plist, {
 *   Label: "dev.example.tick",
 *   ProgramArguments: ["/usr/bin/say", "tick"],
 *   StartInterval: 300,
 * });
 * ```
 */
export function toLaunchdPlist(config: LaunchAgentConfig): PlistDictionary {
  validateLaunchAgent(config);
  const output: Record<string, PlistValue> = { Label: config.label };

  if (config.program !== undefined) output.Program = config.program;
  if (config.programArguments !== undefined) output.ProgramArguments = config.programArguments;
  if (config.runAtLoad !== undefined) output.RunAtLoad = config.runAtLoad;
  if (config.keepAlive !== undefined) output.KeepAlive = keepAliveToPlist(config.keepAlive);
  if (config.disabled !== undefined) output.Disabled = config.disabled;
  if (config.workingDirectory !== undefined) output.WorkingDirectory = config.workingDirectory;
  if (config.environment !== undefined) output.EnvironmentVariables = config.environment;
  if (config.standardInPath !== undefined) output.StandardInPath = config.standardInPath;
  if (config.standardOutPath !== undefined) output.StandardOutPath = config.standardOutPath;
  if (config.standardErrorPath !== undefined) output.StandardErrorPath = config.standardErrorPath;
  if (config.watchPaths !== undefined) output.WatchPaths = config.watchPaths;
  if (config.queueDirectories !== undefined) output.QueueDirectories = config.queueDirectories;
  if (config.startOnMount !== undefined) output.StartOnMount = config.startOnMount;
  if (config.startInterval !== undefined) output.StartInterval = config.startInterval;
  if (config.startCalendarInterval !== undefined) {
    output.StartCalendarInterval = Array.isArray(config.startCalendarInterval)
      ? config.startCalendarInterval.map(calendarToPlist)
      : calendarToPlist(config.startCalendarInterval as CalendarInterval);
  }
  if (config.processType !== undefined) output.ProcessType = config.processType;
  if (config.throttleInterval !== undefined) output.ThrottleInterval = config.throttleInterval;
  if (config.exitTimeOut !== undefined) output.ExitTimeOut = config.exitTimeOut;
  if (config.nice !== undefined) output.Nice = config.nice;
  if (config.umask !== undefined) output.Umask = config.umask;
  if (config.enableGlobbing !== undefined) output.EnableGlobbing = config.enableGlobbing;
  if (config.enableTransactions !== undefined) {
    output.EnableTransactions = config.enableTransactions;
  }
  if (config.enablePressuredExit !== undefined) {
    output.EnablePressuredExit = config.enablePressuredExit;
  }
  if (config.abandonProcessGroup !== undefined) {
    output.AbandonProcessGroup = config.abandonProcessGroup;
  }
  if (config.lowPriorityIO !== undefined) output.LowPriorityIO = config.lowPriorityIO;
  if (config.lowPriorityBackgroundIO !== undefined) {
    output.LowPriorityBackgroundIO = config.lowPriorityBackgroundIO;
  }
  if (config.materializeDatalessFiles !== undefined) {
    output.MaterializeDatalessFiles = config.materializeDatalessFiles;
  }
  if (config.launchOnlyOnce !== undefined) output.LaunchOnlyOnce = config.launchOnlyOnce;
  if (config.sessionCreate !== undefined) output.SessionCreate = config.sessionCreate;
  if (config.legacyTimers !== undefined) output.LegacyTimers = config.legacyTimers;
  if (config.sessionTypes !== undefined) output.LimitLoadToSessionType = config.sessionTypes;
  if (config.associatedBundleIdentifiers !== undefined) {
    output.AssociatedBundleIdentifiers = config.associatedBundleIdentifiers;
  }
  if (config.softResourceLimits !== undefined) {
    output.SoftResourceLimits = resourcesToPlist(config.softResourceLimits);
  }
  if (config.hardResourceLimits !== undefined) {
    output.HardResourceLimits = resourcesToPlist(config.hardResourceLimits);
  }
  if (config.machServices !== undefined) {
    output.MachServices = machServicesToPlist(config.machServices);
  }
  if (config.extra !== undefined) Object.assign(output, config.extra);

  return output;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function encodeValue(value: PlistValue, depth: number): string[] {
  const indentation = "  ".repeat(depth);
  if (typeof value === "string") return [`${indentation}<string>${escapeXml(value)}</string>`];
  if (typeof value === "number") return [`${indentation}<integer>${value}</integer>`];
  if (typeof value === "boolean") return [`${indentation}<${value ? "true" : "false"}/>`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indentation}<array/>`];
    return [
      `${indentation}<array>`,
      ...value.flatMap((item) => encodeValue(item, depth + 1)),
      `${indentation}</array>`,
    ];
  }
  const entries = Object.entries(value as PlistDictionary).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  if (entries.length === 0) return [`${indentation}<dict/>`];
  return [
    `${indentation}<dict>`,
    ...entries.flatMap(([key, item]) => [
      `${"  ".repeat(depth + 1)}<key>${escapeXml(key)}</key>`,
      ...encodeValue(item, depth + 1),
    ]),
    `${indentation}</dict>`,
  ];
}

/**
 * Render a complete, deterministic XML property list.
 *
 * @example Render a minimal agent
 * ```ts
 * import { assertStringIncludes } from "@std/assert";
 *
 * const xml = renderLaunchAgent({
 *   label: "dev.example.hello",
 *   program: "/opt/homebrew/bin/hello",
 *   runAtLoad: true,
 * });
 * assertStringIncludes(xml, '<?xml version="1.0" encoding="UTF-8"?>');
 * assertStringIncludes(xml, "<key>RunAtLoad</key>\n    <true/>");
 * ```
 */
export function renderLaunchAgent(config: LaunchAgentConfig): string {
  const dictionary = toLaunchdPlist(config);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"',
    '  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    ...encodeValue(dictionary, 1),
    "</plist>",
    "",
  ].join("\n");
}
