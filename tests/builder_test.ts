import {
  defineLaunchAgent,
  launchAgent,
  LaunchAgentBuilder,
  LaunchAgentValidationError,
  renderLaunchAgent,
  validateLaunchAgent,
} from "../mod.ts";
import type { CalendarInterval, LaunchAgentConfig, LaunchAgentOptions } from "../mod.ts";
import { assert, assertEquals, assertThrows } from "./assert.ts";

// Drift tripwire: every LaunchAgentOptions field except label (set at
// construction, changed via relabel) must have a same-named builder method.
// Adding a field to types.ts breaks `deno task check` here until a setter
// exists.
type MissingSetters = Exclude<
  Exclude<keyof LaunchAgentOptions, "label">,
  keyof LaunchAgentBuilder
>;
const _exhaustive: MissingSetters extends never ? true : MissingSetters = true;

// Compile-time gates; never invoked. `deno task check` fails if the
// type-state stops rejecting these.
export function _compileTimeGates() {
  // @ts-expect-error build() requires program() or programArguments() first.
  launchAgent("dev.example.gate").build();
  // @ts-expect-error addArguments() requires program() or programArguments() first.
  launchAgent("dev.example.gate").addArguments("-v");
  // @ts-expect-error daily() requires an hour.
  launchAgent("dev.example.gate").daily();
}

Deno.test("builds a definition equal to the hand-written literal, field by field", () => {
  const viaBuilder = launchAgent("dev.example.full")
    .program("/usr/bin/true")
    .programArguments(["/usr/bin/true", "-v"])
    .runAtLoad()
    .keepAlive({ successfulExit: false })
    .disabled(false)
    .workingDirectory("/tmp")
    .environment({ PATH: "/usr/bin:/bin" })
    .standardInPath("/dev/null")
    .standardOutPath("/tmp/out.log")
    .standardErrorPath("/tmp/err.log")
    .watchPaths(["/tmp/watched"])
    .queueDirectories(["/tmp/queue"])
    .startOnMount()
    .startInterval(300)
    .startCalendarInterval({ hour: 1 })
    .processType("Background")
    .throttleInterval(10)
    .exitTimeOut(5)
    .nice(5)
    .umask("022")
    .enableGlobbing(false)
    .enableTransactions()
    .enablePressuredExit()
    .abandonProcessGroup()
    .lowPriorityIO()
    .lowPriorityBackgroundIO()
    .materializeDatalessFiles()
    .launchOnlyOnce()
    .sessionCreate()
    .legacyTimers()
    .sessionTypes("Aqua")
    .associatedBundleIdentifiers("dev.example.app")
    .softResourceLimits({ numberOfFiles: 256 })
    .hardResourceLimits({ numberOfFiles: 512 })
    .machServices({ "dev.example.svc": true })
    .extra({ Debug: true })
    .build();

  const literal = defineLaunchAgent({
    label: "dev.example.full",
    program: "/usr/bin/true",
    programArguments: ["/usr/bin/true", "-v"],
    runAtLoad: true,
    keepAlive: { successfulExit: false },
    disabled: false,
    workingDirectory: "/tmp",
    environment: { PATH: "/usr/bin:/bin" },
    standardInPath: "/dev/null",
    standardOutPath: "/tmp/out.log",
    standardErrorPath: "/tmp/err.log",
    watchPaths: ["/tmp/watched"],
    queueDirectories: ["/tmp/queue"],
    startOnMount: true,
    startInterval: 300,
    startCalendarInterval: { hour: 1 },
    processType: "Background",
    throttleInterval: 10,
    exitTimeOut: 5,
    nice: 5,
    umask: "022",
    enableGlobbing: false,
    enableTransactions: true,
    enablePressuredExit: true,
    abandonProcessGroup: true,
    lowPriorityIO: true,
    lowPriorityBackgroundIO: true,
    materializeDatalessFiles: true,
    launchOnlyOnce: true,
    sessionCreate: true,
    legacyTimers: true,
    sessionTypes: "Aqua",
    associatedBundleIdentifiers: "dev.example.app",
    softResourceLimits: { numberOfFiles: 256 },
    hardResourceLimits: { numberOfFiles: 512 },
    machServices: { "dev.example.svc": true },
    extra: { Debug: true },
  });

  assertEquals(viaBuilder, literal as LaunchAgentConfig);
  assertEquals(renderLaunchAgent(viaBuilder), renderLaunchAgent(literal));
});

