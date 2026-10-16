import {
  errorMessage,
  globMatcher,
  globToRegExp,
  isGlob,
  parseArgs,
  safely,
  withTimeout
} from '../utils';

describe('isGlob', () => {
  it('detects * and ? wildcards', () => {
    expect(isGlob('notebook:*')).toBe(true);
    expect(isGlob('notebook:run-?ell')).toBe(true);
  });

  it('treats other characters as literal', () => {
    expect(isGlob('notebook:run-cell')).toBe(false);
    expect(isGlob('[abc]')).toBe(false);
    expect(isGlob('')).toBe(false);
  });
});

describe('globToRegExp', () => {
  it('matches any sequence with *, including an empty one', () => {
    const regexp = globToRegExp('notebook:*');
    expect(regexp.test('notebook:run-cell')).toBe(true);
    expect(regexp.test('notebook:')).toBe(true);
    expect(regexp.test('console:create')).toBe(false);
    expect(globToRegExp('*:delete-*').test('filebrowser:delete-file')).toBe(
      true
    );
  });

  it('matches exactly one character with ?', () => {
    const regexp = globToRegExp('notebook:run-?ell');
    expect(regexp.test('notebook:run-cell')).toBe(true);
    expect(regexp.test('notebook:run-ell')).toBe(false);
    expect(regexp.test('notebook:run-xxell')).toBe(false);
  });

  it('escapes regular expression characters', () => {
    expect(globToRegExp('a.b').test('axb')).toBe(false);
    expect(globToRegExp('a+').test('aa')).toBe(false);
    expect(globToRegExp('[ab]').test('a')).toBe(false);
    expect(globToRegExp('^a$|b{2}\\').test('^a$|b{2}\\')).toBe(true);
    expect(globToRegExp('x.*').test('x.anything')).toBe(true);
    expect(globToRegExp('x.*').test('xyz')).toBe(false);
  });

  it('matches the whole string, case-sensitive', () => {
    expect(globToRegExp('notebook').test('notebook:run-cell')).toBe(false);
    expect(globToRegExp('Notebook:*').test('notebook:run')).toBe(false);
  });
});

describe('globMatcher', () => {
  it('matches nothing without patterns', () => {
    expect(globMatcher([])('notebook:run-cell')).toBe(false);
  });

  it('matches values that match one pattern', () => {
    const matches = globMatcher([
      'console:*',
      'notebook:run-?ell',
      'docmanager:open'
    ]);
    expect(matches('notebook:run-cell')).toBe(true);
    expect(matches('docmanager:open')).toBe(true);
    expect(matches('console:create')).toBe(true);
    expect(matches('docmanager:open-browser-tab')).toBe(false);
  });
});

describe('parseArgs', () => {
  it('returns empty args for missing values', () => {
    for (const value of [undefined, null, '', 'null', '""']) {
      expect(parseArgs(value)).toEqual({ args: {} });
    }
  });

  it('returns objects as they are', () => {
    const args = { path: 'a.ipynb', nested: { x: [1, 2] } };
    expect((parseArgs(args) as { args: unknown }).args).toBe(args);
  });

  it('parses JSON strings, also encoded twice', () => {
    expect(parseArgs('{"path": "a.ipynb", "n": 1}')).toEqual({
      args: { path: 'a.ipynb', n: 1 }
    });
    expect(parseArgs(JSON.stringify(JSON.stringify({ a: 1 })))).toEqual({
      args: { a: 1 }
    });
  });

  it('reports invalid JSON', () => {
    const parsed = parseArgs('{path: a.ipynb}');
    expect('error' in parsed && parsed.error).toMatch(
      /^"args" is not valid JSON: /
    );
  });

  it('refuses values that are not objects', () => {
    const error = { error: '"args" must be a JSON object' };
    for (const value of [[1, 2], '[1, 2]', 42, '42', true]) {
      expect(parseArgs(value)).toEqual(error);
    }
  });
});

describe('safely', () => {
  it('returns the value of the function, or the fallback if it throws', () => {
    expect(safely(() => 42, 0)).toBe(42);
    expect(
      safely(() => {
        throw new Error('boom');
      }, 'fallback')
    ).toBe('fallback');
  });
});

describe('errorMessage', () => {
  it('returns the message of an error, or its name', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage(new RangeError(''))).toBe('RangeError');
  });

  it('returns the message of an error-like object', () => {
    expect(errorMessage({ message: 'boom' })).toBe('boom');
  });

  it('joins a list of errors, with the location of each one', () => {
    expect(
      errorMessage([
        { instancePath: '/executionTimeout', message: 'must be <= 3600' },
        { instancePath: '', message: 'must be object' },
        new Error('boom')
      ])
    ).toBe('/executionTimeout must be <= 3600; must be object; boom');
  });

  it('converts other values to strings', () => {
    expect(errorMessage('plain text')).toBe('plain text');
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage({ message: 42 })).toBe('[object Object]');
  });

  it('returns a fallback when the conversion throws', () => {
    expect(errorMessage(Object.create(null))).toBe('Unknown error');
  });
});

describe('withTimeout', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves with the value of a fast promise', async () => {
    await expect(withTimeout(Promise.resolve(1), 1000, 2)).resolves.toBe(1);
    await expect(withTimeout(Promise.resolve(1), 0, 2)).resolves.toBe(1);
  });

  it('resolves with the fallback after the timeout', async () => {
    jest.useFakeTimers();
    const result = withTimeout(new Promise<string>(() => undefined), 500, 'fb');
    await jest.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toBe('fb');
  });

  it('rejects when the promise rejects first', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('boom')), 1000, 'fb')
    ).rejects.toThrow('boom');
  });

  it('clears its timer once settled', async () => {
    jest.useFakeTimers();
    const result = withTimeout(Promise.resolve(1), 60000, 2);
    await expect(result).resolves.toBe(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
