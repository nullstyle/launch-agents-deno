import type { LaunchctlResult, ValidationIssue } from "./types.ts";

/**
 * Thrown when a LaunchAgent definition violates one or more constraints.
 *
 * All problems are collected before throwing, so `issues` lists every
 * violation at once rather than only the first.
 *
 * @example Inspect the issues of a rejected definition
 * ```ts
 * import { assertEquals, assertThrows } from "@std/assert";
 * import { validateLaunchAgent } from "./plist.ts";
 *
 * const error = assertThrows(
 *   () => validateLaunchAgent({ label: "bad label", program: "relative" }),
 *   LaunchAgentValidationError,
 * );
 * assertEquals(error.issues.map((issue) => issue.path).sort(), ["label", "program"]);
 * ```
 */
export class LaunchAgentValidationError extends Error {
  /** Every validation problem found in the definition. */
  readonly issues: readonly ValidationIssue[];

  /** Create an error from one or more validation issues. */
  constructor(issues: readonly ValidationIssue[]) {
    const details = issues.map(({ path, message }) => `${path}: ${message}`).join("; ");
    super(`Invalid LaunchAgent definition: ${details}`);
    this.name = "LaunchAgentValidationError";
    this.issues = issues;
  }
}

/** Thrown when an operation would replace a different plist without permission. */
export class LaunchAgentFileExistsError extends Error {
  /** Absolute path of the protected plist. */
  readonly path: string;

  /** Create an error for the protected path. */
  constructor(path: string) {
    super(`A different LaunchAgent plist already exists at ${path}`);
    this.name = "LaunchAgentFileExistsError";
    this.path = path;
  }
}

/** Thrown when a launchctl process fails or returns unusable output. */
export class LaunchctlError extends Error {
  /** Full command result, including captured output and the command arguments. */
  readonly result: LaunchctlResult;

  /** Create an error from a launchctl result, optionally overriding the detail text. */
  constructor(result: LaunchctlResult, detail?: string) {
    const suffix = detail ??
      (result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`);
    super(`launchctl failed (${result.command.join(" ")}): ${suffix}`);
    this.name = "LaunchctlError";
    this.result = result;
  }
}

/** Thrown when a composite install or uninstall operation fails. */
export class LaunchAgentOperationError extends Error {
  /** Composite operation that failed. */
  readonly operation: "install" | "uninstall";
  /**
   * An AggregateError of recovery failures, present when restoring the
   * earlier state also failed or was impossible.
   */
  readonly rollbackError?: unknown;

  /** Create an operation error while retaining the primary and rollback causes. */
  constructor(
    operation: "install" | "uninstall",
    cause: unknown,
    rollbackError?: unknown,
  ) {
    const suffix = rollbackError === undefined ? "" : "; rollback also failed";
    super(`Could not ${operation} LaunchAgent${suffix}`, { cause });
    this.name = "LaunchAgentOperationError";
    this.operation = operation;
    this.rollbackError = rollbackError;
  }
}
