import { describe, it } from "@std/testing/bdd";
import {
  defineLaunchAgent,
  LaunchAgentValidationError,
  renderLaunchAgent,
  toLaunchdPlist,
  validateLaunchAgent,
} from "../mod.ts";
import type { LaunchAgentConfig } from "../mod.ts";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";

describe("rendering", () => {
  it("renders an idiomatic definition as a complete launchd plist", () => {
    const config: LaunchAgentConfig = {
      label: "dev.example.backup",
      program: "/usr/bin/rsync",
      programArguments: ["/usr/bin/rsync", "-a", "/Users/me/source/", "/Volumes/Backup/"],
      environment: { PATH: "/usr/bin:/bin", MESSAGE: "one & two" },
      workingDirectory: "/Users/me",
      standardOutPath: "/Users/me/Library/Logs/backup.log",
      standardErrorPath: "/Users/me/Library/Logs/backup.error.log",
      startCalendarInterval: [
        { weekday: 1, hour: 9, minute: 15 },
        { weekday: 5, hour: 17, minute: 30 },
      ],
      processType: "Background",
    };

    const xml = renderLaunchAgent(config);
    assertStringIncludes(xml, "<!DOCTYPE plist PUBLIC");
    assertStringIncludes(xml, "<key>Label</key>\n    <string>dev.example.backup</string>");
    assertStringIncludes(xml, "<string>one &amp; two</string>");
    assertStringIncludes(xml, "<key>StartCalendarInterval</key>\n    <array>");
    assertStringIncludes(xml, "<key>ProcessType</key>\n    <string>Background</string>");
    assertEquals(xml.endsWith("\n"), true);
  });

  it("maps nested launchd structures without mutating the input", () => {
    const config: LaunchAgentConfig = {
      label: "dev.example.worker",
      programArguments: ["/usr/local/bin/worker"],
      keepAlive: {
        crashed: true,
        pathState: { "/tmp/worker.enabled": true },
      },
      machServices: {
        "dev.example.worker": { resetAtClose: true },
      },
      softResourceLimits: { numberOfFiles: 512 },
      extra: { Debug: true },
    };

    const plist = toLaunchdPlist(config);
    assertEquals(plist, {
      Label: "dev.example.worker",
      ProgramArguments: ["/usr/local/bin/worker"],
      KeepAlive: {
        Crashed: true,
        PathState: { "/tmp/worker.enabled": true },
      },
      SoftResourceLimits: { NumberOfFiles: 512 },
      MachServices: {
        "dev.example.worker": { ResetAtClose: true },
      },
      Debug: true,
    });
    assertEquals("Label" in (config.extra ?? {}), false);
  });

  it("escapes XML in keys and values and renders empty collections", () => {
    const xml = renderLaunchAgent({
      label: "dev.example.escape",
      program: "/usr/bin/true",
      environment: { 'A&B<C>"D': 'x < y > z & "q"' },
      extra: { EmptyArray: [], EmptyDict: {} },
    });

    assertStringIncludes(xml, "<key>A&amp;B&lt;C&gt;&quot;D</key>");
    assertStringIncludes(xml, "<string>x &lt; y &gt; z &amp; &quot;q&quot;</string>");
    assertStringIncludes(xml, "<array/>");
    assertStringIncludes(xml, "<dict/>");
  });

  it("is deterministic across insertion orders", () => {
    const first = renderLaunchAgent({
      label: "dev.example.sorted",
      program: "/usr/bin/true",
      environment: { B: "2", A: "1" },
      extra: { Zeta: true, Alpha: { Y: 1, X: 2 } },
    });
    const second = renderLaunchAgent({
      label: "dev.example.sorted",
      extra: { Alpha: { X: 2, Y: 1 }, Zeta: true },
      environment: { A: "1", B: "2" },
      program: "/usr/bin/true",
    });

    assertEquals(first, second);
    assertStringIncludes(first, "<key>Alpha</key>");
  });

  it("renders umask as a decimal integer or an octal string", () => {
    const base = { label: "dev.example.umask", program: "/usr/bin/true" } as const;

    assertStringIncludes(renderLaunchAgent({ ...base, umask: 18 }), "<integer>18</integer>");
    assertStringIncludes(renderLaunchAgent({ ...base, umask: "022" }), "<string>022</string>");
    assertThrows(() => renderLaunchAgent({ ...base, umask: "22" }), LaunchAgentValidationError);
    assertThrows(() => renderLaunchAgent({ ...base, umask: 512 }), LaunchAgentValidationError);
  });
});

