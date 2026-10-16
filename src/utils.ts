import { JSONObject } from '@lumino/coreutils';

/**
 * Whether a pattern contains glob wildcards.
 */
export function isGlob(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

/**
 * Convert a glob pattern (`*` and `?` wildcards) into a regular expression.
 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split('*')
    .map(chunk =>
      chunk
        .split('?')
        .map(part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
        .join('.')
    )
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Compile glob patterns into a test for values matching any of them.
 */
export function globMatcher(
  patterns: readonly string[]
): (value: string) => boolean {
  const regexps = patterns.map(globToRegExp);
  return value => regexps.some(regexp => regexp.test(value));
}

/**
 * Normalize the `args` value received from an agent.
 *
 * LLM clients often send nested objects as JSON strings, so both are
 * accepted.
 */
export function parseArgs(
  args: unknown
): { args: JSONObject } | { error: string } {
  if (args === undefined || args === null || args === '') {
    return { args: {} };
  }
  if (typeof args === 'string') {
    try {
      return parseArgs(JSON.parse(args));
    } catch (error) {
      return { error: `"args" is not valid JSON: ${(error as Error).message}` };
    }
  }
  if (typeof args === 'object' && !Array.isArray(args)) {
    return { args: args as JSONObject };
  }
  return { error: '"args" must be a JSON object' };
}

/**
 * Run a function and return a fallback if it throws.
 */
export function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * The message of an error-like value, or of a list of them such as the
 * validation errors the setting registry rejects with.
 */
export function errorMessage(error: unknown): string {
  if (Array.isArray(error)) {
    return error
      .map(item => `${item?.instancePath ?? ''} ${errorMessage(item)}`.trim())
      .join('; ');
  }
  if (error instanceof Error) {
    return error.message || error.name;
  }
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && message) {
    return message;
  }
  return safely(() => String(error), 'Unknown error');
}

/**
 * Resolve with `fallback` if the promise does not settle within `ms`.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>(resolve => {
      timer = setTimeout(() => resolve(fallback), ms);
    })
  ]).finally(() => clearTimeout(timer));
}
