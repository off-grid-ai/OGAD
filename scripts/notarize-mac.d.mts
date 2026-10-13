export interface NotarizeCredentials {
  appleApiKey: string
  appleApiKeyId: string
  appleApiIssuer: string
}

export interface AppleNotaryBoundary {
  notarize(options: { tool: 'notarytool'; appPath: string } & NotarizeCredentials): Promise<void>
  staple(appPath: string): Promise<unknown>
  wait(ms: number): Promise<void>
}

export function notarizeCredentials(
  environment: Record<string, string | undefined>
): NotarizeCredentials | undefined
export function stapleWithRetry(appPath: string, boundary?: AppleNotaryBoundary): Promise<unknown>
export function notarizeAndStaple(
  appPath: string,
  credentials: NotarizeCredentials,
  boundary?: AppleNotaryBoundary
): Promise<void>
export default function notarizeMac(context: unknown): Promise<void>
