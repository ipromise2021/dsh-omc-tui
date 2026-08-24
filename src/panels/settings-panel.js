import { ANSI as defaultAnsi } from '../renderer/themes.js'

export const SETTINGS_KEYS = ['theme', 'statusline', 'contextMode', 'contextWarnAt', 'contextCriticalAt', 'hudGit', 'hudSpeed', 'hudTools', 'persistHistory']

export function renderSettingsPicker(settingsPicker, preferences, ANSI = defaultAnsi) {
  const descriptions = {
    theme: 'color theme (claude / deepseek / mono / light)',
    statusline: 'density: detailed (4 rows), compact (2 rows), minimal (1 row)',
    'context display': 'cumulative session context: both / percent / tokens / remaining',
    'context warning': 'amber warning threshold (percent full)',
    'context critical': 'coral critical threshold (percent full)',
    'statusline git': 'show git branch & dirty status in statusline',
    'statusline speed': 'show token speed & turn timing in statusline',
    'statusline tools': 'show recent tool activity in statusline',
    'history persistence': 'save sessions to disk for /resume'
  }
  const entries = [
    ['theme', preferences.theme, descriptions.theme],
    ['statusline density', preferences.statusline ?? 'detailed', descriptions.statusline],
    ['context display', preferences.contextMode ?? 'both', descriptions['context display']],
    ['context warning', `${preferences.contextWarnAt ?? 60}%`, descriptions['context warning']],
    ['context critical', `${preferences.contextCriticalAt ?? 80}%`, descriptions['context critical']],
    ['statusline git', (preferences.hudGit ?? true) ? 'on' : 'off', descriptions['statusline git']],
    ['statusline speed', (preferences.hudSpeed ?? true) ? 'on' : 'off', descriptions['statusline speed']],
    ['statusline tools', (preferences.hudTools ?? true) ? 'on' : 'off', descriptions['statusline tools']],
    ['history persistence', preferences.persistHistory ? 'on' : 'off', descriptions['history persistence']]
  ]
  return [
    `${ANSI.muted}TUI SETTINGS${ANSI.reset} ${ANSI.dim}· stored in $DSH_HOME/settings.yaml (default ~/.dsh/settings.yaml)${ANSI.reset}`,
    '',
    ...entries.map(([name, value, desc], index) => {
      const cursor = index === settingsPicker.selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
      const label = name.padEnd(22, ' ')
      const valStr = String(value).padEnd(10, ' ')
      return `${cursor}  ${ANSI.blueSoft}${label}${ANSI.reset} ${ANSI.dim}·${ANSI.reset}  ${ANSI.ink}${valStr}${ANSI.reset}  ${ANSI.dim}${desc}${ANSI.reset}`
    }),
    '',
    `${ANSI.muted}↑↓ select  ·  ← → or Enter / Space change  ·  Esc close${ANSI.reset}`
  ]
}
