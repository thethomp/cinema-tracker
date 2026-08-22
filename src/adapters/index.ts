import type { VenueAdapter, VenueRef } from '../core/types.js'
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

export function allVenues(adapters: VenueAdapter[]): VenueRef[] {
  return adapters.flatMap((adapter) => adapter.venues)
}
