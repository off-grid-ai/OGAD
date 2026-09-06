import { describe, expect, it } from 'vitest'
import {
  createVitestProjects,
  modelPortIntegrationTests,
  packagingIntegrationTests,
  type VitestProjectDefinition
} from './vitest-projects'

const projects = createVitestProjects(['src/**/*.test.ts'], ['node_modules/**'])

function project(name: string): VitestProjectDefinition['test'] {
  const value = projects.find((candidate) => candidate.test.name === name)?.test
  if (!value) throw new Error(`Missing Vitest project ${name}`)
  return value
}

describe('Vitest exclusive model-port scheduling', () => {
  it('runs every :8439 owner once in one sequential project before packaging', () => {
    const product = project('product-integration')
    const modelPort = project('model-port-integration')
    const packaging = project('packaging-integration')

    expect(modelPort.include).toEqual(modelPortIntegrationTests)
    expect(modelPort.fileParallelism).toBe(false)
    expect(modelPort.sequence?.groupOrder).toBe(2)
    expect(product.exclude).toEqual(expect.arrayContaining(modelPortIntegrationTests))
    expect(packaging.include).toEqual(packagingIntegrationTests)
    expect(packaging.fileParallelism).toBe(false)
    expect(product.exclude).toEqual(expect.arrayContaining(packagingIntegrationTests))
    expect(packaging.sequence?.groupOrder).toBeGreaterThan(modelPort.sequence?.groupOrder ?? 0)
  })
})
