import { ANSI as defaultAnsi } from '../renderer/themes.js'

export function renderSettingsPicker(settingsPicker, preferences, ANSI = defaultAnsi) {
  const descriptions = {
    theme: 'color theme (claude / deepseek / mono / light)',
    statusline: 'density: detailed (4 rows), compact (2 rows), minimal (1 row)',
    'history persistence': 'save sessions to disk for /resume'
  }
  const entries = [
    ['theme', preferences.theme, descriptions.theme],
    ['statusline density', preferences.statusline ?? 'detailed', descriptions.statusline],
    ['history persistence', preferences.persistHistory ? 'on' : 'off', descriptions['history persistence']]
  ]
  return [
    `${ANSI.muted}TUI SETTINGS${ANSI.reset} ${ANSI.dim}· stored in ~/.dsh/settings.yaml${ANSI.reset}`,
    '',
    ...entries.map(([name, value, desc], index) => {
      const cursor = index === settingsPicker.selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
      const label = name.padEnd(22, ' ')
      const valStr = String(value).padEnd(10, ' ')
      return `${cursor}  ${ANSI.blueSoft}${label}${ANSI.reset} ${ANSI.dim}·${ANSI.reset}  ${ANSI.ink}${valStr}${ANSI.reset}  ${ANSI.dim}${desc}${ANSI.reset}`
    }),
    '',
    `${ANSI.muted}↑↓ select  ·  ← → or Enter change  ·  Esc close${ANSI.reset}`
  ]
}
