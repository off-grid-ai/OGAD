import { describe, expect, it } from 'vitest'
import { ARCHIVABLE_CATEGORIES, CATEGORY_DIRS, type DataCategoryId } from '../data-categories'

describe('the data-category dir map (SSOT for delete + archive)', () => {
  it('gives every category at least one userData-relative dir name', () => {
    for (const [id, dirs] of Object.entries(CATEGORY_DIRS)) {
      expect(dirs.length, `category ${id} has no dirs`).toBeGreaterThan(0)
      for (const dir of dirs) {
        // Relative names only - callers resolve against userData. A path separator or
        // traversal here would silently point delete/archive somewhere else.
        expect(dir).not.toMatch(/[/\\]|\.\./)
        expect(dir.trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('archivable categories are a subset of the map', () => {
    const ids = Object.keys(CATEGORY_DIRS) as DataCategoryId[]
    for (const id of ARCHIVABLE_CATEGORIES) {
      expect(ids).toContain(id)
    }
  })

  it('keeps the retention-critical mappings stable', () => {
    // The retention flows (age-based delete + pre-delete archive) are wired to these
    // two categories; renaming their dirs is a data-loss-shaped change - fail loudly.
    expect(CATEGORY_DIRS.captures).toEqual(['captures'])
    expect(CATEGORY_DIRS.meetings).toEqual(['meetings'])
  })
})
