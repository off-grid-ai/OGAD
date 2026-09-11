import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { GeneratedImageRecord } from '@offgrid/application'
import type Database from 'better-sqlite3-multiple-ciphers'
import { dataDir } from '../runtime-env'
import { resolveExistingOwnedPath, resolveOwnedDestination } from './owned-path'

type CreationIntentRow = {
  request_id: string
  expects_source: number
  output_path: string | null
  output_fingerprint: string | null
  output_size: number | null
  source_path: string | null
  source_fingerprint: string | null
  source_size: number | null
}

function fingerprint(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

/** Durable recovery owner for native image bytes created before gallery admission. */
export class GeneratedImageCreationIntentRepository {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS generated_image_creation_intents (
        request_id TEXT PRIMARY KEY CHECK (trim(request_id) <> ''),
        expects_source INTEGER NOT NULL CHECK (expects_source IN (0, 1)),
        output_path TEXT,
        output_fingerprint TEXT,
        output_size INTEGER,
        source_path TEXT,
        source_fingerprint TEXT,
        source_size INTEGER,
        prepared_at TEXT NOT NULL,
        last_error TEXT
      );
    `)
    const columns = new Set(
      (
        db.prepare('PRAGMA table_info(generated_image_creation_intents)').all() as Array<{
          name: string
        }>
      ).map(({ name }) => name)
    )
    if (!columns.has('output_size')) {
      db.exec('ALTER TABLE generated_image_creation_intents ADD COLUMN output_size INTEGER')
    }
    if (!columns.has('source_size')) {
      db.exec('ALTER TABLE generated_image_creation_intents ADD COLUMN source_size INTEGER')
    }
    this.reconcilePending()
  }

  prepare(requestId: string, expectsSource: boolean): void {
    this.db
      .prepare(
        `INSERT INTO generated_image_creation_intents(
           request_id, expects_source, prepared_at
         ) VALUES (?, ?, ?)`
      )
      .run(requestId, expectsSource ? 1 : 0, new Date().toISOString())
  }

  prebindPath(requestId: string, kind: 'output' | 'source', ownedPath: string): void {
    const pathColumn = `${kind}_path`
    const fingerprintColumn = `${kind}_fingerprint`
    const sizeColumn = `${kind}_size`
    const root = path.join(dataDir(), 'generated-images', ...(kind === 'source' ? ['sources'] : []))
    const destination = resolveOwnedDestination(root, path.basename(ownedPath))
    if (!destination || destination !== path.resolve(ownedPath)) {
      throw new Error('Prepared generated-image destination is outside its owned directory.')
    }
    if (fs.existsSync(destination)) {
      throw new Error('Prepared generated-image destination already exists.')
    }
    const bound = this.db
      .prepare(
        `UPDATE generated_image_creation_intents
         SET ${pathColumn} = ?, ${fingerprintColumn} = NULL, ${sizeColumn} = NULL,
             last_error = NULL
         WHERE request_id = ?`
      )
      .run(destination, requestId)
    if (bound.changes !== 1) {
      throw new Error(`Generated-image creation ${requestId} is not prepared.`)
    }
  }

  sealPath(requestId: string, kind: 'output' | 'source', ownedPath: string): void {
    const pathColumn = `${kind}_path`
    const fingerprintColumn = `${kind}_fingerprint`
    const sizeColumn = `${kind}_size`
    const root = path.join(dataDir(), 'generated-images', ...(kind === 'source' ? ['sources'] : []))
    const owned = resolveExistingOwnedPath(root, ownedPath)
    const prepared = this.db
      .prepare(
        `SELECT ${pathColumn} AS path FROM generated_image_creation_intents WHERE request_id = ?`
      )
      .get(requestId) as { path: string | null } | undefined
    if (!owned || prepared?.path !== owned) {
      throw new Error('Created generated-image path differs from its prepared destination.')
    }
    const bytes = fs.readFileSync(owned)
    this.db
      .prepare(
        `UPDATE generated_image_creation_intents
         SET ${fingerprintColumn} = ?, ${sizeColumn} = ?, last_error = NULL WHERE request_id = ?`
      )
      .run(createHash('sha256').update(bytes).digest('hex'), bytes.byteLength, requestId)
  }

  settleMissingSource(requestId: string): void {
    const row = this.db
      .prepare('SELECT source_path FROM generated_image_creation_intents WHERE request_id = ?')
      .get(requestId) as { source_path: string | null } | undefined
    if (!row?.source_path || fs.existsSync(row.source_path)) {
      throw new Error('The retained source outcome is not safely absent.')
    }
    this.db
      .prepare(
        `UPDATE generated_image_creation_intents
         SET expects_source = 0, source_path = NULL, last_error = NULL WHERE request_id = ?`
      )
      .run(requestId)
  }

  assertPreparedOutput(outputPath: string): void {
    const row = this.db
      .prepare(
        `SELECT 1 FROM generated_image_creation_intents
         WHERE output_path = ? AND output_fingerprint IS NULL AND output_size IS NULL`
      )
      .get(outputPath)
    if (!row) throw new Error('The generated-image output has no active prepared intent.')
  }

  settle(requestId: string): void {
    this.db
      .prepare('DELETE FROM generated_image_creation_intents WHERE request_id = ?')
      .run(requestId)
  }

  recover(requestId: string): void {
    const row = this.db
      .prepare(
        `SELECT request_id, expects_source, output_path, output_fingerprint, output_size,
                source_path, source_fingerprint, source_size
         FROM generated_image_creation_intents WHERE request_id = ?`
      )
      .get(requestId) as CreationIntentRow | undefined
    if (!row) return
    const gallery = this.db
      .prepare('SELECT images_json FROM generated_image_gallery_state WHERE singleton = 1')
      .get() as { images_json: string }
    const admitted = new Map(
      (JSON.parse(gallery.images_json) as GeneratedImageRecord[]).map((image) => [
        image.id,
        image.local.path
      ])
    )
    this.reconcileOne(row, admitted)
  }

  reconcilePending(): void {
    const gallery = this.db
      .prepare('SELECT images_json FROM generated_image_gallery_state WHERE singleton = 1')
      .get() as { images_json: string }
    const admitted = new Map(
      (JSON.parse(gallery.images_json) as GeneratedImageRecord[]).map((image) => [
        image.id,
        image.local.path
      ])
    )
    const rows = this.db
      .prepare(
        `SELECT request_id, expects_source, output_path, output_fingerprint, output_size,
                source_path, source_fingerprint, source_size
         FROM generated_image_creation_intents ORDER BY prepared_at ASC, request_id ASC`
      )
      .all() as CreationIntentRow[]
    for (const row of rows) this.reconcileOne(row, admitted)
  }

  assertSettled(): void {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM generated_image_creation_intents')
      .get()
    if ((row as { count: number }).count !== 0) {
      throw new Error('Generated-image creation recovery evidence is unsafe or incomplete.')
    }
  }

  private reconcileOne(row: CreationIntentRow, admitted: ReadonlyMap<string, string>): void {
    try {
      if (!row.output_path || !row.output_fingerprint || row.output_size === null) {
        throw new Error('Generated output identity was not durably bound.')
      }
      const sourceComplete = Boolean(
        row.source_path && row.source_fingerprint && row.source_size !== null
      )
      if (Boolean(row.expects_source) !== sourceComplete) {
        throw new Error('Retained source identity is incomplete.')
      }
      const admittedPath = admitted.get(row.request_id)
      if (admittedPath) {
        if (admittedPath !== row.output_path) {
          throw new Error('Admitted generated-image path differs from its prepared identity.')
        }
        this.settle(row.request_id)
        return
      }
      this.removeVerified({
        candidate: row.output_path,
        expectedFingerprint: row.output_fingerprint,
        expectedSize: row.output_size,
        source: false
      })
      if (row.source_path && row.source_fingerprint) {
        this.removeVerified({
          candidate: row.source_path,
          expectedFingerprint: row.source_fingerprint,
          expectedSize: row.source_size ?? -1,
          source: true
        })
      }
      this.settle(row.request_id)
    } catch (cause) {
      this.db
        .prepare('UPDATE generated_image_creation_intents SET last_error = ? WHERE request_id = ?')
        .run(cause instanceof Error ? cause.message : String(cause), row.request_id)
    }
  }

  settleAdmitted(requestId: string, outputPath: string): void {
    this.db
      .prepare(
        `DELETE FROM generated_image_creation_intents
         WHERE request_id = ? AND output_path = ? AND output_fingerprint IS NOT NULL
           AND output_size IS NOT NULL
           AND (expects_source = 0 OR (source_fingerprint IS NOT NULL AND source_size IS NOT NULL))`
      )
      .run(requestId, outputPath)
  }

  private removeVerified(input: {
    candidate: string
    expectedFingerprint: string
    expectedSize: number
    source: boolean
  }): void {
    if (!fs.existsSync(input.candidate)) return
    const root = path.join(dataDir(), 'generated-images', ...(input.source ? ['sources'] : []))
    const owned = resolveExistingOwnedPath(root, input.candidate)
    if (!owned) throw new Error('Prepared generated-image path is outside its owned directory.')
    if (
      fs.statSync(owned).size !== input.expectedSize ||
      fingerprint(owned) !== input.expectedFingerprint
    ) {
      throw new Error('Prepared generated-image fingerprint changed.')
    }
    fs.rmSync(owned)
  }
}
