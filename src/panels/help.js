import { ANSI as defaultAnsi } from '../renderer/themes.js'

export function renderHelpPanel(columns, ANSI = defaultAnsi) {
  return [
    `${ANSI.muted}? shortcuts${ANSI.reset}  ${ANSI.dim}·  ${ANSI.blue}Esc${ANSI.reset} close${ANSI.reset}`,
    '',
    `  ${ANSI.blue}Enter${ANSI.reset} send  ·  ${ANSI.blue}Ctrl+J${ANSI.reset} new line  ·  ${ANSI.blue}Ctrl+C${ANSI.reset} interrupt  ·  ${ANSI.blue}Esc${ANSI.reset} interrupt running turn`,
    `  ${ANSI.blue}↑↓${ANSI.reset} history  ·  ${ANSI.blue}←→${ANSI.reset} cursor  ·  ${ANSI.blue}Ctrl+A/E${ANSI.reset} line start/end  ·  ${ANSI.blue}Ctrl+K${ANSI.reset} delete line  ·  ${ANSI.blue}Alt+←→${ANSI.reset} word`,
    `  ${ANSI.blue}Ctrl+O${ANSI.reset} expand/collapse reasoning  ·  ${ANSI.blue}Ctrl+E${ANSI.reset} edit in $EDITOR  ·  ${ANSI.blue}Ctrl+F${ANSI.reset} search history`,
    `  ${ANSI.blue}Shift+Tab${ANSI.reset} permission  ·  ${ANSI.blue}@${ANSI.reset} files  ·  ${ANSI.blue}Cmd+V${ANSI.reset} image  ·  ${ANSI.blue}/${ANSI.reset} commands  ·  ${ANSI.blue}/exit${ANSI.reset} leave`,
    ''
  ]
}
