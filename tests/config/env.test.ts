import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadEnv, parseEnvFile } from '../../src/config/env.js'

describe('parseEnvFile', () => {
  it('reads a plain assignment', () => {
    expect(parseEnvFile('TMDB_API_KEY=abc123')).toEqual({ TMDB_API_KEY: 'abc123' })
  })

  it('ignores blank lines and full-line comments', () => {
    const text = [
      '# Copy to .env and fill in.',
      '',
      'AMC_API_KEY=vendor-key',
      '   ',
      '   # indented comment',
      'TMDB_API_KEY=read-token',
    ].join('\n')

    expect(parseEnvFile(text)).toEqual({
      AMC_API_KEY: 'vendor-key',
      TMDB_API_KEY: 'read-token',
    })
  })

  it('strips an `export ` prefix, because that is how the README says to source it', () => {
    expect(parseEnvFile('export AMC_API_KEY=vendor-key')).toEqual({ AMC_API_KEY: 'vendor-key' })
    expect(parseEnvFile('  export   TMDB_API_KEY=read-token')).toEqual({
      TMDB_API_KEY: 'read-token',
    })
  })

  it('keeps everything after the first `=`', () => {
    // A TMDB read token is a JWT; base64url padding and `=` inside a value are
    // ordinary. Splitting on every `=` would silently truncate the key.
    expect(parseEnvFile('TMDB_API_KEY=eyJhbGciOiJIUzI1NiJ9.payload==')).toEqual({
      TMDB_API_KEY: 'eyJhbGciOiJIUzI1NiJ9.payload==',
    })
  })

  it('strips matching single or double quotes without touching what is inside', () => {
    expect(parseEnvFile('A="quoted value"')).toEqual({ A: 'quoted value' })
    expect(parseEnvFile("B='quoted value'")).toEqual({ B: 'quoted value' })
    // Whitespace inside quotes is part of the value; outside them it is not.
    expect(parseEnvFile('C="  padded  "')).toEqual({ C: '  padded  ' })
    expect(parseEnvFile('D=   unpadded   ')).toEqual({ D: 'unpadded' })
    // A lone quote is not a delimiter.
    expect(parseEnvFile('E="unterminated')).toEqual({ E: '"unterminated' })
    expect(parseEnvFile(`F="mixed'`)).toEqual({ F: `"mixed'` })
  })

  it('expands \\n and \\t inside double quotes only', () => {
    expect(parseEnvFile('A="one\\ntwo"')).toEqual({ A: 'one\ntwo' })
    expect(parseEnvFile('B="a\\tb"')).toEqual({ B: 'a\tb' })
    expect(parseEnvFile('C="a\\\\b"')).toEqual({ C: 'a\\b' })
    expect(parseEnvFile("D='one\\ntwo'")).toEqual({ D: 'one\\ntwo' })
  })

  it('does not treat a `#` inside a value as a comment', () => {
    // Truncating a key at a `#` would hand the app a plausible-looking
    // credential that fails authentication. Only a full-line comment counts.
    expect(parseEnvFile('AMC_API_KEY=abc#def')).toEqual({ AMC_API_KEY: 'abc#def' })
    expect(parseEnvFile('AMC_API_KEY=abc # trailing')).toEqual({ AMC_API_KEY: 'abc # trailing' })
  })

  it('handles CRLF line endings', () => {
    const text = '# comment\r\nAMC_API_KEY=vendor-key\r\n\r\nTMDB_API_KEY=read-token\r\n'
    expect(parseEnvFile(text)).toEqual({
      AMC_API_KEY: 'vendor-key',
      TMDB_API_KEY: 'read-token',
    })
  })

  it('accepts an empty value', () => {
    expect(parseEnvFile('AMC_API_KEY=')).toEqual({ AMC_API_KEY: '' })
  })

  it('lets a later assignment win', () => {
    expect(parseEnvFile('A=first\nA=second')).toEqual({ A: 'second' })
  })

  it('returns nothing for an empty file', () => {
    expect(parseEnvFile('')).toEqual({})
    expect(parseEnvFile('\n\n')).toEqual({})
  })

  it('throws on a line that is not an assignment, naming the line number only', () => {
    // Loud, and without echoing the line: the content of a .env is secret.
    expect(() => parseEnvFile('AMC_API_KEY=ok\nthis is not an assignment')).toThrowError(
      /line 2/,
    )
    expect(() => parseEnvFile('AMC_API_KEY=ok\nthis is not an assignment')).not.toThrowError(
      /this is not an assignment/,
    )
    expect(() => parseEnvFile('1BAD=value')).toThrowError(/line 1/)
    expect(() => parseEnvFile('has space=value')).toThrowError(/line 1/)
  })
})

describe('loadEnv', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cinema-env-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const write = (contents: string): string => {
    const path = join(dir, '.env')
    writeFileSync(path, contents, 'utf8')
    return path
  }

  it('is a no-op when the file is absent', () => {
    const env: Record<string, string | undefined> = {}
    expect(loadEnv({ path: join(dir, 'nothing-here'), env })).toEqual([])
    expect(env).toEqual({})
  })

  it('sets variables that are not already in the environment', () => {
    const path = write('AMC_API_KEY=vendor-key\nTMDB_API_KEY=read-token\n')
    const env: Record<string, string | undefined> = {}

    expect(loadEnv({ path, env })).toEqual(['AMC_API_KEY', 'TMDB_API_KEY'])
    expect(env).toEqual({ AMC_API_KEY: 'vendor-key', TMDB_API_KEY: 'read-token' })
  })

  it('never overrides a variable already set in the environment', () => {
    // A real deployment sets real variables. A stale .env checked out beside
    // it must not quietly replace them -- that is exactly the silent-wrong-data
    // failure this project exists to avoid. `process.loadEnvFile` overrides,
    // which is why this merges by hand instead.
    const path = write('AMC_API_KEY=from-file\nTMDB_API_KEY=from-file\n')
    const env: Record<string, string | undefined> = { AMC_API_KEY: 'from-deployment' }

    expect(loadEnv({ path, env })).toEqual(['TMDB_API_KEY'])
    expect(env.AMC_API_KEY).toBe('from-deployment')
    expect(env.TMDB_API_KEY).toBe('from-file')
  })

  it('treats an empty environment variable as unset', () => {
    // `.env.example` ships `AMC_API_KEY=` empty, and `set -a; . ./.env` on a
    // half-filled copy exports the empty string. Every consumer here tests the
    // variable for truthiness, so an empty value is not a configured value --
    // honouring it would reproduce the outage this change is fixing.
    const path = write('AMC_API_KEY=vendor-key\n')
    const env: Record<string, string | undefined> = { AMC_API_KEY: '' }

    expect(loadEnv({ path, env })).toEqual(['AMC_API_KEY'])
    expect(env.AMC_API_KEY).toBe('vendor-key')
  })

  it('defaults to .env in the working directory', () => {
    const cwd = process.cwd()
    try {
      process.chdir(dir)
      write('LETTERBOXD_USERNAME=someone\n')
      const env: Record<string, string | undefined> = {}
      expect(loadEnv({ env })).toEqual(['LETTERBOXD_USERNAME'])
      expect(env.LETTERBOXD_USERNAME).toBe('someone')
    } finally {
      process.chdir(cwd)
    }
  })
})
