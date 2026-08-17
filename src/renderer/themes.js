// ── theme registry & schemas ─────────────────────────────────────────────
// Supported palettes: claude (default) | deepseek | mono | light

export const THEMES = {
  claude: {
    terracotta: '\x1b[38;5;209m', // Claude signature terracotta/coral #ff875f
    amber: '\x1b[38;5;214m',      // Warm golden amber #ffaf00
    peach: '\x1b[38;5;215m',      // Soft peach #ffaf5f
    teal: '\x1b[38;5;215m',       // Unified warm peach for secondary accents #ffaf5f
    cyan: '\x1b[38;5;214m',       // Unified warm golden amber #ffaf00
    blue: '\x1b[38;5;209m',       // Primary accent (Claude terracotta)
    blueSoft: '\x1b[38;5;215m',   // Secondary accent (warm peach)
    ink: '\x1b[38;5;251m',        // Soft bright off-white #c6c6c6 (non-glare)
    answer: '\x1b[38;5;250m',     // Comfortable soft light gray #bcbcbc
    detail: '\x1b[38;5;245m',     // Medium slate gray #8a8a8a
    dim: '\x1b[38;5;241m',        // Dark slate gray #626262
    muted: '\x1b[38;5;245m',      // Neutral slate #8a8a8a
    rule: '\x1b[38;5;238m',       // Subtle sleek dark divider line
    coral: '\x1b[38;5;203m',      // Warning coral
    pink: '\x1b[38;5;213m',       // Bright lavender pink for active option #ff87ff
    bash: '\x1b[1;38;5;214m',     // Warm golden amber #ffaf00 (bold)
    bar: '\x1b[38;5;241m',        // Crisp visible track on dark backgrounds #626262
    barFill: '\x1b[38;5;108m',    // Deeper sage green meter fill
    userBg: '\x1b[48;5;237m'
  },
  deepseek: {
    terracotta: '\x1b[38;5;209m',
    amber: '\x1b[38;5;220m',      // Lighter golden amber
    peach: '\x1b[38;5;117m',      // Lighter sky blue #87d7ff
    teal: '\x1b[38;5;80m',        // Lighter teal cyan
    cyan: '\x1b[38;5;80m',
    blue: '\x1b[38;5;74m',        // Lighter DeepSeek blue #5fafd7
    blueSoft: '\x1b[38;5;117m',   // Light sky blue
    ink: '\x1b[38;5;251m',        // Soft bright off-white #c6c6c6
    answer: '\x1b[38;5;250m',     // Comfortable soft light gray #bcbcbc
    detail: '\x1b[38;5;246m',     // Lighter medium gray
    dim: '\x1b[38;5;242m',        // Lighter dim gray
    muted: '\x1b[38;5;245m',      // Lighter neutral
    rule: '\x1b[38;5;240m',       // Lighter divider
    coral: '\x1b[38;5;210m',      // Lighter warning coral
    pink: '\x1b[38;5;213m',       // Bright lavender pink
    bash: '\x1b[1;38;5;220m',     // Lighter golden amber (bold)
    bar: '\x1b[38;5;241m',        // Crisp visible track on dark backgrounds
    barFill: '\x1b[38;5;80m',     // Lighter blue fill
    userBg: '\x1b[48;5;236m'      // Slightly lighter bg
  },
  mono: {
    terracotta: '\x1b[1;37m',
    amber: '\x1b[1;37m',
    peach: '\x1b[37m',
    teal: '\x1b[37m',
    cyan: '\x1b[37m',
    blue: '\x1b[1;37m',
    blueSoft: '\x1b[37m',
    ink: '\x1b[38;5;251m',
    answer: '\x1b[38;5;249m',
    detail: '\x1b[38;5;244m',
    dim: '\x1b[38;5;240m',
    muted: '\x1b[38;5;240m',
    rule: '\x1b[38;5;238m',
    coral: '\x1b[38;5;203m',
    bash: '\x1b[1;38;5;214m',     // Warm golden amber (bold)
    bar: '\x1b[38;5;238m',
    barFill: '\x1b[38;5;249m',
    userBg: '\x1b[48;5;238m'
  },
  light: {
    terracotta: '\x1b[38;5;166m',
    amber: '\x1b[38;5;172m',
    peach: '\x1b[38;5;130m',
    teal: '\x1b[38;5;24m',
    cyan: '\x1b[38;5;24m',
    blue: '\x1b[38;5;166m',
    blueSoft: '\x1b[38;5;130m',
    ink: '\x1b[38;5;234m',
    answer: '\x1b[38;5;236m',
    detail: '\x1b[38;5;245m',
    dim: '\x1b[38;5;248m',
    muted: '\x1b[38;5;245m',
    rule: '\x1b[38;5;250m',
    coral: '\x1b[38;5;160m',
    bash: '\x1b[1;38;5;172m',     // Warm rich amber for light bg
    bar: '\x1b[38;5;250m',
    barFill: '\x1b[38;5;28m',
    userBg: '\x1b[48;5;252m'
  }
}

