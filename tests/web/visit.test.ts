import { describe, expect, it } from 'vitest'
import { isNewToViewer, type VisitBaseline } from '../../web/src/visit'

const entry = (firstSeenAt: string, isNew: boolean) => ({ firstSeenAt, isNew })

describe('isNewToViewer', () => {
  it('falls back to the server flag until the visit stamp comes back', () => {
    // The highlights response was computed against the same last_visit_at the
    // POST is about to replace, so it is right for this render. Rendering an
    // unmarked page and marking it a moment later would flicker.
    const pending: VisitBaseline = { known: false }
    expect(isNewToViewer(entry('2026-08-22T10:00:00Z', true), pending)).toBe(true)
    expect(isNewToViewer(entry('2026-08-01T10:00:00Z', false), pending)).toBe(false)
  })

  it('marks entries first seen after the previous visit', () => {
    const baseline: VisitBaseline = { known: true, previous: '2026-08-20T00:00:00Z' }
    expect(isNewToViewer(entry('2026-08-21T00:00:00Z', false), baseline)).toBe(true)
    expect(isNewToViewer(entry('2026-08-19T00:00:00Z', true), baseline)).toBe(false)
  })

  it('treats an entry first seen exactly at the previous visit as already seen', () => {
    const baseline: VisitBaseline = { known: true, previous: '2026-08-20T00:00:00Z' }
    expect(isNewToViewer(entry('2026-08-20T00:00:00Z', true), baseline)).toBe(false)
  })

  it('marks nothing new on a first-ever visit', () => {
    // Matches the read model: an absent last_visit_at makes isNew false for
    // everything. Marking the whole page NEW the first time it is opened would
    // make the signal worthless on the one day it is cheapest to get wrong.
    const baseline: VisitBaseline = { known: true, previous: null }
    expect(isNewToViewer(entry('2026-08-21T00:00:00Z', true), baseline)).toBe(false)
  })

  it('keeps the baseline pinned once known, so a later refetch cannot erase marks', () => {
    // After the POST, the server would compute isNew=false for everything.
    // The pinned baseline is what keeps the marks on screen for this visit.
    const baseline: VisitBaseline = { known: true, previous: '2026-08-20T00:00:00Z' }
    expect(isNewToViewer(entry('2026-08-21T00:00:00Z', false), baseline)).toBe(true)
  })
})
