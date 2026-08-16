import { ANSI as defaultAnsi } from '../renderer/themes.js'

export function renderEffortPicker(effortPicker, ANSI = defaultAnsi) {
  const labels = effortPicker.efforts.map((effort, index) => {
    const selected = index === effortPicker.selected
    return selected
      ? `${ANSI.blue}[ ${effort.toUpperCase()} ]${ANSI.reset}`
      : `${ANSI.dim}  ${effort.toUpperCase()}  ${ANSI.reset}`
  })
  return [
    `${ANSI.muted}REASONING EFFORT${ANSI.reset}`,
    '',
    `  ${labels.join(`${ANSI.dim}  ·  ${ANSI.reset}`)}`,
    '',
    `${ANSI.muted}← → choose  ·  Enter or Tab select  ·  Esc close${ANSI.reset}`
  ]
}