export const defaultTheme = Object.hasOwn(THEMES, process.env.DSH_TUI_THEME) ? process.env.DSH_TUI_THEME : 'claude'

export let ANSI = { reset: '\x1b[0m', bold: '\x1b[1m', ...THEMES[defaultTheme] }

export function applyTheme(theme) {
  ANSI = { reset: '\x1b[0m', bold: '\x1b[1m', ...(THEMES[theme] ?? THEMES.claude) }
  return ANSI
}

export const TERMINAL_MOUSE_OFF = '\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1007l'

export const STATUSLINE_MODES = ['detailed', 'compact', 'minimal']

export function tuiSettingsSchema(value) {
  if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    throw new TypeError('dsh-omc-tui settings must be an object')
  }
  const source = value ?? {}
  const theme = source.theme ?? defaultTheme
  if (!Object.hasOwn(THEMES, theme)) {
    throw new TypeError(`dsh-omc-tui.settings.theme must be one of: ${Object.keys(THEMES).join(', ')}`)
  }
  const statusline = source.statusline ?? 'detailed'
  if (!STATUSLINE_MODES.includes(statusline)) {
    throw new TypeError(`dsh-omc-tui.settings.statusline must be one of: ${STATUSLINE_MODES.join(', ')}`)
  }
  if (source.persistHistory !== undefined && typeof source.persistHistory !== 'boolean') {
    throw new TypeError('dsh-omc-tui.settings.persistHistory must be boolean')
  }
  return { theme, statusline, persistHistory: source.persistHistory ?? true }
}

tuiSettingsSchema.toJSON = () => ({
  type: 'object',
  properties: {
    theme: { type: 'string', enum: Object.keys(THEMES), default: defaultTheme },
    statusline: { type: 'string', enum: STATUSLINE_MODES, default: 'detailed' },
    persistHistory: { type: 'boolean', default: true }
  }
})

export const activityWords = [
  'Building something great',
  'Finding the signal',
  'Making the next move',
  'Reading between lines',
  'Mapping the codebase',
  'Connecting the dots',
  'Following the thread',
  'Shaping the solution',
  'Looking a little closer',
  'Testing the edges',
  'Tracing dependencies',
  'Exploring the workspace',
  'Checking the details',
  'Weaving the context',
  'Tuning the next step',
  'Keeping things moving',
  'Writing the good part',
  'Solving the interesting bit'
]

export const idleWords = [
  'Awaiting your input',
  'Standing by',
  'Ready when you are',
  'Listening closely',
  'Staying quiet',
  'All ears',
  'On standby',
  'Holding space',
  'Keeping an ear out',
  'Waiting patiently'
]

export const explorationWords = [
  'Exploring',
  'Scanning',
  'Mapping',
  'Orbiting',
  'Tracing',
  'Surveying',
  'Charting',
  'Navigating',
  'Searching',
  'Probing'
]
