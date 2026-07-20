import { describe, it } from "@std/testing/bdd";
import {
  LaunchAgentFileExistsError,
  LaunchAgentOperationError,
  LaunchAgents,
  LaunchAgentValidationError,
  LaunchctlError,
  renderLaunchAgent,
} from "../mod.ts";
import type { CommandResult, CommandRunner, CommandRunOptions, LaunchAgentConfig } from "../mod.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";

const success: CommandResult = { code: 0, stdout: "", stderr: "" };
const notFound: CommandResult = {
  code: 113,
  stdout: "",
  stderr: "Could not find service",
};
const ioFailure: CommandResult = { code: 5, stdout: "", stderr: "Input/output error" };

class FakeRunner implements CommandRunner {
  readonly calls: {
    command: string;
    args: readonly string[];
    options?: CommandRunOptions;
  }[] = [];
  readonly #results: CommandResult[];
  readonly #onCall?: (args: readonly string[]) => void;

  constructor(results: CommandResult[] = [], onCall?: (args: readonly string[]) => void) {
    this.#results = [...results];
    this.#onCall = onCall;
  }

  run(
    command: string,
    args: readonly string[],
    options?: CommandRunOptions,
  ): Promise<CommandResult> {
    this.calls.push(
      options === undefined ? { command, args: [...args] } : { command, args: [...args], options },
    );
    const next = this.#results.shift();
    if (next === undefined) {
      throw new Error(`FakeRunner has no scripted result for: ${command} ${args.join(" ")}`);
    }
    this.#onCall?.(args);
    return Promise.resolve(next);
  }
}

function definition(program = "/usr/bin/true"): LaunchAgentConfig {
  return {
    label: "dev.example.test-agent",
    program,
    programArguments: [program],
    runAtLoad: true,
  };
}

const TEST_TMP = new URL("./.tmp/", import.meta.url).pathname;

async function withTempDirectory(
  test: (directory: string) => Promise<void>,
): Promise<void> {
  await Deno.mkdir(TEST_TMP, { recursive: true });
  const directory = await Deno.makeTempDir({
    dir: TEST_TMP,
    prefix: "launch-agents-test-",
  });
  try {
    await test(directory);
  } finally {
    await Deno.chmod(directory, 0o700);
    await Deno.remove(directory, { recursive: true });
  }
}

describe("write() and remove()", () => {
  it("write is atomic, idempotent, and protects different files", async () => {
    await withTempDirectory(async (directory) => {
      const runner = new FakeRunner();
      const agents = new LaunchAgents({ directory, uid: 501, runner });
      const config = definition();

      assertEquals(await agents.write(config), {
        path: `${directory}/dev.example.test-agent.plist`,
        created: true,
        changed: true,
      });
      assertEquals(await agents.write(config), {
        path: `${directory}/dev.example.test-agent.plist`,
        created: false,
        changed: false,
      });
      await assertRejects(
        () => agents.write(definition("/usr/bin/false")),
        LaunchAgentFileExistsError,
      );
      assertEquals(
        await Deno.readTextFile(agents.agentPath(config.label)),
        renderLaunchAgent(config),
      );
      assertEquals(runner.calls.length, 0);
    });
  });

  it("remove deletes the plist and reports absence", async () => {
    await withTempDirectory(async (directory) => {
      const agents = new LaunchAgents({ directory, uid: 501, runner: new FakeRunner() });
      await agents.write(definition());

      assertEquals(await agents.remove(definition().label), true);
      assertEquals(await agents.remove(definition().label), false);
      await assertRejects(
        () => agents.remove(definition().label, { ignoreMissing: false }),
        Deno.errors.NotFound,
      );
    });
  });
});

