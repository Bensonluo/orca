import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setMainHttpClient } from '../network/http-client'

const fetchMock = vi.fn()
const fsState = vi.hoisted<{
  config: string | null
  credentials: string | null
  credentialsByPath: Record<string, string>
  missingPaths: string[]
  readError: Error | null
  readPaths: string[]
}>(() => ({
  config: null,
  credentials: null,
  credentialsByPath: {},
  missingPaths: [],
  readError: null,
  readPaths: []
}))

vi.mock('node:fs/promises', () => ({
  readFile: async (path: string) => {
    const p = String(path)
    fsState.readPaths.push(p)
    if (fsState.readError) {
      throw fsState.readError
    }
    const missing = (): NodeJS.ErrnoException => {
      const error = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException
      error.code = 'ENOENT'
      return error
    }
    if (p.endsWith('config.toml')) {
      if (fsState.config === null) {
        throw missing()
      }
      return fsState.config
    }
    if (fsState.missingPaths.includes(p)) {
      throw missing()
    }
    if (p in fsState.credentialsByPath) {
      return fsState.credentialsByPath[p]
    }
    if (fsState.credentials === null) {
      throw missing()
    }
    return fsState.credentials
  }
}))

vi.mock('node:os', () => ({ homedir: () => '/home/test' }))

import { fetchKimiRateLimits } from './kimi-fetcher'

setMainHttpClient({ fetch: fetchMock, proxySession: () => null })

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response
}

// Real shape captured from GET https://api.kimi.com/coding/v1/usages.
const USAGE_RESPONSE = {
  user: { userId: 'u1', membership: { level: 'LEVEL_INTERMEDIATE' } },
  usage: { limit: '1000', remaining: '1000', resetTime: '2026-06-09T07:52:41.230862Z' },
  limits: [
    {
      window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
      detail: { limit: '100', remaining: '40', resetTime: '2026-06-04T08:52:41.230862Z' }
    }
  ],
  subType: 'TYPE_PURCHASE'
}

// Built with `join` so the expectation matches the separator the fetcher emits on this platform.
function hostConfigPath(kimiHome: string): string {
  return join(kimiHome, 'config.toml')
}

function hostCredentialsPath(kimiHome: string, slot = 'kimi-code'): string {
  return join(kimiHome, 'credentials', `${slot}.json`)
}

function scopedSlotConfig(key: string): string {
  return `[providers."managed:kimi-code".oauth]\nstorage = "file"\nkey = "${key}"\noauth_host = "https://auth.kimi.ai"\n`
}

function freshCredentials(): string {
  // expires_at far in the future (seconds).
  return JSON.stringify({ access_token: 'tok-abc', expires_at: 99_999_999_999 })
}

