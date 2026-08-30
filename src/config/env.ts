/**
 * Loading `.env`, once, at process start.
 *
 * Nothing used to do this. Every command worked only if the operator ran
 * `set -a; . ./.env; set +a` first, and `npm run serve` -- the one thing this
 * project is meant to leave running -- degraded silently without it: no
 * `TMDB_API_KEY` meant the resolve pass was skipped with a `console.warn`
 * nobody reads, and no `AMC_API_KEY` meant `createAdapters` omitted the AMC
 * adapter entirely, so two venues stopped being swept without a single error.
 *
 * `process.loadEnvFile()` exists in Node 22 and would have done most of this,
 * but it *overrides* variables that are already set. That is the wrong way
 * round: a real deployment sets real variables, and a stale `.env` sitting
 * beside them must not win. So the merge is by hand.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** `KEY`, `_KEY`, `KEY_2` -- the shell's own rule for a variable name. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Parse the text of a `.env` file into key/value pairs. Pure: no file system,
 * no `process.env`.
 *
 * Rules, and why:
 *
 * - Blank lines and lines whose first non-space character is `#` are skipped.
 * - A leading `export ` is stripped, because `AGENTS.md` tells the operator to
 *   source this file with `set -a; . ./.env`, and a file written for that may
 *   well carry the prefix.
 * - Only the *first* `=` splits. A TMDB read token is a JWT and `=` inside a
 *   value is ordinary; splitting on each one would truncate the credential.
 * - A value wrapped in matching single or double quotes has them stripped and
 *   its interior left alone, including leading and trailing spaces. Unquoted
 *   values are trimmed at both ends.
 * - Inside double quotes, `\n`, `\r`, `\t` and `\\` are unescaped. Single
 *   quotes are literal, as in the shell.
 * - A `#` inside a value is *not* a comment. Trailing-comment stripping is the
 *   sort of helpfulness that turns a key containing `#` into a shorter key
 *   that still looks like a key and merely fails to authenticate -- plausible
 *   wrong data, which is the one thing this project refuses to ship.
 * - Anything else throws, naming the line number and nothing else. A `.env` is
 *   short and hand-edited, so a malformed line is an operator error worth
 *   stopping for; the line itself is never echoed, because it is a secret.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {}

  // Split on either ending: a file edited on Windows, or fetched through a
  // tool that rewrote its newlines, must not leave a `\r` glued to every value.
  const lines = text.split(/\r?\n/)

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue

    const withoutExport = line.replace(/^export\s+/, '')
    const equals = withoutExport.indexOf('=')
    const key = equals === -1 ? '' : withoutExport.slice(0, equals).trim()

    if (equals === -1 || !NAME.test(key)) {
      throw new Error(`.env line ${index + 1}: expected NAME=value`)
    }

    values[key] = parseValue(withoutExport.slice(equals + 1))
  }

  return values
}

function parseValue(raw: string): string {
  const trimmed = raw.trim()
  const first = trimmed[0]

  if ((first === '"' || first === "'") && trimmed.length >= 2 && trimmed.endsWith(first)) {
    const inner = trimmed.slice(1, -1)
    return first === '"' ? unescape(inner) : inner
  }

  return trimmed
}

function unescape(value: string): string {
  return value.replace(/\\([nrt\\"'])/g, (_, char: string) => {
    if (char === 'n') return '\n'
    if (char === 'r') return '\r'
    if (char === 't') return '\t'
    return char
  })
}

export interface LoadEnvOptions {
  /** Defaults to `.env` in the working directory. */
  path?: string
  /** The environment to merge into. Defaults to `process.env`; injected in tests. */
  env?: Record<string, string | undefined>
}

/**
 * Merge a `.env` file into the environment and return the names it set.
 *
 * Two rules carry the weight:
 *
 * 1. **A missing file is a no-op**, not an error. The repo ships without one,
 *    the tests run without one, and a deployment that sets real variables has
 *    no reason to keep one.
 * 2. **An existing value wins.** The exception is the empty string, which is
 *    treated as unset: `.env.example` ships `AMC_API_KEY=` empty, `set -a` on
 *    a half-filled copy exports that empty string, and every consumer in this
 *    codebase tests the variable for truthiness. Letting an empty export
 *    suppress a real key would recreate the outage this function fixes.
 */
export function loadEnv(options: LoadEnvOptions = {}): string[] {
  const file = options.path ?? path.resolve(process.cwd(), '.env')
  if (!existsSync(file)) return []

  const env = options.env ?? process.env
  const applied: string[] = []

  for (const [key, value] of Object.entries(parseEnvFile(readFileSync(file, 'utf8')))) {
    const existing = env[key]
    if (existing != null && existing !== '') continue
    env[key] = value
    applied.push(key)
  }

  return applied
}