describe("install()", () => {
  it("uses modern GUI domain targets", async () => {
    await withTempDirectory(async (directory) => {
      const runner = new FakeRunner([notFound, success]);
      const agents = new LaunchAgents({ directory, uid: 501, runner });

      const result = await agents.install(definition());
      assertEquals(result, {
        path: `${directory}/dev.example.test-agent.plist`,
        created: true,
        changed: true,
        wasLoaded: false,
        loaded: true,
      });
      assertEquals(runner.calls, [
        {
          command: "/bin/launchctl",
          args: ["print", "gui/501/dev.example.test-agent"],
        },
        {
          command: "/bin/launchctl",
          args: [
            "bootstrap",
            "gui/501",
            `${directory}/dev.example.test-agent.plist`,
          ],
        },
      ]);
    });
  });

  it("only writes the plist with load: false", async () => {
    await withTempDirectory(async (directory) => {
      const runner = new FakeRunner();
      const agents = new LaunchAgents({ directory, uid: 501, runner });

      assertEquals(await agents.install(definition(), { load: false }), {
        path: `${directory}/dev.example.test-agent.plist`,
        created: true,
        changed: true,
        wasLoaded: undefined,
        loaded: undefined,
      });
      assertEquals(runner.calls.length, 0);
    });
  });

  it("is a no-op for a loaded, unchanged agent", async () => {
    await withTempDirectory(async (directory) => {
      const runner = new FakeRunner([success]);
      const agents = new LaunchAgents({ directory, uid: 501, runner });
      await agents.write(definition());

      const result = await agents.install(definition());
      assertEquals(result, {
        path: `${directory}/dev.example.test-agent.plist`,
        created: false,
        changed: false,
        wasLoaded: true,
        loaded: true,
      });
      assertEquals(runner.calls.map(({ args }) => args[0]), ["print"]);
    });
  });

  it("leaves the old definition running with reloadLoaded: false", async () => {
    await withTempDirectory(async (directory) => {
      const runner = new FakeRunner([success]);
      const agents = new LaunchAgents({ directory, uid: 501, runner });
      await agents.write(definition());

      const replacement = definition("/usr/bin/false");
      const result = await agents.install(replacement, {
        overwrite: true,
        reloadLoaded: false,
      });
      assertEquals(result, {
        path: `${directory}/dev.example.test-agent.plist`,
        created: false,
        changed: true,
        wasLoaded: true,
        loaded: true,
      });
      assertEquals(runner.calls.map(({ args }) => args[0]), ["print"]);
      assertEquals(
        await Deno.readTextFile(agents.agentPath(replacement.label)),
        renderLaunchAgent(replacement),
      );
    });
  });

  it("refuses to replace a different file without overwrite", async () => {
    await withTempDirectory(async (directory) => {
      const runner = new FakeRunner();
      const agents = new LaunchAgents({ directory, uid: 501, runner });
      await agents.write(definition());

      await assertRejects(
        () => agents.install(definition("/usr/bin/false")),
        LaunchAgentFileExistsError,
      );
      assertEquals(runner.calls.length, 0);
    });
  });

  it("surfaces a raced creation as an unwrapped LaunchAgentFileExistsError", async () => {
    await withTempDirectory(async (directory) => {
      const agents = new LaunchAgents({
        directory,
        uid: 501,
        runner: new FakeRunner([notFound], (args) => {
          if (args[0] === "print") {
            Deno.writeTextFileSync(`${directory}/dev.example.test-agent.plist`, "raced");
          }
        }),
      });

      await assertRejects(() => agents.install(definition()), LaunchAgentFileExistsError);
      assertEquals(
        await Deno.readTextFile(agents.agentPath(definition().label)),
        "raced",
      );
    });
  });

  it("restores the previous plist and service after a failed reload", async () => {
    await withTempDirectory(async (directory) => {
      const runner = new FakeRunner([success, success, ioFailure, success]);
      const agents = new LaunchAgents({ directory, uid: 502, runner });
      const original = definition();
      await agents.write(original);

      const error = await assertRejects(
        () => agents.install(definition("/usr/bin/false"), { overwrite: true }),
        LaunchAgentOperationError,
      );

      assertEquals(error.rollbackError, undefined);
      assertEquals(
        await Deno.readTextFile(agents.agentPath(original.label)),
        renderLaunchAgent(original),
      );
      const path = `${directory}/dev.example.test-agent.plist`;
      assertEquals(runner.calls.map(({ args }) => args), [
        ["print", "gui/502/dev.example.test-agent"],
        ["bootout", "gui/502/dev.example.test-agent"],
        ["bootstrap", "gui/502", path],
        ["bootstrap", "gui/502", path],
      ]);
    });
  });

  it("does not re-bootstrap when the service was not loaded from this plist", async () => {
    await withTempDirectory(async (directory) => {
      const runner = new FakeRunner([success, success, ioFailure]);
      const agents = new LaunchAgents({ directory, uid: 501, runner });

      const error = await assertRejects(
        () => agents.install(definition()),
        LaunchAgentOperationError,
      );

      assert(error.rollbackError instanceof AggregateError);
      assertEquals(error.rollbackError.errors.length, 1);
      assert(String(error.rollbackError.errors[0]).includes("cannot be restored"));
      assertEquals(runner.calls.map(({ args }) => args[0]), ["print", "bootout", "bootstrap"]);
      await assertRejects(
        () => Deno.readTextFile(agents.agentPath(definition().label)),
        Deno.errors.NotFound,
      );
    });
  });

  it("does not re-bootstrap when the previous plist cannot be restored", async () => {
    await withTempDirectory(async (directory) => {
      const runner = new FakeRunner([success, success, ioFailure], (args) => {
        if (args[0] === "bootstrap") Deno.chmodSync(directory, 0o500);
      });
      const agents = new LaunchAgents({ directory, uid: 501, runner });
      const original = definition();
      await agents.write(original);
      const replacement = definition("/usr/bin/false");

      try {
        const error = await assertRejects(
          () => agents.install(replacement, { overwrite: true }),
          LaunchAgentOperationError,
        );

        assert(error.rollbackError instanceof AggregateError);
        assertEquals(error.rollbackError.errors.length, 2);
        assert(String(error.rollbackError.errors[1]).includes("could not be restored"));
        assertEquals(runner.calls.map(({ args }) => args[0]), ["print", "bootout", "bootstrap"]);
        assertEquals(
          await Deno.readTextFile(agents.agentPath(original.label)),
          renderLaunchAgent(replacement),
        );
      } finally {
        await Deno.chmod(directory, 0o700);
      }
    });
  });
});

