export interface ApprovalSetupRecord {
  id: number
  title: string
  detail: string | null
  connector: string | null
  tool: string | null
  args: string | null
}

export type ApprovalIntakeState =
  | { status: 'idle' }
  | { status: 'loading'; approvalId: number }
  | { status: 'ready'; record: ApprovalSetupRecord }
  | {
      status: 'error'
      approvalId: number
      code: 'approval_service_unavailable' | 'approval_not_found' | 'approval_read_failed'
      message: string
    }

type ProInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>

/**
 * Read one approval through the Pro-owned approval store.
 *
 * The renderer receives a closed result union. It never converts an unavailable owner into an
 * empty list and never creates a replacement approval when the authoritative read fails.
 */
export async function loadApprovalIntake(
  approvalId: number,
  invoke: ProInvoke | undefined
): Promise<Exclude<ApprovalIntakeState, { status: 'idle' | 'loading' }>> {
  if (!invoke) {
    return {
      status: 'error',
      approvalId,
      code: 'approval_service_unavailable',
      message: 'Approvals are unavailable in this build.'
    }
  }

  try {
    const approvals = await invoke('approvals:list')
    const record = Array.isArray(approvals)
      ? (approvals as ApprovalSetupRecord[]).find((approval) => Number(approval.id) === approvalId)
      : undefined
    if (!record) {
      return {
        status: 'error',
        approvalId,
        code: 'approval_not_found',
        message: 'This approval could not be found. It may have changed on another device.'
      }
    }
    return { status: 'ready', record }
  } catch (error) {
    const detail = error instanceof Error && error.message.trim() ? ` ${error.message.trim()}` : ''
    return {
      status: 'error',
      approvalId,
      code: 'approval_read_failed',
      message: `The approval could not be loaded.${detail}`
    }
  }
}
