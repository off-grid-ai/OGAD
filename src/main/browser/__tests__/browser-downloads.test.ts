import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DownloadItem, Session } from 'electron'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserDownloads } from '../browser-downloads'

type State = ReturnType<DownloadItem['getState']>

/** Electron's DownloadItem at its boundary: a name, a save path and its lifecycle events. */
class FakeDownload extends EventEmitter {
  savePath = ''
  state: State = 'progressing'
  resumable = false
  constructor(private readonly name: string) {
    super()
  }
  getFilename = (): string => this.name
  getURL = (): string => `https://files.example.test/${this.name}`
  setSavePath = (file: string): void => void (this.savePath = file)
  getSavePath = (): string => this.savePath
  getReceivedBytes = (): number => 0
  getTotalBytes = (): number => 10
  getState = (): State => this.state
  isPaused = (): boolean => false
  canResume = (): boolean => this.resumable
  finish(state: State, resumable = false): void {
    this.state = state
    this.resumable = resumable
    this.emit('done', {}, state)
  }
}

describe('downloads that start together', () => {
  let directory: string
  let session: EventEmitter
  let downloads: BrowserDownloads

  const start = (name: string): FakeDownload => {
    const item = new FakeDownload(name)
    session.emit('will-download', {}, item as unknown as DownloadItem)
    return item
  }

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-downloads-'))
    session = new EventEmitter()
    downloads = new BrowserDownloads(
      () => directory,
      () => undefined
    )
    downloads.attach(session as unknown as Session)
  })

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))

  it('give two same-name downloads their own files before either file exists', () => {
    const first = start('report.pdf')
    const second = start('report.pdf')
    expect(first.savePath).toBe(path.join(directory, 'report.pdf'))
    expect(second.savePath).toBe(path.join(directory, 'report (1).pdf'))
  })

  it('treat names that differ only in case as the same file', () => {
    const first = start('Report.pdf')
    const second = start('report.pdf')
    expect(second.savePath).not.toBe(path.join(directory, 'report.pdf'))
    expect(second.savePath.toLowerCase()).not.toBe(first.savePath.toLowerCase())
  })

  it('free the name once a download ends', () => {
    start('report.pdf').finish('cancelled')
    expect(start('report.pdf').savePath).toBe(path.join(directory, 'report.pdf'))
  })

  it('hold the name while an interrupted download can still resume', () => {
    const first = start('report.pdf')
    first.finish('interrupted', true)
    expect(start('report.pdf').savePath).toBe(path.join(directory, 'report (1).pdf'))
    first.finish('completed')
    fs.writeFileSync(first.savePath, 'done')
    expect(start('report.pdf').savePath).toBe(path.join(directory, 'report (2).pdf'))
  })

  it('free the name of an interrupted download cleared from the list', () => {
    start('report.pdf').finish('interrupted', true)
    downloads.clearFinished()
    expect(start('report.pdf').savePath).toBe(path.join(directory, 'report.pdf'))
  })
})
