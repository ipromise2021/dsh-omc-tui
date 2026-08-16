import { ANSI as defaultAnsi } from '../renderer/themes.js'

export function renderMcpPanel(mcpPanel, capacity, ANSI = defaultAnsi) {
  const entries = mcpPanel.entries
  if (entries.length === 0) {
    return [
      `${ANSI.muted}MCP SERVERS${ANSI.reset}`,
      '',
      `  ${ANSI.blueSoft}⠋ loading MCP servers…${ANSI.reset}`,
      '',
      `${ANSI.muted}Esc close${ANSI.reset}`
    ]
  }
  const start = Math.min(Math.max(0, mcpPanel.selected - capacity + 1), Math.max(0, entries.length - capacity))
  const shown = entries.slice(start, start + capacity)
  const unknown = entries.filter((entry) => entry.connected === undefined).length
  const rowsOut = [
    `${ANSI.muted}MCP SERVERS${ANSI.reset}  ${ANSI.dim}· ${entries.length} configured${ANSI.reset}`,
    '',
    ...shown.map((entry, index) => {
      const marker = index + start === mcpPanel.selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
      const status = entry.connected === undefined || entry.connecting
        ? `${ANSI.blueSoft}⠋ loading…${ANSI.reset}`
        : entry.connected
          ? `${ANSI.bash}✓ connected${ANSI.reset} ${ANSI.dim}· ${entry.toolCount} tool${entry.toolCount === 1 ? '' : 's'}${ANSI.reset}`
          : `${ANSI.coral}✗ failed${ANSI.reset}`
      return `${marker}  ${ANSI.blueSoft}${entry.name}${ANSI.reset} ${ANSI.dim}· ${entry.transport}${ANSI.reset}  ${status}`
    }),
    '',
    `${ANSI.muted}↑↓ navigate  ·  Esc close${ANSI.reset}`
  ]
  if (mcpPanel.failed > 0) {
    rowsOut.splice(rowsOut.length - 2, 0, `${ANSI.dim}※ ${mcpPanel.failed} failed · check the server process or credentials${ANSI.reset}`)
  } else if (unknown > 0) {
    rowsOut.splice(rowsOut.length - 2, 0, `${ANSI.dim}※ ${unknown} initializing in background…${ANSI.reset}`)
  }
  return rowsOut
}
