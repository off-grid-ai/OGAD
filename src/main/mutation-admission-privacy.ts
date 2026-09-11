import { registerDataDeletionGuard, type DataDeletionScope } from './data-privacy'
import {
  applicationMutationAdmission,
  type ApplicationMutationAdmission,
  type MutationAdmissionScope
} from './mutation-admission'

const ALL_SCOPES: readonly MutationAdmissionScope[] = ['images', 'chats']

function producerScopesFor(scope: DataDeletionScope): readonly MutationAdmissionScope[] {
  if (scope === 'all') return ALL_SCOPES
  if (scope === 'images' || scope === 'chats') return [scope]
  return []
}

/** Bind the one mutation gate to the one privacy deletion lifecycle. */
export function registerApplicationMutationAdmissionGuard(
  admission: ApplicationMutationAdmission = applicationMutationAdmission
): () => void {
  return registerDataDeletionGuard('desktop:application-mutations', {
    scopes: ['images', 'chats', 'all'],
    suspend: (context) => admission.suspend(producerScopesFor(context.scope)),
    expand: (from, to) => {
      const covered = new Set(producerScopesFor(from.scope))
      return admission.suspend(producerScopesFor(to.scope).filter((scope) => !covered.has(scope)))
    },
    resume: (context) => admission.resume(producerScopesFor(context.scope))
  })
}