Deno.test("field-named methods replace the whole field, last call wins", () => {
  const config = launchAgent("dev.example.replace")
    .programArguments(["/bin/a"])
    .programArguments(["/bin/b", "-x"])
    .environment({ A: "1" })
    .environment({ B: "2" })
    .watchPaths(["/tmp/one"])
    .watchPaths(["/tmp/two"])
    .queueDirectories(["/tmp/q1"])
    .queueDirectories(["/tmp/q2"])
    .startCalendarInterval({ hour: 1 })
    .startCalendarInterval([{ hour: 2 }, { hour: 3 }])
    .sessionTypes(["Aqua", "Background"])
    .sessionTypes("Background")
    .associatedBundleIdentifiers(["a.b", "c.d"])
    .associatedBundleIdentifiers("e.f")
    .softResourceLimits({ cpu: 60 })
    .softResourceLimits({ numberOfFiles: 64 })
    .hardResourceLimits({ cpu: 90 })
    .hardResourceLimits({ numberOfFiles: 128 })
    .machServices({ "dev.example.a": true })
    .machServices({ "dev.example.b": true })
    .extra({ One: 1 })
    .extra({ Two: 2 })
    .keepAlive({ crashed: true })
    .keepAlive(false)
    .build();

  assertEquals(config, {
    label: "dev.example.replace",
    programArguments: ["/bin/b", "-x"],
    environment: { B: "2" },
    watchPaths: ["/tmp/two"],
    queueDirectories: ["/tmp/q2"],
    startCalendarInterval: [{ hour: 2 }, { hour: 3 }],
    sessionTypes: "Background",
    associatedBundleIdentifiers: "e.f",
    softResourceLimits: { numberOfFiles: 64 },
    hardResourceLimits: { numberOfFiles: 128 },
    machServices: { "dev.example.b": true },
    extra: { Two: 2 },
    keepAlive: false,
  });
});

Deno.test("add* methods accumulate in call order without filtering", () => {
  const config = launchAgent("dev.example.accumulate")
    .program("/usr/bin/worker")
    .addArguments("-v")
    .addArguments("--once", "--once")
    .addEnvironment("A", "1")
    .addEnvironment({ B: "2", A: "3" })
    .addWatchPaths("/tmp/one")
    .addWatchPaths("/tmp/two", "/tmp/one")
    .addQueueDirectories("/tmp/q1")
    .addQueueDirectories("/tmp/q2")
    .addCalendarIntervals({ hour: 1 })
    .addCalendarIntervals({ hour: 2, minute: 15 })
    .addMachService("dev.example.svc")
    .addMachService("dev.example.other", { resetAtClose: true })
    .addMachService("dev.example.svc", { hideUntilCheckIn: true })
    .addExtra({ One: 1 })
    .addExtra({ Two: 2, One: 3 })
    .build();

  assertEquals(config, {
    label: "dev.example.accumulate",
    program: "/usr/bin/worker",
    // addArguments initialized argv from [program], launchd's implicit argv.
    programArguments: ["/usr/bin/worker", "-v", "--once", "--once"],
    environment: { A: "3", B: "2" },
    watchPaths: ["/tmp/one", "/tmp/two", "/tmp/one"],
    queueDirectories: ["/tmp/q1", "/tmp/q2"],
    startCalendarInterval: [{ hour: 1 }, { hour: 2, minute: 15 }],
    machServices: {
      "dev.example.svc": { hideUntilCheckIn: true },
      "dev.example.other": { resetAtClose: true },
    },
    extra: { One: 3, Two: 2 },
  });
});

Deno.test("addCalendarIntervals normalizes a single stored interval to array form", () => {
  const config = launchAgent("dev.example.normalize")
    .program("/usr/bin/true")
    .startCalendarInterval({ hour: 6 })
    .addCalendarIntervals({ hour: 18 })
    .build();

  assertEquals(config.startCalendarInterval, [{ hour: 6 }, { hour: 18 }]);
});

