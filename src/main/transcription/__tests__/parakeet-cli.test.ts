import { describe, it, expect } from 'vitest'
import {
  buildParakeetArgs,
  parseParakeetOutput,
  parseParakeetResults,
  matchSherpaFiles,
  activeMatchesEntry,
  type ParakeetModel
} from '../parakeet-cli'

const model: ParakeetModel = {
  family: 'nemo-transducer',
  files: {
    encoder: '/m/encoder.onnx',
    decoder: '/m/decoder.onnx',
    joiner: '/m/joiner.onnx',
    tokens: '/m/tokens.txt'
  }
}

describe('buildParakeetArgs', () => {
  it('loads a Parakeet TDT as a NeMo transducer, then the thread count, then the wavs last', () => {
    expect(buildParakeetArgs(model, ['/tmp/a.wav', '/tmp/b.wav'], 6)).toEqual([
      '--tokens=/m/tokens.txt',
      '--encoder=/m/encoder.onnx',
      '--decoder=/m/decoder.onnx',
      '--joiner=/m/joiner.onnx',
      '--model-type=nemo_transducer',
      '--num-threads=6',
      '--decoding-method=greedy_search',
      '/tmp/a.wav',
      '/tmp/b.wav'
    ])
  })

  it('defaults the thread count', () => {
    expect(buildParakeetArgs(model, '/tmp/a.wav')).toContain('--num-threads=4')
  })
})

describe('parseParakeetResults', () => {
  it('reads one transcript per wav from the JSON lines sherpa-onnx v2 prints on stdout', () => {
    const stdout =
      '{"lang": "", "emotion": "", "event": "", "text": "first piece", "timestamps": []}\n' +
      '{"lang": "", "emotion": "", "event": "", "text": "", "timestamps": []}\n' +
      '{"lang": "", "emotion": "", "event": "", "text": "third piece", "timestamps": []}\n'
    expect(parseParakeetResults(stdout)).toEqual(['first piece', '', 'third piece'])
  })
})

describe('parseParakeetOutput', () => {
  it('reads a JSON "text" field', () => {
    expect(parseParakeetOutput('{"text": "hello world"}')).toBe('hello world')
  })

  it('reads a text: line', () => {
    expect(parseParakeetOutput('/tmp/a.wav\ntext: hello there')).toBe('hello there')
  })

  it('reads a text= line', () => {
    expect(parseParakeetOutput('Done\ntext=quick brown fox')).toBe('quick brown fox')
  })

  it('prefers the JSON form when both appear', () => {
    expect(parseParakeetOutput('text: old\n{"text": "new"}')).toBe('new')
  })

  it('unescapes quotes and newlines in JSON text', () => {
    expect(parseParakeetOutput('{"text": "she said \\"hi\\"\\nbye"}')).toBe('she said "hi" bye')
  })

  it('takes the last text line when several are printed', () => {
    expect(parseParakeetOutput('text: first\ntext: second')).toBe('second')
  })

  it('returns empty string on unrecognized output', () => {
    expect(parseParakeetOutput('no transcript here')).toBe('')
  })

  it('parses REAL sherpa-onnx-offline v1.13.3 output (Parakeet TDT, captured on-device)', () => {
    // Verbatim stdout shape from the staged static binary: a JSON object whose FIRST
    // string keys are empty (lang/emotion/event) before "text". The parser must pick the
    // "text" field, not an earlier empty one, and keep punctuation/apostrophes.
    const real =
      '{"lang": "", "emotion": "", "event": "", "text": "Well, I don\'t wish to see it any more, observed Phebe, turning away her eyes.", "timestamps": [0.40, 0.64], "tokens": [" Well", ","], "words": []}'
    expect(parseParakeetOutput(real)).toBe(
      "Well, I don't wish to see it any more, observed Phebe, turning away her eyes."
    )
  })
})

describe('matchSherpaFiles', () => {
  it('picks the four roles from slug-prefixed catalog names', () => {
    const m = matchSherpaFiles('nemo-transducer', [
      'parakeet-v2.encoder.int8.onnx',
      'parakeet-v2.decoder.int8.onnx',
      'parakeet-v2.joiner.int8.onnx',
      'parakeet-v2.tokens.txt'
    ])
    expect(m).toEqual({
      encoder: 'parakeet-v2.encoder.int8.onnx',
      decoder: 'parakeet-v2.decoder.int8.onnx',
      joiner: 'parakeet-v2.joiner.int8.onnx',
      tokens: 'parakeet-v2.tokens.txt'
    })
  })

  it('requires .onnx for the model parts and .txt for tokens', () => {
    // a stray "encoder" text file must not satisfy the encoder role
    expect(
      matchSherpaFiles('nemo-transducer', [
        'encoder.txt',
        'decoder.onnx',
        'joiner.onnx',
        'tokens.txt'
      ])
    ).toBeNull()
  })

  it('returns null when a role is missing', () => {
    expect(
      matchSherpaFiles('nemo-transducer', ['encoder.onnx', 'decoder.onnx', 'tokens.txt'])
    ).toBeNull()
  })
})

describe('activeMatchesEntry', () => {
  const entry = {
    id: 'csukuangfj/parakeet-v2',
    files: [{ name: 'parakeet-v2.encoder.int8.onnx' }, { name: 'parakeet-v2.tokens.txt' }]
  }

  it('matches by catalog id', () => {
    expect(activeMatchesEntry('csukuangfj/parakeet-v2', entry)).toBe(true)
  })

  it('matches by a primary/on-disk filename (active-slot may store the filename)', () => {
    expect(activeMatchesEntry('parakeet-v2.encoder.int8.onnx', entry)).toBe(true)
  })

  it('does not match a different pick', () => {
    expect(activeMatchesEntry('ggml-base.bin', entry)).toBe(false)
  })

  it('returns false when nothing is active', () => {
    expect(activeMatchesEntry(null, entry)).toBe(false)
  })
})
