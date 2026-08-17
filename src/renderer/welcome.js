import { widthOf, visibleOf, truncateWidth } from './ansi.js'
import { ANSI as defaultAnsi } from './themes.js'

export function welcomeCardRows(columns, workspace, model, effort, ANSI = defaultAnsi) {
  const outerWidth = Math.min(72, Math.max(52, columns - 6))
  const innerWidth = outerWidth - 4
  const modelValue = truncateWidth(model, Math.max(20, innerWidth - 18))
  const workspaceValue = truncateWidth(workspace, Math.max(20, innerWidth - 16))
  const row = (content = '') => {
    const text = widthOf(visibleOf(content)) > innerWidth
      ? `${ANSI.muted}${truncateWidth(visibleOf(content), innerWidth)}${ANSI.reset}`
      : content
    return `${ANSI.rule}│ ${ANSI.reset}${text}${' '.repeat(Math.max(0, innerWidth - widthOf(visibleOf(text))))}${ANSI.rule} │${ANSI.reset}`
  }
  return [
    `${ANSI.rule}╭${'─'.repeat(outerWidth - 2)}╮${ANSI.reset}`,
    row(`${ANSI.blue}✻${ANSI.reset} ${ANSI.bold}DSH OMC${ANSI.reset} ${ANSI.muted}Oh-My-Claude · keyboard-first terminal${ANSI.reset}`),
    row(),
    row(`${ANSI.muted}model     ${ANSI.reset}${ANSI.blueSoft}${modelValue}${ANSI.reset} ${ANSI.blue}${effort}${ANSI.reset}`),
    row(`${ANSI.muted}directory ${ANSI.reset}${ANSI.ink}${workspaceValue}${ANSI.reset}`),
    row(),
    row(`${ANSI.muted}/ commands${ANSI.reset} ${ANSI.dim}·${ANSI.reset} ${ANSI.muted}@ files${ANSI.reset} ${ANSI.dim}·${ANSI.reset} ${ANSI.muted}Cmd+V images${ANSI.reset} ${ANSI.dim}·${ANSI.reset} ${ANSI.muted}Shift+Tab permission${ANSI.reset}`),
    `${ANSI.rule}╰${'─'.repeat(outerWidth - 2)}╯${ANSI.reset}`,
    '',
    `${ANSI.blueSoft}Tip:${ANSI.reset} ${ANSI.muted}enter a message to start  ·  ? shortcuts  ·  /effort reasoning level${ANSI.reset}`
  ]
}
