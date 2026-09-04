/**
 * The RAG replication document stream, with a truncated read REFUSED rather than mistaken for the
 * end of the set.
 *
 * `rag.sync.allDocuments()` is the one member of the replication namespace that is a stream rather
 * than a command, so it is the one that returns no `Outcome`: a failure part-way through ENDS the
 * iteration and is reported on `rag.events` as `sync_all_documents`, and the `for await` never
 * throws. A caller that simply iterates therefore cannot tell "that was all of them" from "the read
 * broke after three" - and a caller that treats the result as the COMPLETE set (a peer backfill, a
 * full-state push, a list of what this device already holds) would publish a partial state as if it
 * were whole. That is a typed failure converted into a success-shaped collection, which this
 * program forbids.
 *
 * This watches that one event for the duration of the iteration and throws the typed failure's own
 * message when the consumer drains a stream that broke, so a partial read fails its caller instead
 * of passing as a complete one. A consumer that breaks out early keeps its own control flow and
 * gets no error. A caller for which over-reading is the SAFE direction may keep using the facade
 * stream directly, and should say why at that call site.
 *
 * Same rule and same shape as mobile's `src/services/ragReplication.ts` (Seat B, mobile/pro
 * `2512e377`); the source is a parameter here so the boundary stays pure and testable without the
 * application root.
 */
import type {
  KnowledgeDocumentSnapshot,
  RagFacade,
  RagFailure,
  Unsubscribe
} from '@offgrid/application'

/** Exactly what the boundary reads: the stream, and the events that report its failure. */
export interface RagReplicationSource {
  events(listener: Parameters<RagFacade['events']>[0]): Unsubscribe
  readonly sync: Pick<RagFacade['sync'], 'allDocuments'>
}

export async function* replicatedRagDocuments(
  rag: RagReplicationSource
): AsyncGenerator<KnowledgeDocumentSnapshot> {
  // A list rather than a nullable, because the only writer is the event callback: a `let` the
  // compiler can see is only ever assigned inside a closure gets narrowed to its initializer at
  // every read here, which would make both checks below dead code by type inference.
  const reported: RagFailure[] = []
  const release = rag.events((event) => {
    if (event.type === 'operation_failed' && event.operation === 'sync_all_documents') {
      reported.push(event.failure)
    }
  })
  try {
    for await (const document of rag.sync.allDocuments()) {
      // The event lands before the iterator ends, so stop rather than yield a document read after
      // the stream had already given up.
      if (reported.length > 0) break
      yield document
    }
  } finally {
    release()
  }
  // Reached only when the consumer drained the stream: a consumer that broke out early gets its
  // own control flow back, not someone else's error. The FIRST reported failure is the one that
  // ended the read; a later one cannot be more informative about why it stopped.
  const [failure] = reported
  if (failure) throw new Error(failure.message)
}
