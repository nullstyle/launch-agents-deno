import {
  LaunchAgentFileExistsError,
  LaunchAgentOperationError,
  LaunchAgentValidationError,
  LaunchctlError,
} from "./errors.ts";
import { labelIssues, renderLaunchAgent } from "./plist.ts";
import type {
  CommandResult,
  CommandRunner,
  CommandRunOptions,
  InstallOptions,
  InstallResult,
  LaunchAgentConfig,
  LaunchAgentDomain,
  LaunchAgentsOptions,
  LaunchctlResult,
  RemoveOptions,
  UninstallOptions,
  UninstallResult,
  WriteOptions,
  WriteResult,
} from "./types.ts";

const decoder = new TextDecoder();

class DenoCommandRunner implements CommandRunner {
  async run(
    command: string,
    args: readonly string[],
    options: CommandRunOptions = {},
  ): Promise<CommandResult> {
    const output = await new Deno.Command(command, {
      args: [...args],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: options.signal,
    }).output();
    return {
      code: output.code,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  }
}

function defaultDirectory(): string {
  const home = Deno.env.get("HOME");
  if (!home) {
    throw new Error("HOME is not set; pass LaunchAgents({ directory }) explicitly");
  }
  return `${home.replace(/\/+$/, "")}/Library/LaunchAgents`;
}

function assertAbsoluteDirectory(directory: string): void {
  if (!directory.startsWith("/")) {
    throw new TypeError("LaunchAgents directory must be an absolute path");
  }
  if (directory.includes("\0")) throw new TypeError("LaunchAgents directory must not contain NUL");
}

function assertLabel(label: string): void {
  const issues = labelIssues(label);
  if (issues.length > 0) throw new LaunchAgentValidationError(issues);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Deno.errors.NotFound;
}

/**
 * Manages per-user plist files and services in a launchd GUI or user domain.
 * No method invokes a shell; every launchctl argument is passed literally.
 */
export class LaunchAgents {
  /** Absolute directory containing managed plist files. */
  readonly directory: string;
  /** Unix user identifier used in launchctl targets. */
  readonly uid: number;
  /** launchd domain kind used for service targets. */
  readonly domain: LaunchAgentDomain;
  /** Absolute launchctl executable path. */
  readonly launchctlPath: string;
  /** Milliseconds before an in-flight launchctl invocation is aborted. */
  readonly timeoutMillis: number | undefined;
  readonly #runner: CommandRunner;

  /** Create a manager, defaulting to the current user's GUI domain. */
  constructor(options: LaunchAgentsOptions = {}) {
    this.directory = (options.directory ?? defaultDirectory()).replace(/\/+$/, "");
    assertAbsoluteDirectory(this.directory);

    const uid = options.uid ?? Deno.uid();
    if (uid === null) {
      throw new TypeError("Could not detect a Unix uid; pass LaunchAgents({ uid }) explicitly");
    }
    this.uid = uid;
    if (!Number.isSafeInteger(this.uid) || this.uid < 0) {
      throw new TypeError("LaunchAgents uid must be a non-negative integer");
    }

    this.domain = options.domain ?? "gui";
    this.launchctlPath = options.launchctlPath ?? "/bin/launchctl";
    if (!this.launchctlPath.startsWith("/")) {
      throw new TypeError("launchctlPath must be an absolute path");
    }
    if (this.launchctlPath.includes("\0")) {
      throw new TypeError("launchctlPath must not contain NUL");
    }
    this.timeoutMillis = options.timeoutMillis;
    if (
      this.timeoutMillis !== undefined &&
      (!Number.isSafeInteger(this.timeoutMillis) || this.timeoutMillis < 1)
    ) {
      throw new TypeError("timeoutMillis must be a positive integer");
    }
    this.#runner = options.runner ?? new DenoCommandRunner();
  }

  /** Domain target in `gui/<uid>` or `user/<uid>` form. */
  get domainTarget(): string {
    return `${this.domain}/${this.uid}`;
  }

  /** Build and validate a launchctl service target for a label. */
  serviceTarget(label: string): string {
    assertLabel(label);
    return `${this.domainTarget}/${label}`;
  }

  /** Build and validate the absolute plist path for a label. */
  agentPath(label: string): string {
    assertLabel(label);
    return `${this.directory}/${label}.plist`;
  }

  async #run(args: readonly string[]): Promise<LaunchctlResult> {
    const options = this.timeoutMillis === undefined
      ? undefined
      : { signal: AbortSignal.timeout(this.timeoutMillis) };
    const result = await this.#runner.run(this.launchctlPath, args, options);
    return { ...result, command: [this.launchctlPath, ...args] };
  }