describe('fetchKimiRateLimits', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fsState.config = null
    fsState.credentials = null
    fsState.credentialsByPath = {}
    fsState.missingPaths = []
    fsState.readError = null
    fsState.readPaths = []
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns unavailable when not signed in', async () => {
    const result = await fetchKimiRateLimits()
    expect(result.provider).toBe('kimi')
    expect(result.status).toBe('unavailable')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps the usages payload to session (5h) and weekly windows', async () => {
    fsState.credentials = freshCredentials()
    fetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('ok')
    expect(result.provider).toBe('kimi')
    // 5h window from limits[]: 40/100 remaining → 60% used.
    expect(result.session?.windowMinutes).toBe(300)
    expect(result.session?.usedPercent).toBeCloseTo(60)
    // Weekly from top-level usage: 1000/1000 remaining → 0% used.
    expect(result.weekly?.windowMinutes).toBe(10080)
    expect(result.weekly?.usedPercent).toBeCloseTo(0)
    // Bearer token from the credentials file is sent.
    const [, init] = fetchMock.mock.calls[0]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-abc')
  })

  it('surfaces an error when the usage request fails', async () => {
    fsState.credentials = freshCredentials()
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500))

    const result = await fetchKimiRateLimits()
    expect(result.status).toBe('error')
    expect(result.session).toBeNull()
  })

  it('tags a request that throws before a response as a network failure', async () => {
    fsState.credentials = freshCredentials()
    fetchMock.mockRejectedValueOnce(new Error('net::ERR_PROXY_CONNECTION_FAILED'))

    const result = await fetchKimiRateLimits()
    expect(result.error).toBe('net::ERR_PROXY_CONNECTION_FAILED')
    expect(result.usageMetadata?.failureKind).toBe('network')
  })

  it('tags a malformed usage body as a parse failure, not a network one', async () => {
    fsState.credentials = freshCredentials()
    fetchMock.mockResolvedValueOnce(
      new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } })
    )

    const result = await fetchKimiRateLimits()
    expect(result.usageMetadata?.failureKind).toBe('parse')
  })

  it('surfaces an error when the credentials file cannot be parsed', async () => {
    fsState.credentials = '{'

    const result = await fetchKimiRateLimits()
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/json/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces an error when the credentials file cannot be read', async () => {
    fsState.credentials = freshCredentials()
    fsState.readError = new Error('EACCES')

    const result = await fetchKimiRateLimits()
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/EACCES/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats an empty usage payload as an error', async () => {
    fsState.credentials = freshCredentials()
    fetchMock.mockResolvedValueOnce(jsonResponse({}))

    const result = await fetchKimiRateLimits()
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/quota windows/)
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
  })

  it('does NOT refresh or call the API when the token is expired (read-only)', async () => {
    // expires_at in the past → token stale; fetcher must not hit the network.
    fsState.credentials = JSON.stringify({ access_token: 'tok-old', expires_at: 1 })

    const result = await fetchKimiRateLimits()
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/expired/i)
    expect(result.error).toMatch(/run kimi on the computer running Orca/i)
    expect(result.usageMetadata).toEqual({
      failureKind: 'delegated-refresh-required',
      source: 'oauth'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads the host ~/.kimi-code credentials by default', async () => {
    fsState.credentials = freshCredentials()
    fetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('ok')
    expect(fsState.readPaths).toEqual([
      hostConfigPath('/home/test/.kimi-code'),
      hostCredentialsPath('/home/test/.kimi-code')
    ])
  })

  it('honors KIMI_CODE_HOME for the host home', async () => {
    vi.stubEnv('KIMI_CODE_HOME', '/custom/kimi-home')
    fsState.credentials = freshCredentials()
    fetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('ok')
    expect(fsState.readPaths).toEqual([
      hostConfigPath('/custom/kimi-home'),
      hostCredentialsPath('/custom/kimi-home')
    ])
  })

  it('ignores a blank KIMI_CODE_HOME instead of reading from the process cwd', async () => {
    vi.stubEnv('KIMI_CODE_HOME', '   ')
    fsState.credentials = freshCredentials()
    fetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    await fetchKimiRateLimits()

    expect(fsState.readPaths).toEqual([
      hostConfigPath('/home/test/.kimi-code'),
      hostCredentialsPath('/home/test/.kimi-code')
    ])
  })

  it('reads the scoped OAuth slot named by config.toml (#24176)', async () => {
    const slot = 'kimi-code-env-0e4f99c69cc27850'
    fsState.config = scopedSlotConfig(`oauth/${slot}`)
    fsState.credentialsByPath[hostCredentialsPath('/home/test/.kimi-code', slot)] = JSON.stringify({
      access_token: 'tok-scoped',
      expires_at: 99_999_999_999
    })
    fetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('ok')
    expect(fsState.readPaths).toEqual([
      hostConfigPath('/home/test/.kimi-code'),
      hostCredentialsPath('/home/test/.kimi-code', slot)
    ])
    const [, init] = fetchMock.mock.calls[0]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-scoped')
  })

  it('keeps reading the default slot when config.toml names the shared default key', async () => {
    // auth.kimi.com users have an explicit `oauth/kimi-code` key; they must not
    // be redirected anywhere new.
    fsState.config = scopedSlotConfig('oauth/kimi-code')
    fsState.credentials = freshCredentials()
    fetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('ok')
    expect(fsState.readPaths).toEqual([
      hostConfigPath('/home/test/.kimi-code'),
      hostCredentialsPath('/home/test/.kimi-code')
    ])
  })

  it('falls back to the default slot when the scoped slot was never written', async () => {
    const slot = 'kimi-code-env-0e4f99c69cc27850'
    fsState.config = scopedSlotConfig(`oauth/${slot}`)
    fsState.missingPaths = [hostCredentialsPath('/home/test/.kimi-code', slot)]
    fsState.credentials = freshCredentials()
    fetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('ok')
    expect(fsState.readPaths).toEqual([
      hostConfigPath('/home/test/.kimi-code'),
      hostCredentialsPath('/home/test/.kimi-code', slot),
      hostCredentialsPath('/home/test/.kimi-code')
    ])
  })

  it('does NOT fall back to the default slot when the scoped token is expired', async () => {
    const slot = 'kimi-code-env-0e4f99c69cc27850'
    fsState.config = scopedSlotConfig(`oauth/${slot}`)
    fsState.credentialsByPath[hostCredentialsPath('/home/test/.kimi-code', slot)] = JSON.stringify({
      access_token: 'tok-old',
      expires_at: 1
    })

    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('error')
    expect(result.error).toMatch(/expired/i)
    expect(result.usageMetadata?.failureKind).toBe('delegated-refresh-required')
    // Only the scoped file was consulted — no silent fallback to another account's token.
    expect(fsState.readPaths).toEqual([
      hostConfigPath('/home/test/.kimi-code'),
      hostCredentialsPath('/home/test/.kimi-code', slot)
    ])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['missing providers section', '[oauth]\nkey = "oauth/kimi-code-env-abc"\n'],
    ['malformed toml', 'this is [not toml'],
    ['key is not a string', '[providers."managed:kimi-code".oauth]\nkey = 42\n'],
    ['key has no oauth prefix', '[providers."managed:kimi-code".oauth]\nkey = "custom-slot"\n'],
    [
      'key tries to escape the credentials dir',
      '[providers."managed:kimi-code".oauth]\nkey = "oauth/../../other"\n'
    ]
  ])('keeps the default slot when config.toml has %s', async (_label: string, config: string) => {
    fsState.config = config
    fsState.credentials = freshCredentials()
    fetchMock.mockResolvedValueOnce(jsonResponse(USAGE_RESPONSE))

    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('ok')
    expect(fsState.readPaths).toEqual([
      hostConfigPath('/home/test/.kimi-code'),
      hostCredentialsPath('/home/test/.kimi-code')
    ])
  })
})
