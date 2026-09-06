/** Sanitise a file name for use in a temp/persisted path: collapse any run of
 *  characters outside [word chars, dot, dash] to a single underscore. */
export function sanitizeUploadName(name: string): string {
  return name.replace(/[^\w.-]+/g, '_')
}