describe("uninstall()", () => {
  it("boots out a loaded service and removes its plist", async () => {
    await withTempDirectory(async (directory) => {
      const runner = new FakeRunner([success, success]);
      const agents = new LaunchAgents({ directory, uid: 501, runner });
      await agents.write(definition());

      const result = await agents.uninstall(definition().label);
      assertEquals(result, {
        path: `${directory}/dev.example.test-agent.plist`,
        wasLoaded: true,
        removed: true,
      });
      assertEquals(runner.calls.map(({ args }) => args), [
        ["print", "gui/501/dev.example.test-agent"],
        ["bootout", "gui/501/dev.example.test-agent"],
      ]);
      await assertRejects(
        () => Deno.readTextFile(agents.agentPath(definition().label)),
        Deno.errors.NotFound,
      );
    });
  });

  it("tolerates a missing plist and unloaded service by default", async () => {
    await withTempDirectory(async (directory) => {
      const runner = new FakeRunner([notFound]);
      const agents = new LaunchAgents({ directory, uid: 501, runner });

      const result = await agents.uninstall(definition().label);
      assertEquals(result, {
        path: `${directory}/dev.example.test-agent.plist`,
        wasLoaded: false,
        removed: false,
      });
      assertEquals(runner.calls.map(({ args }) => args[0]), ["print"]);
    });
  });

  it("requires the plist to exist with ignoreMissing: false", async () => {
    await withTempDirectory(async (directory) => {
      const runner = new FakeRunner();
      const agents = new LaunchAgents({ directory, uid: 501, runner });

      await assertRejects(
        () => agents.uninstall(definition().label, { ignoreMissing: false }),
        Deno.errors.NotFound,
      );
      assertEquals(runner.calls.length, 0);
    });
  });

  it("clears the persistent disabled state with resetDisabled", async () => {
    await withTempDirectory(async (directory) => {
      const runner = new FakeRunner([notFound, success]);
      const agents = new LaunchAgents({ directory, uid: 501, runner });
      await agents.write(definition());

      const result = await agents.uninstall(definition().label, { resetDisabled: true });
      assertEquals(result, {
        path: `${directory}/dev.example.test-agent.plist`,
        wasLoaded: false,
        removed: true,
      });
      assertEquals(runner.calls.map(({ args }) => args), [
        ["print", "gui/501/dev.example.test-agent"],
        ["enable", "gui/501/dev.example.test-agent"],
      ]);
    });
  });

  it("restores the booted-out service when removal fails", async () => {
    await withTempDirectory(async (directory) => {
      const path = `${directory}/dev.example.test-agent.plist`;
      const runner = new FakeRunner([success, success, success], (args) => {
        if (args[0] === "bootout") Deno.removeSync(path);
      });
      const agents = new LaunchAgents({ directory, uid: 501, runner });
      await agents.write(definition());

      const error = await assertRejects(
        () => agents.uninstall(definition().label, { ignoreMissing: false }),
        LaunchAgentOperationError,
      );

      assertEquals(error.operation, "uninstall");
      assertEquals(error.rollbackError, undefined);
      assert(error.cause instanceof Deno.errors.NotFound);
      assertEquals(runner.calls.map(({ args }) => args[0]), ["print", "bootout", "bootstrap"]);
    });
  });

  it("reports a rollback double fault as an AggregateError", async () => {
    await withTempDirectory(async (directory) => {
      const path = `${directory}/dev.example.test-agent.plist`;
      const runner = new FakeRunner([success, success, ioFailure], (args) => {
        if (args[0] === "bootout") Deno.removeSync(path);
      });
      const agents = new LaunchAgents({ directory, uid: 501, runner });
      await agents.write(definition());

      const error = await assertRejects(
        () => agents.uninstall(definition().label, { ignoreMissing: false }),
        LaunchAgentOperationError,
      );

      assert(error.message.includes("rollback also failed"));
      assert(error.rollbackError instanceof AggregateError);
      assert(error.rollbackError.errors[0] instanceof LaunchctlError);
    });
  });
});