Deno.test("sugar desugars onto exactly one modeled field", () => {
  const daily = launchAgent("dev.example.daily")
    .program("/usr/bin/true")
    .daily(2, 30)
    .build();
  assertEquals(daily.startCalendarInterval, { hour: 2, minute: 30 });

  const twice = launchAgent("dev.example.twice")
    .program("/usr/bin/true")
    .daily(2, 30)
    .daily(14)
    .build();
  assertEquals(twice.startCalendarInterval, [
    { hour: 2, minute: 30 },
    { hour: 14, minute: 0 },
  ]);

  const weekly = launchAgent("dev.example.weekly")
    .program("/usr/bin/true")
    .weekly([1, 5], 9)
    .build();
  assertEquals(weekly.startCalendarInterval, [
    { weekday: 1, hour: 9, minute: 0 },
    { weekday: 5, hour: 9, minute: 0 },
  ]);

  const interval = launchAgent("dev.example.every")
    .program("/usr/bin/true")
    .every(3600)
    .build();
  assertEquals(interval.startInterval, 3600);

  const sharedLogs = launchAgent("dev.example.logs")
    .program("/usr/bin/true")
    .logsTo("/tmp/agent.log")
    .build();
  assertEquals(sharedLogs.standardOutPath, "/tmp/agent.log");
  assertEquals(sharedLogs.standardErrorPath, "/tmp/agent.log");

  const splitLogs = launchAgent("dev.example.splitlogs")
    .program("/usr/bin/true")
    .logsTo("/tmp/out.log", "/tmp/err.log")
    .build();
  assertEquals(splitLogs.standardOutPath, "/tmp/out.log");
  assertEquals(splitLogs.standardErrorPath, "/tmp/err.log");
});

Deno.test("build() reports the validator's own issues, unfiltered", () => {
  const builder = launchAgent("bad label")
    .program("relative/program")
    .startCalendarInterval({ hour: 25 })
    .addExtra({ Label: "dev.example.override" });

  const fromBuilder = assertThrows(() => builder.build(), LaunchAgentValidationError);

  const literal = {
    label: "bad label",
    program: "relative/program",
    startCalendarInterval: { hour: 25 },
    extra: { Label: "dev.example.override" },
  };
  const fromLiteral = assertThrows(
    () => validateLaunchAgent(literal),
    LaunchAgentValidationError,
  );

  assertEquals(
    fromBuilder.issues.map(({ path }) => path).sort(),
    fromLiteral.issues.map(({ path }) => path).sort(),
  );
});

Deno.test("accumulators pass unknown keys through to the validator", () => {
  const bogus = { hour: 1, bogus: 2 } as CalendarInterval;
  const error = assertThrows(
    () =>
      launchAgent("dev.example.bogus")
        .program("/usr/bin/true")
        .addCalendarIntervals(bogus)
        .build(),
    LaunchAgentValidationError,
  );
  assert(error.issues.some(({ path }) => path === "startCalendarInterval.bogus"));
});

Deno.test("builders are frozen, immutable templates", () => {
  const base = launchAgent("dev.example.base")
    .daily(2, 30)
    .processType("Background");
  assert(Object.isFrozen(base));

  const first = base
    .relabel("dev.example.base.documents")
    .programArguments(["/usr/bin/rsync", "-a", "/Users/me/Documents/", "/Volumes/Backup/"]);
  const second = base
    .relabel("dev.example.base.photos")
    .programArguments(["/usr/bin/rsync", "-a", "/Users/me/Photos/", "/Volumes/Backup/"]);

  assertEquals(first.build().label, "dev.example.base.documents");
  assertEquals(second.build().label, "dev.example.base.photos");
  assertEquals(second.build().programArguments?.[2], "/Users/me/Photos/");

  // Deriving from the base again proves earlier specialization never mutated it.
  const again = base
    .relabel("dev.example.base.documents")
    .programArguments(["/usr/bin/rsync", "-a", "/Users/me/Documents/", "/Volumes/Backup/"]);
  assertEquals(again.build(), first.build());
});

Deno.test("from() seeds a builder that round-trips and extends a definition", () => {
  const original = defineLaunchAgent({
    label: "dev.example.seed",
    program: "/usr/bin/true",
    runAtLoad: true,
  });

  assertEquals(LaunchAgentBuilder.from(original).build(), original as LaunchAgentConfig);

  const extended = LaunchAgentBuilder.from(original).daily(3).build();
  assertEquals(extended.startCalendarInterval, { hour: 3, minute: 0 });
  assertEquals("startCalendarInterval" in original, false);
});

Deno.test("a cast-defeated compile gate still fails at build() via the validator", () => {
  const forced = launchAgent(
    "dev.example.forced",
  ) as unknown as LaunchAgentBuilder<"has-program">;
  const error = assertThrows(() => forced.build(), LaunchAgentValidationError);
  assert(error.issues.some(({ message }) => message.includes("required")));
});