describe("validation", () => {
  it("reports multiple actionable paths", () => {
    const error = assertThrows(
      () =>
        renderLaunchAgent({
          label: "../bad label",
          program: "relative/program",
          programArguments: [] as unknown as [string],
          startInterval: 0,
          startCalendarInterval: { hour: 25 },
          standardOutPath: "~/agent.log",
        }),
      LaunchAgentValidationError,
    );

    const paths = error.issues.map((issue) => issue.path);
    assertEquals(paths.includes("label"), true);
    assertEquals(paths.includes("program"), true);
    assertEquals(paths.includes("programArguments"), true);
    assertEquals(paths.includes("startInterval"), true);
    assertEquals(paths.includes("startCalendarInterval.hour"), true);
    assertEquals(paths.includes("standardOutPath"), true);
  });

  it("enforces boundary values", () => {
    const base = { label: "dev.example.bounds", program: "/usr/bin/true" } as const;
    const rejected: [string, LaunchAgentConfig, string][] = [
      ["long label", { ...base, label: "a".repeat(250) }, "label"],
      [
        "weekday above 7",
        { ...base, startCalendarInterval: { weekday: 8 } },
        "startCalendarInterval.weekday",
      ],
      [
        "month zero",
        { ...base, startCalendarInterval: { month: 0 } },
        "startCalendarInterval.month",
      ],
      ["control character", { ...base, environment: { A: "\u0001" } }, "environment.A"],
      ["lone surrogate", { ...base, environment: { A: "\ud800" } }, "environment.A"],
    ];
    for (const [name, config, path] of rejected) {
      const error = assertThrows(() => renderLaunchAgent(config), LaunchAgentValidationError);
      assert(
        error.issues.some((issue) => issue.path === path),
        `${name}: ${Deno.inspect(error.issues)}`,
      );
    }

    const xml = renderLaunchAgent({
      ...base,
      label: "a".repeat(249),
      exitTimeOut: 0,
      startCalendarInterval: { weekday: 7 },
      environment: { EMOJI: "🚀" },
    });
    assertStringIncludes(xml, "<string>🚀</string>");
    assertStringIncludes(xml, "<integer>0</integer>");
  });

  it("defineLaunchAgent validates and returns the definition unchanged", () => {
    const config = { label: "dev.example.defined", program: "/usr/bin/true" } as const;
    assert(defineLaunchAgent(config) === config);
    assertThrows(
      () => defineLaunchAgent({ label: "bad label", program: "relative" }),
      LaunchAgentValidationError,
    );
  });

  it("validateLaunchAgent narrows unknown input", () => {
    const parsed: unknown = JSON.parse(
      '{"label":"dev.example.json","program":"/usr/bin/true"}',
    );
    validateLaunchAgent(parsed);
    assertEquals(parsed.label, "dev.example.json");

    assertThrows(() => validateLaunchAgent({ label: 42 }), LaunchAgentValidationError);
    assertThrows(() => validateLaunchAgent("not a config"), LaunchAgentValidationError);
  });

  it("rejects extra keys that override modeled keys", () => {
    const error = assertThrows(
      () =>
        renderLaunchAgent({
          label: "dev.example.safe",
          program: "/usr/bin/true",
          extra: { Label: "dev.example.unsafe" },
        }),
      LaunchAgentValidationError,
    );

    assertEquals(error.issues[0].path, "extra.Label");
  });
});
