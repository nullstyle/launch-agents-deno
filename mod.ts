/**
 * Typed definitions, validation, deterministic plist rendering, and launchctl
 * management for per-user macOS LaunchAgents.
 *
 * Defining and rendering are pure and need no permissions; only the
 * {@linkcode LaunchAgents} manager touches the filesystem and launchctl.
 *
 * @example Define an agent fluently and render its plist
 * ```ts
 * import { assertStringIncludes } from "@std/assert";
 *
 * const agent = launchAgent("dev.example.tidy")
 *   .programArguments(["/usr/bin/find", "/Users/me/Downloads", "-mtime", "+30", "-delete"])
 *   .daily(3, 15)
 *   .build();
 *
 * const xml = renderLaunchAgent(agent);
 * assertStringIncludes(xml, "<string>dev.example.tidy</string>");
 * assertStringIncludes(xml, "<key>StartCalendarInterval</key>");
 * ```
 *
 * @module
 */
export {
  defineLaunchAgent,
  renderLaunchAgent,
  toLaunchdPlist,
  validateLaunchAgent,
} from "./src/plist.ts";
export { launchAgent, LaunchAgentBuilder } from "./src/builder.ts";
export type { LaunchAgentBuilderState } from "./src/builder.ts";
export {
  LaunchAgentFileExistsError,
  LaunchAgentOperationError,
  LaunchAgentValidationError,
  LaunchctlError,
} from "./src/errors.ts";
export { LaunchAgents } from "./src/launch_agents.ts";
export type {
  CalendarInterval,
  CommandResult,
  CommandRunner,
  CommandRunOptions,
  InstallOptions,
  InstallResult,
  KeepAliveConditions,
  LaunchAgentConfig,
  LaunchAgentDomain,
  LaunchAgentOptions,
  LaunchAgentsOptions,
  LaunchctlResult,
  MachService,
  MachServiceOptions,
  NonEmptyArray,
  PlistDictionary,
  PlistValue,
  ProcessType,
  RemoveOptions,
  ResourceLimits,
  SessionType,
  UninstallOptions,
  UninstallResult,
  ValidationIssue,
  WriteOptions,
  WriteResult,
} from "./src/types.ts";
