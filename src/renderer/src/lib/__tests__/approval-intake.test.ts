import { describe, it, expect, vi } from 'vitest'
import { loadApprovalIntake, type ApprovalSetupRecord } from '../approval-intake'

const record = (id: number): ApprovalSetupRecord => ({
  id,
  title: `Approval ${id}`,
  detail: null,
  connector: 'gmail',
  tool: 'send',
  args: null
})

describe('loadApprovalIntake', () => {
  it('reports the approval owner as unavailable when Pro exposes no invoke', async () => {
    await expect(loadApprovalIntake(7, undefined)).resolves.toEqual({
      status: 'error',
      approvalId: 7,
      code: 'approval_service_unavailable',
      message: 'Approvals are unavailable in this build.'
    })
  })

  it('returns the matching record, matching a string id from the store numerically', async () => {
    const invoke = vi.fn(async () => [record(3), { ...record(7), id: '7' }])
    await expect(loadApprovalIntake(7, invoke)).resolves.toEqual({
      status: 'ready',
      record: { ...record(7), id: '7' }
    })
    expect(invoke).toHaveBeenCalledWith('approvals:list')
  })

  const notFound = (approvalId: number): Record<string, unknown> => ({
    status: 'error',
    approvalId,
    code: 'approval_not_found',
    message: 'This approval could not be found. It may have changed on another device.'
  })

  it('reports not-found when the list has no record with that id', async () => {
    await expect(loadApprovalIntake(9, async () => [record(3)])).resolves.toEqual(notFound(9))
  })

  it.each([
    ['null', null],
    ['an object', { approvals: [record(9)] }],
    ['undefined', undefined]
  ])('reports not-found (never an empty replacement) when the owner returns %s', async (_c, v) => {
    await expect(loadApprovalIntake(9, async () => v)).resolves.toEqual(notFound(9))
  })

  it('reports a read failure with the error message when the owner throws', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('  store locked  ')
    })
    await expect(loadApprovalIntake(4, invoke)).resolves.toEqual({
      status: 'error',
      approvalId: 4,
      code: 'approval_read_failed',
      message: 'The approval could not be loaded. store locked'
    })
  })

  it.each([
    ['a blank Error message', new Error('   ')],
    ['a non-Error rejection', 'boom']
  ])('reports a read failure without detail on %s', async (_c, thrown) => {
    await expect(
      loadApprovalIntake(4, async () => {
        throw thrown
      })
    ).resolves.toEqual({
      status: 'error',
      approvalId: 4,
      code: 'approval_read_failed',
      message: 'The approval could not be loaded.'
    })
  })
})
