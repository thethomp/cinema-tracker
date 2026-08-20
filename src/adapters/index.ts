import type { VenueAdapter, VenueRef } from '../core/types.js'
import type { Fetcher } from '../fetch/fetcher.js'
import { createSiffAdapter } from './siff.js'
import { createCinemarkAdapter } from './cinemark.js'
import { createSeattleMagicAdapter } from './seattle-magic.js'

export function createAdapters(fetcher: Fetcher): VenueAdapter[] {
  return [
    createSiffAdapter(fetcher),
    createCinemarkAdapter(fetcher),
    createSeattleMagicAdapter(fetcher),
  ]
}

export function allVenues(adapters: VenueAdapter[]): VenueRef[] {
  return adapters.flatMap((adapter) => adapter.venues)
}
