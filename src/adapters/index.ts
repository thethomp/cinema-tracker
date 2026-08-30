import type { UnconfiguredSource, VenueAdapter, VenueRef } from '../core/types.js'
import type { Fetcher } from '../fetch/fetcher.js'
import { AmcClient } from '../amc/client.js'
import { createSiffAdapter } from './siff.js'
import { createCinemarkAdapter } from './cinemark.js'
import { createSeattleMagicAdapter } from './seattle-magic.js'
import { createAmcAdapter } from './amc.js'

export interface AdapterOptions {
  /** AMC's vendor key. Without it the AMC adapter is omitted entirely. */
  amcApiKey?: string
}

export function createAdapters(fetcher: Fetcher, options: AdapterOptions = {}): VenueAdapter[] {
  const adapters = [
    createSiffAdapter(fetcher),
    createCinemarkAdapter(fetcher),
    createSeattleMagicAdapter(fetcher),
  ]

  // No key means no AMC, rather than an adapter that fails every sweep and
  // reports the source unhealthy forever.
  if (options.amcApiKey) {
    adapters.push(createAmcAdapter(new AmcClient(fetcher, options.amcApiKey)))
  }

  return adapters
}

/**
 * The adapters `createAdapters` will *not* build, and why.
 *
 * Deliberately derived from the same options, and kept beside the omission it
 * describes, so the two cannot drift: an adapter that is built but reported
 * missing, or missing but reported built, is worse than either fact alone.
 * Callers feed this to the health report, where "not configured: AMC_API_KEY
 * is not set" appears in place of nothing at all.
 */
export function unconfiguredAdapters(options: AdapterOptions = {}): UnconfiguredSource[] {
  return options.amcApiKey ? [] : [{ source: 'amc', variable: 'AMC_API_KEY' }]
}

export function allVenues(adapters: VenueAdapter[]): VenueRef[] {
  return adapters.flatMap((adapter) => adapter.venues)
}