describe("launchctl helpers", () => {
  it("pass literal arguments without a shell", async () => {
    const runner = new FakeRunner([
      { code: 0, stdout: "4242\n", stderr: "" },
      { code: 0, stdout: "4343\n", stderr: "" },
      success,
      { code: 0, stdout: "diagnostic text", stderr: "" },
    ]);
    const agents = new LaunchAgents({ directory: "/nonexistent/agents", uid: 503, runner });

    assertEquals(await agents.start("dev.example.agent"), 4242);
    assertEquals(await agents.restart("dev.example.agent"), 4343);
    await agents.stop("dev.example.agent", "SIGINT");
    assertEquals(await agents.inspect("dev.example.agent"), "diagnostic text");

    assertEquals(runner.calls.map(({ args }) => args), [
      ["kickstart", "-p", "gui/503/dev.example.agent"],
      ["kickstart", "-kp", "gui/503/dev.example.agent"],
      ["kill", "SIGINT", "gui/503/dev.example.agent"],
      ["print", "gui/503/dev.example.agent"],
    ]);
    assert(runner.calls.every(({ command }) => command === "/bin/launchctl"));
  });

  it("target the configured domain for enable, disable, bootout, and bootstrap", async () => {
    const runner = new FakeRunner([success, success, success, success]);
    const agents = new LaunchAgents({ directory: "/nonexistent/agents", uid: 501, runner });

    await agents.enable("dev.example.agent");
    await agents.disable("dev.example.agent");
    await agents.bootout("dev.example.agent");
    await agents.bootstrap("dev.example.agent");

    assertEquals(runner.calls.map(({ args }) => args), [
      ["enable", "gui/501/dev.example.agent"],
      ["disable", "gui/501/dev.example.agent"],
      ["bootout", "gui/501/dev.example.agent"],
      ["bootstrap", "gui/501", "/nonexistent/agents/dev.example.agent.plist"],
    ]);
  });

  it("isLoaded distinguishes not-found from other launchctl failures", async () => {
    const runner = new FakeRunner([
      success,
      notFound,
      { code: 1, stdout: "", stderr: 'Could not find service "x" in domain for login' },
      { code: 1, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" },
    ]);
    const agents = new LaunchAgents({ directory: "/nonexistent/agents", uid: 501, runner });

    assertEquals(await agents.isLoaded("dev.example.agent"), true);
    assertEquals(await agents.isLoaded("dev.example.agent"), false);
    assertEquals(await agents.isLoaded("dev.example.agent"), false);
    await assertRejects(() => agents.isLoaded("dev.example.agent"), LaunchctlError);
  });

  it("inspect and kickstart failures preserve the launchctl invocation", async () => {
    const runner = new FakeRunner([
      ioFailure,
      { code: 0, stdout: "service spawned\n", stderr: "" },
    ]);
    const agents = new LaunchAgents({ directory: "/nonexistent/agents", uid: 501, runner });

    const inspectError = await assertRejects(
      () => agents.inspect("dev.example.agent"),
      LaunchctlError,
    );
    assertEquals(inspectError.result.command, [
      "/bin/launchctl",
      "print",
      "gui/501/dev.example.agent",
    ]);

    const pidError = await assertRejects(() => agents.start("dev.example.agent"), LaunchctlError);
    assert(pidError.message.includes("did not print a valid PID"));
  });

  it("stop validates the signal before invoking launchctl", async () => {
    const runner = new FakeRunner([success, success]);
    const agents = new LaunchAgents({ directory: "/nonexistent/agents", uid: 501, runner });

    await agents.stop("dev.example.agent");
    await agents.stop("dev.example.agent", "15");
    await assertRejects(() => agents.stop("dev.example.agent", "-9"), TypeError);

    assertEquals(runner.calls.map(({ args }) => args), [
      ["kill", "SIGTERM", "gui/501/dev.example.agent"],
      ["kill", "15", "gui/501/dev.example.agent"],
    ]);
  });

  it("a configured timeout passes an abort signal to the runner", async () => {
    const runner = new FakeRunner([success]);
    const agents = new LaunchAgents({
      directory: "/nonexistent/agents",
      uid: 501,
      runner,
      timeoutMillis: 5000,
    });

    await agents.enable("dev.example.agent");
    assert(runner.calls[0].options?.signal instanceof AbortSignal);
  });
});

describe("construction", () => {
  it("rejects malformed constructor options and labels", () => {
    const runner = new FakeRunner();
    const base = { directory: "/nonexistent/agents", uid: 501, runner };

    assertThrows(() => new LaunchAgents({ ...base, directory: "relative/dir" }), TypeError);
    assertThrows(() => new LaunchAgents({ ...base, directory: "/bad\0dir" }), TypeError);
    assertThrows(() => new LaunchAgents({ ...base, uid: -1 }), TypeError);
    assertThrows(() => new LaunchAgents({ ...base, uid: 1.5 }), TypeError);
    assertThrows(() => new LaunchAgents({ ...base, launchctlPath: "launchctl" }), TypeError);
    assertThrows(() => new LaunchAgents({ ...base, launchctlPath: "/bin/l\0" }), TypeError);
    assertThrows(() => new LaunchAgents({ ...base, timeoutMillis: 0 }), TypeError);
    assertThrows(() => new LaunchAgents({ ...base, timeoutMillis: 2.5 }), TypeError);

    const agents = new LaunchAgents({ ...base, domain: "user" });
    assertEquals(agents.serviceTarget("dev.example.agent"), "user/501/dev.example.agent");
    assertThrows(() => agents.agentPath("../evil"), LaunchAgentValidationError);
    assertThrows(() => agents.agentPath("a".repeat(250)), LaunchAgentValidationError);
    assertEquals(
      agents.agentPath("a".repeat(249)),
      `/nonexistent/agents/${"a".repeat(249)}.plist`,
    );
  });
});
