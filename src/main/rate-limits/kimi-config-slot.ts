import { readFile } from 'node:fs/promises'
import { getKimiConfigPath, parseKimiActiveOAuthSlot } from '../kimi/kimi-oauth-slot'
import {
  createAuthFilesystemOperation,
  type SharedAuthFilesystemOperation
} from './auth-filesystem-operation'

const CONFIG_READ_TIMEOUT_MS = 5_000

const configSlotReadByPath = new Map<string, SharedAuthFilesystemOperation<string | null>>()

function getConfigSlotRead(path: string): SharedAuthFilesystemOperation<string | null> {
  const existing = configSlotReadByPath.get(path)
  if (existing) {
    return existing
  }
  const read = createAuthFilesystemOperation(
    path,
    async (): Promise<string | null> => {
      let raw: string
      try {
        raw = await readFile(path, 'utf-8')
      } catch {
        return null
      }
      return parseKimiActiveOAuthSlot(raw)
    },
    // Why: the credential read for the same WSL distro serializes separately,
    // so a stalled UNC config read can never starve the credential read of
    // every subsequent poll for that distro.
    { concurrencyGroup: 'kimi-config-probe' }
  )
  configSlotReadByPath.set(path, read)
  const clearRead = (): void => {
    if (configSlotReadByPath.get(path) === read) {
      configSlotReadByPath.delete(path)
    }
  }
  void read.result.then(clearRead, clearRead)
  return read
}

/**
 * Bounded read of the active OAuth slot recorded in <kimi home>/config.toml.
 * Shares one in-flight read per path and resolves to null — the historical
 * default slot — on any read failure or timeout, so a stopped WSL distro
 * degrades to the default-slot behavior instead of parking the poll cycle.
 */
export async function readKimiActiveOAuthSlot(kimiHome: string): Promise<string | null> {
  try {
    return await getConfigSlotRead(getKimiConfigPath(kimiHome)).wait(
      AbortSignal.timeout(CONFIG_READ_TIMEOUT_MS)
    )
  } catch {
    return null
  }
}
