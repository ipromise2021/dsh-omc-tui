import { safe, shorten } from '../renderer/ansi.js'
import { ANSI as defaultAnsi } from '../renderer/themes.js'

export function renderSkillsPanel(skillsPanel, skills = [], capacity, columns, ANSI = defaultAnsi) {
  const slots = Math.max(1, capacity - 2)
  const start = Math.min(Math.max(0, skillsPanel.selected - slots + 1), Math.max(0, skills.length - slots))
  const shown = skills.slice(start, start + slots)
  const enabled = skills.filter((skill) => skill.enabled !== false).length
  return [
    `${ANSI.muted}SKILLS${ANSI.reset} ${ANSI.dim}· ${enabled} on · ${skills.length - enabled} off${ANSI.reset}`,
    '',
    ...(shown.length === 0
      ? [`${ANSI.dim}no skills loaded in this workspace${ANSI.reset}`]
      : shown.map((skill, index) => {
          const isSelected = index + start === skillsPanel.selected
          const marker = isSelected ? `${ANSI.blue}>${ANSI.reset}` : ' '
          const nameColor = isSelected ? (ANSI.peach ?? ANSI.blueSoft) : ANSI.dim
          const descColor = isSelected ? ANSI.ink : ANSI.dim
          const state = skill.enabled === false ? `${ANSI.coral ?? ANSI.dim}off${ANSI.reset}` : `${ANSI.teal}on${ANSI.reset}`
          const desc = shorten(safe(skill.description ?? ''), Math.max(20, columns - 38))
          return `${marker}  ${nameColor}/${safe(skill.name)}${ANSI.reset}  ${state}  ${descColor}${desc}${ANSI.reset}`
        })),
    '',
    `${ANSI.muted}↑↓ navigate  ·  Enter / Space on/off  ·  Esc close${ANSI.reset}`
  ]
}
