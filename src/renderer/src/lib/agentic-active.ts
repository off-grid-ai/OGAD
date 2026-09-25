// Whether the user explicitly enabled Assistant or Connectors in the composer.
// Main Chat uses the tool-capable path for every memory scope; this flag only
// prevents automatic image routing when one of these controls owns the turn.
export function isAgenticTurn(opts: { toolsOn: boolean; connectorsOn: boolean }): boolean {
  return opts.toolsOn || opts.connectorsOn
}
