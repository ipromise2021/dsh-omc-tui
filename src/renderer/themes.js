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
    contextFill: '\x1b[38;5;65m', // Muted green for normal context pressure
    contextWarning: '\x1b[38;5;172m', // Deep amber for elevated context pressure
    contextCritical: '\x1b[38;5;167m', // Deep red for critical context pressure
    selectionBg: '\x1b[48;5;239m\x1b[38;5;255m',
    userBg: '\x1b[48;5;237m',
    diffRemoveBg: '\x1b[48;5;52m',
    diffAddBg: '\x1b[48;5;236m'
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
    contextFill: '\x1b[38;5;31m',
    contextWarning: '\x1b[38;5;130m',
    contextCritical: '\x1b[38;5;124m',
    selectionBg: '\x1b[48;5;24m\x1b[38;5;255m',
    userBg: '\x1b[48;5;236m',     // Slightly lighter bg
    diffRemoveBg: '\x1b[48;5;52m',
    diffAddBg: '\x1b[48;5;236m'
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
    contextFill: '\x1b[38;5;246m',
    contextWarning: '\x1b[38;5;245m',
    contextCritical: '\x1b[1;37m',
    selectionBg: '\x1b[7m',
    userBg: '\x1b[48;5;238m',
    diffRemoveBg: '\x1b[48;5;238m',
    diffAddBg: '\x1b[48;5;236m'
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
    contextFill: '\x1b[38;5;28m',
    contextWarning: '\x1b[38;5;130m',
    contextCritical: '\x1b[38;5;124m',
    selectionBg: '\x1b[48;5;252m\x1b[38;5;235m',
    userBg: '\x1b[48;5;252m',
    diffRemoveBg: '\x1b[48;5;224m',
    diffAddBg: '\x1b[48;5;253m'
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
export const CONTEXT_DISPLAY_MODES = ['both', 'percent', 'tokens', 'remaining']
export const DEFAULT_DISABLED_SKILLS = ['image-recognize']

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
  const contextMode = source.contextMode ?? 'both'
  if (!CONTEXT_DISPLAY_MODES.includes(contextMode)) {
    throw new TypeError(`dsh-omc-tui.settings.contextMode must be one of: ${CONTEXT_DISPLAY_MODES.join(', ')}`)
  }
  const contextWarnAt = source.contextWarnAt ?? 60
  const contextCriticalAt = source.contextCriticalAt ?? 80
  if (!Number.isInteger(contextWarnAt) || contextWarnAt < 1 || contextWarnAt > 99) {
    throw new TypeError('dsh-omc-tui.settings.contextWarnAt must be an integer between 1 and 99')
  }
  if (!Number.isInteger(contextCriticalAt) || contextCriticalAt < 2 || contextCriticalAt > 100 || contextCriticalAt <= contextWarnAt) {
    throw new TypeError('dsh-omc-tui.settings.contextCriticalAt must be an integer greater than contextWarnAt and at most 100')
  }
  const visionProvider = source.visionProvider
  const visionModel = source.visionModel
  if (visionProvider !== undefined && (typeof visionProvider !== 'string' || !visionProvider.trim())) {
    throw new TypeError('dsh-omc-tui.settings.visionProvider must be a non-empty string')
  }
  if (visionModel !== undefined && (typeof visionModel !== 'string' || !visionModel.trim())) {
    throw new TypeError('dsh-omc-tui.settings.visionModel must be a non-empty string')
  }
  if ((visionProvider === undefined) !== (visionModel === undefined)) {
    throw new TypeError('dsh-omc-tui.settings.visionProvider and visionModel must be configured together')
  }
  if (source.persistHistory !== undefined && typeof source.persistHistory !== 'boolean') {
    throw new TypeError('dsh-omc-tui.settings.persistHistory must be boolean')
  }
  if (source.importSystemShellHistory !== undefined && typeof source.importSystemShellHistory !== 'boolean') {
    throw new TypeError('dsh-omc-tui.settings.importSystemShellHistory must be boolean')
  }
  if (source.hudGit !== undefined && typeof source.hudGit !== 'boolean') {
    throw new TypeError('dsh-omc-tui.settings.hudGit must be boolean')
  }
  if (source.hudSpeed !== undefined && typeof source.hudSpeed !== 'boolean') {
    throw new TypeError('dsh-omc-tui.settings.hudSpeed must be boolean')
  }
  if (source.hudTools !== undefined && typeof source.hudTools !== 'boolean') {
    throw new TypeError('dsh-omc-tui.settings.hudTools must be boolean')
  }
  if (source.autoCompact !== undefined && typeof source.autoCompact !== 'boolean') {
    throw new TypeError('dsh-omc-tui.settings.autoCompact must be boolean')
  }
  if (source.autoRecap !== undefined && typeof source.autoRecap !== 'boolean') {
    throw new TypeError('dsh-omc-tui.settings.autoRecap must be boolean')
  }
  if (source.promptSuggestions !== undefined && typeof source.promptSuggestions !== 'boolean') {
    throw new TypeError('dsh-omc-tui.settings.promptSuggestions must be boolean')
  }
  const disabledSkills = source.disabledSkills ?? DEFAULT_DISABLED_SKILLS
  if (!Array.isArray(disabledSkills) || disabledSkills.some((name) => typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))) {
    throw new TypeError('dsh-omc-tui.settings.disabledSkills must be an array of skill names')
  }
  if (new Set(disabledSkills).size !== disabledSkills.length) {
    throw new TypeError('dsh-omc-tui.settings.disabledSkills must not contain duplicates')
  }
  return {
    theme,
    statusline,
    contextMode,
    contextWarnAt,
    contextCriticalAt,
    visionProvider,
    visionModel,
    persistHistory: source.persistHistory ?? true,
    importSystemShellHistory: source.importSystemShellHistory ?? false,
    hudGit: source.hudGit ?? true,
    hudSpeed: source.hudSpeed ?? true,
    hudTools: source.hudTools ?? true,
    autoCompact: source.autoCompact ?? true,
    autoRecap: source.autoRecap ?? true,
    promptSuggestions: source.promptSuggestions ?? false,
    disabledSkills: [...disabledSkills]
  }
}

tuiSettingsSchema.toJSON = () => ({
  type: 'object',
  properties: {
    theme: { type: 'string', enum: Object.keys(THEMES), default: defaultTheme },
    statusline: { type: 'string', enum: STATUSLINE_MODES, default: 'detailed' },
    contextMode: { type: 'string', enum: CONTEXT_DISPLAY_MODES, default: 'both' },
    contextWarnAt: { type: 'integer', minimum: 1, maximum: 99, default: 60 },
    contextCriticalAt: { type: 'integer', minimum: 2, maximum: 100, default: 80 },
    visionProvider: { type: 'string' },
    visionModel: { type: 'string' },
    persistHistory: { type: 'boolean', default: true },
    importSystemShellHistory: { type: 'boolean', default: false },
    hudGit: { type: 'boolean', default: true },
    hudSpeed: { type: 'boolean', default: true },
    hudTools: { type: 'boolean', default: true },
    autoCompact: { type: 'boolean', default: true },
    autoRecap: { type: 'boolean', default: true },
    promptSuggestions: { type: 'boolean', default: false },
    disabledSkills: { type: 'array', items: { type: 'string' }, default: DEFAULT_DISABLED_SKILLS }
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
