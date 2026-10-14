import fs from 'node:fs/promises'
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool'

const dir = new URL('.', import.meta.url).pathname
const data = JSON.parse(await fs.readFile(`${dir}tracker-data.json`, 'utf8'))
const wb = Workbook.create()
const sh = wb.worksheets.add('Release tracker')
sh.showGridLines = false
const last = 8 + data.rows.length
sh.getRange(`A1:I${last}`).format.font = { name: 'Arial', size: 10, color: '#202630' }
sh.getRange(`A1:I${last}`).format.verticalAlignment = 'center'
sh.getRange('A2').values = [['Off Grid AI release tracker']]
sh.getRange('A2').format.font = { name: 'Arial', size: 16, bold: true }
sh.getRange('A3').values = [[`Updated ${data.updated} IST. Desktop chat owns this tracker.`]]
sh.getRange('A3').format.font = { name: 'Arial', size: 10, italic: true, color: '#5D6674' }
sh.getRange('A5').values = [['Open checks']]
sh.getRange('B5').formulas = [[`=COUNTA(A9:A${last})-COUNTIFS(E9:E${last},"Passed")`]]
sh.getRange('D5').values = [['Passed checks']]
sh.getRange('E5').formulas = [[`=COUNTIFS(E9:E${last},"Passed")`]]
sh.getRange('A7').values = [['Each product chat owns its code. Shared changes need coordination. CI pass does not close manual checks.']]
sh.getRange('A8:G8').values = [['ID', 'Product', 'Owner', 'Check', 'Status', 'Evidence', 'Next action']]
sh.getRange('I8').values = [['Source']]
sh.getRange(`A9:G${last}`).values = data.rows.map(r => r.slice(0,7))
sh.getRange(`I9:I${last}`).values = data.rows.map(r => [r[7]])
sh.tables.add(`A8:G${last}`, true, 'ReleaseChecks')
sh.getRange('A8:G8').format.fill = '#293548'
sh.getRange('A8:G8').format.font = { name: 'Arial', size: 10, bold: true, color: '#FFFFFF' }
sh.getRange('A8:G8').format.horizontalAlignment = 'center'
sh.getRange(`B9:I${last}`).format.wrapText = true
sh.getRange(`A9:I${last}`).format.rowHeight = 80
sh.getRange('A1:A3').format.rowHeight = 25
for (const [column,width] of [['A',11],['B',22],['C',22],['D',29],['E',15],['F',43],['G',43],['H',3],['I',50]]) {
  sh.getRange(`${column}1:${column}${last}`).format.columnWidth = width
}
sh.getRange(`E9:E${last}`).dataValidation = {rule:{type:'list',values:['Passed','Running','Open','Blocked','Not checked']}}
sh.getRange(`E9:E${last}`).conditionalFormats.add('containsText', {text:'Blocked',format:{fill:'#FDE9E7',font:{bold:true,color:'#A62321'}}})
sh.getRange(`E9:E${last}`).conditionalFormats.add('containsText', {text:'Running',format:{fill:'#FFF0CB',font:{color:'#755300'}}})
sh.getRange(`E9:E${last}`).conditionalFormats.add('containsText', {text:'Not checked',format:{fill:'#FFF0CB',font:{color:'#755300'}}})
sh.freezePanes.freezeRows(8)
wb.recalculate()
console.log((await wb.inspect({kind:'table',range:'Release tracker!A5:G12',include:'values,formulas',tableMaxRows:8,tableMaxCols:7,maxChars:1800})).ndjson)
console.log((await wb.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#NUM!|#NULL!',options:{useRegex:true,maxResults:10},maxChars:1000})).ndjson)
const preview = await wb.render({sheetName:'Release tracker',range:`A1:I${last}`,scale:1,format:'png'})
await fs.writeFile(`${dir}tracker-preview.png`,new Uint8Array(await preview.arrayBuffer()))
await (await SpreadsheetFile.exportXlsx(wb)).save(`${dir}release-tracker.xlsx`)
