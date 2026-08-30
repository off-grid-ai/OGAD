const PRODUCT_TOOL_NAMES: Readonly<Record<string, string>> = {
  web_use: 'Web Use',
  computer_use: 'Computer Use'
}

function normalizedToolName(name: string): string {
  return name
    .replace(/^mcp__\d+__/, '')
    .replace(/^mcp_\d+_+/, '')
    .replace(/^pro:/, '')
    .toLowerCase()
}

export function productToolName(name: string): string {
  const normalized = normalizedToolName(name)
  return PRODUCT_TOOL_NAMES[normalized] ?? name
}

export function runningToolLabel(name: string | undefined): string {
  return `Running ${name ? productToolName(name) : 'tool'}…`
}