  async #runChecked(args: readonly string[]): Promise<LaunchctlResult> {
    const result = await this.#run(args);
    if (result.code !== 0) throw new LaunchctlError(result);
    return result;
  }

  /**
   * True when launchctl can resolve this exact service target. Throws
   * `LaunchctlError` when launchctl fails for a reason other than the
   * service or domain not being found, such as a permission problem.
   */
  async isLoaded(label: string): Promise<boolean> {
    const result = await this.#run(["print", this.serviceTarget(label)]);
    if (result.code === 0) return true;
    // launchctl print exits 113 for an unknown service; the stderr check
    // also covers unknown-domain cases, where nothing can be loaded.
    if (result.code === 113 || /could not find (service|domain)/i.test(result.stderr)) {
      return false;
    }
    throw new LaunchctlError(result);
  }

  /** Raw diagnostic text. Apple does not define `launchctl print` output as an API. */
  async inspect(label: string): Promise<string> {
    return (await this.#runChecked(["print", this.serviceTarget(label)])).stdout;
  }

  /** Load the label's on-disk plist into the configured domain. */
  async bootstrap(label: string): Promise<void> {
    await this.#runChecked(["bootstrap", this.domainTarget, this.agentPath(label)]);
  }

  /** Remove the service from the configured launchd domain. */
  async bootout(label: string): Promise<void> {
    await this.#runChecked(["bootout", this.serviceTarget(label)]);
  }

  /** Clear launchctl's persistent disabled state for the service. */
  async enable(label: string): Promise<void> {
    await this.#runChecked(["enable", this.serviceTarget(label)]);
  }

  /** Persistently disable the service in the configured domain. */
  async disable(label: string): Promise<void> {
    await this.#runChecked(["disable", this.serviceTarget(label)]);
  }

  /** Start a loaded service immediately and return its PID. */
  async start(label: string): Promise<number> {
    return await this.#kickstart(label, false);
  }

  /** Kill a running instance, start a replacement, and return its PID. */
  async restart(label: string): Promise<number> {
    return await this.#kickstart(label, true);
  }

  async #kickstart(label: string, kill: boolean): Promise<number> {
    const flags = kill ? "-kp" : "-p";
    const result = await this.#runChecked(["kickstart", flags, this.serviceTarget(label)]);
    const pid = Number.parseInt(result.stdout.trim(), 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new LaunchctlError(
        result,
        `did not print a valid PID: ${result.stdout.trim() || "(empty stdout)"}`,
      );
    }
    return pid;
  }

  /** Send a signal through launchctl. The default is SIGTERM. */
  async stop(label: string, signal = "SIGTERM"): Promise<void> {
    if (!/^(?:SIG)?[A-Z0-9]+$/.test(signal)) {
      throw new TypeError("signal must be a signal name or number, such as SIGTERM or 15");
    }
    await this.#runChecked(["kill", signal, this.serviceTarget(label)]);
  }

  async #readIfPresent(path: string): Promise<string | undefined> {
    try {
      return await Deno.readTextFile(path);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async #commit(path: string, contents: string, overwrite: boolean): Promise<void> {
    await Deno.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.directory}/.${crypto.randomUUID()}.plist.tmp`;
    let temporaryExists = false;
    try {
      await Deno.writeTextFile(temporaryPath, contents, { createNew: true, mode: 0o600 });
      temporaryExists = true;
      await Deno.chmod(temporaryPath, 0o644);

      if (overwrite) {
        await Deno.rename(temporaryPath, path);
        temporaryExists = false;
      } else {
        // A same-directory hard link gives us atomic create-without-overwrite.
        await Deno.link(temporaryPath, path);
        // The destination is published; the commit has succeeded.
        temporaryExists = false;
        try {
          await Deno.remove(temporaryPath);
        } catch {
          // The unique temp filename is harmless litter.
        }
      }
    } catch (error) {
      if (temporaryExists) {
        try {
          await Deno.remove(temporaryPath);
        } catch {
          // Preserve the primary error. The temp filename is unique and harmless.
        }
      }
      if (error instanceof Deno.errors.AlreadyExists) {
        throw new LaunchAgentFileExistsError(path);
      }
      throw error;
    }
  }

  /** Atomically write a plist without invoking launchctl. */
  async write(config: LaunchAgentConfig, options: WriteOptions = {}): Promise<WriteResult> {
    const contents = renderLaunchAgent(config);
    const path = this.agentPath(config.label);
    const previous = await this.#readIfPresent(path);
    if (previous === contents) return { path, created: false, changed: false };
    if (previous !== undefined && options.overwrite !== true) {
      throw new LaunchAgentFileExistsError(path);
    }
    await this.#commit(path, contents, previous !== undefined);
    return { path, created: previous === undefined, changed: true };
  }

  /** Remove an on-disk plist without invoking launchctl. */
  async remove(label: string, options: RemoveOptions = {}): Promise<boolean> {
    const path = this.agentPath(label);
    try {
      await Deno.remove(path);
      return true;
    } catch (error) {
      if (isNotFound(error) && options.ignoreMissing !== false) return false;
      throw error;
    }
  }

  /**
   * Write and optionally bootstrap an agent. When a reload fails, the prior
   * plist and loaded service are restored when possible. Failures before the
   * transaction begins (the initial read and loaded-state probe, or an
   * overwrite refusal) are thrown as-is; failures after it begins are wrapped
   * in `LaunchAgentOperationError`.
   */
  async install(
    config: LaunchAgentConfig,
    options: InstallOptions = {},
  ): Promise<InstallResult> {
    const contents = renderLaunchAgent(config);
    const path = this.agentPath(config.label);
    const previous = await this.#readIfPresent(path);
    const changed = previous !== contents;
    const created = previous === undefined;
    if (changed && !created && options.overwrite !== true) {
      throw new LaunchAgentFileExistsError(path);
    }

    const manageService = options.load !== false;
    const wasLoaded = manageService ? await this.isLoaded(config.label) : undefined;
    const reloadLoaded = options.reloadLoaded !== false;
    let wrote = false;
    let bootedOut = false;

    try {
      if (changed) {
        await this.#commit(path, contents, !created);
        wrote = true;
      }

      if (!manageService) return { path, created, changed, wasLoaded, loaded: undefined };

      if (wasLoaded && changed && reloadLoaded) {
        await this.bootout(config.label);
        bootedOut = true;
      }
      if (!wasLoaded || bootedOut) await this.bootstrap(config.label);

      return { path, created, changed, wasLoaded, loaded: true };
    } catch (error) {
      if (!wrote && !bootedOut && error instanceof LaunchAgentFileExistsError) {
        // Nothing was mutated; surface the overwrite decision directly.
        throw error;
      }
      const rollbackErrors: unknown[] = [];
      let previousContentsOnDisk = !wrote && previous !== undefined;
      if (wrote) {
        try {
          if (previous === undefined) {
            await this.remove(config.label);
          } else {
            await this.#commit(path, previous, true);
            previousContentsOnDisk = true;
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (bootedOut) {
        if (previousContentsOnDisk) {
          try {
            await this.bootstrap(config.label);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        } else {
          // Bootstrapping here would load the wrong plist or a missing one.
          rollbackErrors.push(
            new Error(
              previous === undefined
                ? "The replaced service was not loaded from this plist; " +
                  "it was booted out and cannot be restored"
                : "The previous plist could not be restored, " +
                  "so the replaced service was not bootstrapped",
            ),
          );
        }
      }
      const rollbackError = rollbackErrors.length === 0
        ? undefined
        : new AggregateError(rollbackErrors, "LaunchAgent rollback failed");
      throw new LaunchAgentOperationError("install", error, rollbackError);
    }
  }

  /**
   * Boot out a service and remove its plist, restoring the service if removal
   * fails. `resetDisabled` also clears launchctl's persistent disabled state,
   * which otherwise outlives the plist and blocks a future install of the
   * same label. A missing plist with `ignoreMissing: false` throws
   * `Deno.errors.NotFound`; other pre-flight failures are thrown as-is.
   */
  async uninstall(label: string, options: UninstallOptions = {}): Promise<UninstallResult> {
    const path = this.agentPath(label);
    const previous = await this.#readIfPresent(path);
    if (previous === undefined && options.ignoreMissing === false) {
      throw new Deno.errors.NotFound(`LaunchAgent plist does not exist: ${path}`);
    }

    const wasLoaded = await this.isLoaded(label);
    let bootedOut = false;
    try {
      if (wasLoaded) {
        await this.bootout(label);
        bootedOut = true;
      }
      if (options.resetDisabled === true) await this.enable(label);
      const removed = await this.remove(label, options);
      return { path, wasLoaded, removed };
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      if (bootedOut && previous !== undefined) {
        try {
          await this.bootstrap(label);
        } catch (caught) {
          rollbackErrors.push(caught);
        }
      }
      const rollbackError = rollbackErrors.length === 0
        ? undefined
        : new AggregateError(rollbackErrors, "LaunchAgent rollback failed");
      throw new LaunchAgentOperationError("uninstall", error, rollbackError);
    }
  }
}
