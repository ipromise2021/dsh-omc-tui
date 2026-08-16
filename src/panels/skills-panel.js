import { safe, shorten } from '../renderer/ansi.js'
import { ANSI as defaultAnsi } from '../renderer/themes.js'

export function renderSkillsPanel(skillsPanel, skills = [], capacity, columns, ANSI = defaultAnsi) {
  const slots = Math.max(1, capacity - 2)
  const start = Math.min(Math.max(0, skillsPanel.selected - slots + 1), Math.max(0, skills.length - slots))
  const shown = skills.slice(start, start + slots)
  return [
    `${ANSI.muted}SKILLS${ANSI.reset} ${ANSI.dim}· ${skills.length} loaded${ANSI.reset}`,
    '',
    ...(shown.length === 0
      ? [`${ANSI.dim}no skills loaded in this workspace${ANSI.reset}`]
      : shown.map((skill, index) => {
          const isSelected = index + start === skillsPanel.selected
          const marker = isSelected ? `${ANSI.blue}>${ANSI.reset}` : ' '
          const nameColor = isSelected ? (ANSI.peach ?? ANSI.blueSoft) : ANSI.dim
          const descColor = isSelected ? ANSI.ink : ANSI.dim
          const desc = shorten(safe(skill.description ?? ''), Math.max(20, columns - 32))
          return `${marker}  ${nameColor}/${safe(skill.name)}${ANSI.reset}  ${descColor}${desc}${ANSI.reset}`
        })),
    '',
    `${ANSI.muted}↑↓ navigate  ·  Esc close${ANSI.reset}`
  ]
}
