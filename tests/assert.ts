function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Structural equality over primitives, arrays, and plain objects. Key order
 * is irrelevant, and a key explicitly set to undefined differs from an
 * absent key. Other object kinds compare by identity.
 */
function deepEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEquals(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    return deepEquals(aKeys, bKeys) && aKeys.every((key) => deepEquals(a[key], b[key]));
  }
  return false;
}

export function assert(condition: unknown, message = "Assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertEquals<T>(actual: T, expected: T): void {
  if (!deepEquals(actual, expected)) {
    throw new Error(
      `Expected ${Deno.inspect(expected, { depth: 8 })}, received ${
        Deno.inspect(actual, { depth: 8 })
      }`,
    );
  }
}

export function assertIncludes(actual: string, expected: string): void {
  if (!actual.includes(expected)) {
    throw new Error(`Expected string to include ${JSON.stringify(expected)}:\n${actual}`);
  }
}

export async function assertRejects<E extends Error>(
  operation: () => Promise<unknown>,
  errorClass: abstract new (...args: never[]) => E,
): Promise<E> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof errorClass) return error;
    throw new Error(`Expected ${errorClass.name}, received ${String(error)}`);
  }
  throw new Error(`Expected ${errorClass.name}, but the promise resolved`);
}

export function assertThrows<E extends Error>(
  operation: () => unknown,
  errorClass: abstract new (...args: never[]) => E,
): E {
  try {
    operation();
  } catch (error) {
    if (error instanceof errorClass) return error;
    throw new Error(`Expected ${errorClass.name}, received ${String(error)}`);
  }
  throw new Error(`Expected ${errorClass.name}, but no error was thrown`);
}
