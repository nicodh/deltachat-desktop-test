import { existsSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { getLogger } from '@deltachat-desktop/shared/logger.js'

import type { BrowserWindow } from 'electron'
import type { UserPresenceStatus } from '@deltachat-desktop/runtime-interface'

const log = getLogger('main/user-presence')

const __dirname = dirname(fileURLToPath(import.meta.url))
const nativeDistDir = join(__dirname, '..', 'native-dist').replace(
  'app.asar',
  'app.asar.unpacked'
)

type NativeOutcome = { status: UserPresenceStatus; error?: string }

type NativeSupport = { supported: boolean; detail?: string }

type OsAuthAddon = {
  checkUserPresenceSupport(): Promise<NativeSupport>
  requestUserPresence(
    reason: string,
    windowHandle: Buffer | null
  ): Promise<NativeOutcome>
}

function loadAddon(): OsAuthAddon | null {
  const candidates = [
    `os-auth.${process.platform}-${process.arch}.node`,
    // macOS ships one binary for both architectures
    `os-auth.${process.platform}.node`,
  ]
  for (const candidate of candidates) {
    const path = join(nativeDistDir, candidate)
    if (!existsSync(path)) {
      continue
    }
    try {
      return createRequire(import.meta.url)(path)
    } catch (error) {
      log.error('failed to load', path, error)
      return null
    }
  }
  log.info('no addon for this platform, user presence is unavailable', {
    candidates,
  })
  return null
}

let addon: OsAuthAddon | null | undefined = undefined
function getAddon(): OsAuthAddon | null {
  if (addon === undefined) {
    addon = loadAddon()
  }
  return addon
}

export async function isUserPresenceSupported(): Promise<boolean> {
  const addon = getAddon()
  if (!addon) {
    return false
  }
  try {
    const support = await addon.checkUserPresenceSupport()
    if (!support.supported) {
      // e.g. DeviceNotPresent, NotConfiguredForUser, DisabledByPolicy
      log.info('user presence is not available', support.detail)
    }
    return support.supported
  } catch (error) {
    log.error('checkUserPresenceSupport failed', error)
    return false
  }
}

/** a second prompt while one is open would either be ignored by the system or
 * stack two dialogs on top of each other, so callers share the pending one */
let pendingRequest: Promise<UserPresenceStatus> | null = null

/**
 * Shows the system authentication prompt (Touch ID / account password on macOS,
 * Windows Hello on Windows).
 *
 * @param reason displayed to the user, has to say what is being authorized
 * @param window the window the prompt belongs to, required on Windows
 */
export function requestUserPresence(
  reason: string,
  window: BrowserWindow | null
): Promise<UserPresenceStatus> {
  if (pendingRequest) {
    return pendingRequest
  }
  const addon = getAddon()
  if (!addon) {
    return Promise.resolve('unsupported')
  }

  const windowHandle =
    process.platform === 'win32' && window && !window.isDestroyed()
      ? window.getNativeWindowHandle()
      : null

  pendingRequest = addon
    .requestUserPresence(reason, windowHandle)
    .then(outcome => {
      if (outcome.status !== 'authenticated') {
        log.info('not authenticated', outcome)
      }
      return outcome.status
    })
    .catch(error => {
      log.error('requestUserPresence failed', error)
      return 'failed' as const
    })
    .finally(() => {
      pendingRequest = null
    })

  return pendingRequest
}
