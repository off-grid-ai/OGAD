/**
 * A plain text PDF, one string per page, built without a PDF library.
 *
 * Specs that attach a document need a real PDF that pdf.js reads page by page. The file holds one
 * Helvetica font, one content stream per page with each line drawn as text, and the cross-reference
 * table that readers use to find the objects.
 */
const escapePdf = (text: string): string => text.replace(/[\\()]/g, (char) => `\\${char}`)

/** Wraps a page's text into lines short enough for a Letter page at 11 pt. */
const lines = (text: string, width = 90): string[] => {
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + word.length + 1 > width) {
      out.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) out.push(line)
  return out
}

export const textPdf = (pages: readonly string[]): Buffer => {
  const objects: string[] = []
  const add = (body: string): number => objects.push(body)
  const catalog = add('')
  const pageTree = add('')
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const kids: number[] = []
  for (const text of pages) {
    const drawn = lines(text)
      .map((line, index) => `${index === 0 ? '' : 'T* '}(${escapePdf(line)}) Tj`)
      .join('\n')
    const stream = `BT /F1 11 Tf 14 TL 72 740 Td\n${drawn}\nET`
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)
    kids.push(
      add(
        `<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`
      )
    )
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pageTree} 0 R >>`
  objects[pageTree - 1] =
    `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(' ')}] /Count ${kids.length} >>`

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}
