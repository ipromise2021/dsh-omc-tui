import { safe, shorten, truncateWidth } from '../renderer/ansi.js'
import { ANSI as defaultAnsi } from '../renderer/themes.js'

/**
 * Render the main provider management list
 */
export function renderProviderList(providerPanel, currentSelection, capacity, columns, ANSI = defaultAnsi) {
  const providers = providerPanel.providers ?? []
  const currentProviderId = currentSelection?.provider ?? ''
  const slots = Math.max(1, capacity - 2)
  const start = Math.min(Math.max(0, providerPanel.selected - slots + 1), Math.max(0, providers.length - slots))
  const shown = providers.slice(start, start + slots)

  const lines = [
    `  ${ANSI.muted}MODEL PROVIDERS · 提供方管理${ANSI.reset}  ${ANSI.dim}· ${providers.length} registered${ANSI.reset}`,
    ''
  ]

  if (providers.length === 0) {
    lines.push(`  ${ANSI.dim}(no providers available · press [C] to add custom provider)${ANSI.reset}`)
  } else {
    for (let index = 0; index < shown.length; index++) {
      const entry = shown[index]
      const isSelected = index + start === providerPanel.selected
      const marker = isSelected ? `${ANSI.blue}>${ANSI.reset}` : ' '
      const isCurrent = entry.id === currentProviderId
      const isCustom = !!entry.custom
      const hasKey = entry.hasKey !== false

      // Status indicator dot
      const dot = hasKey
        ? `${ANSI.bash}●${ANSI.reset}`
        : `${ANSI.amber}○${ANSI.reset}`

      // Tags and badges
      const customTag = isCustom ? ` ${ANSI.coral}[Custom]${ANSI.reset}` : ''
      const currentTag = isCurrent ? ` ${ANSI.bash}✓ active${ANSI.reset}` : ''
      const protocolTag = entry.api ? `${ANSI.dim}(${entry.api})${ANSI.reset}` : ''

      const label = `${entry.name || entry.id}${customTag}`
      const modelsCount = entry.modelsCount !== undefined ? `${entry.modelsCount} models` : ''
      const meta = [entry.id !== entry.name ? entry.id : '', protocolTag, modelsCount].filter(Boolean).join(' · ')

      const rowText = `${marker}  ${dot} ${ANSI.blueSoft}${truncateWidth(safe(label), Math.max(26, columns - 45))}${ANSI.reset}  ${ANSI.dim}${shorten(safe(meta), Math.max(14, columns - 50))}${ANSI.reset}${currentTag}`
      lines.push(rowText)
    }
  }

  const selectedProvider = providers[providerPanel.selected]
  const isSelectedOfficial = selectedProvider?.id === 'deepseek-official'
  const deleteActionText = isSelectedOfficial ? '' : '  ·  [D] Delete'

  lines.push('')
  lines.push(`  ${ANSI.muted}[A] Add Preset  ·  [C] Add Custom  ·  [E] Edit/Key${deleteActionText}  ·  [Enter] Models  ·  [Esc] Close${ANSI.reset}`)
  return lines
}

/**
 * Render preset provider selection dialog
 */
export function renderAddPresetPicker(providerPanel, capacity, columns, ANSI = defaultAnsi) {
  const presets = providerPanel.presetCandidates ?? []
  const slots = Math.max(1, capacity - 2)
  const start = Math.min(Math.max(0, providerPanel.selected - slots + 1), Math.max(0, presets.length - slots))
  const shown = presets.slice(start, start + slots)

  return [
    `  ${ANSI.muted}ADD PRESET PROVIDER · 添加预设提供方${ANSI.reset}  ${ANSI.dim}· select a provider to configure${ANSI.reset}`,
    '',
    ...shown.map((item, index) => {
      const marker = index + start === providerPanel.selected ? `${ANSI.blue}>${ANSI.reset}` : ' '
      const desc = item.description ? ` · ${item.description}` : ''
      return `${marker}  ${ANSI.blueSoft}${truncateWidth(safe(item.name || item.id), Math.max(24, columns - 30))}${ANSI.reset}  ${ANSI.dim}${item.id}${desc}${ANSI.reset}`
    }),
    '',
    `  ${ANSI.muted}↑↓ navigate  ·  Enter configure  ·  Esc back${ANSI.reset}`
  ]
}

/**
 * Render custom provider / edit provider form wizard
 */
export function renderProviderForm(providerPanel, columns, ANSI = defaultAnsi) {
  const form = providerPanel.formDraft ?? {}
  const activeFieldIndex = providerPanel.formField ?? 0
  const isNew = !providerPanel.editingProvider

  const fields = [
    { key: 'id', label: 'Provider ID (Route)', desc: '小写英文字母与数字，如: ollama, vllm, deepseek-local', readonly: !isNew },
    { key: 'displayName', label: 'Display Name', desc: '在界面中展示的名称，如: Ollama Local Server' },
    { key: 'baseURL', label: 'Base URL', desc: 'API 端点基础地址，如: http://localhost:11434/v1' },
    { key: 'api', label: 'API Protocol', desc: '协议类型 (< / > 左右方向键切换)', isSelect: true },
    { key: 'apiKey', label: 'API Key', desc: '端点密钥 (留空表示无需鉴权/本地端点)', isSecret: true },
    { key: 'modelsSection', label: 'Models Catalog', desc: '该提供方支持的模型列表', isModels: true }
  ]

  const title = isNew
    ? `  ${ANSI.muted}ADD CUSTOM PROVIDER · 新建自定义模型提供方${ANSI.reset}`
    : `  ${ANSI.muted}EDIT PROVIDER · 配置提供方: ${ANSI.blueSoft}${form.id || ''}${ANSI.reset}`

  const lines = [
    title,
    `  ${ANSI.dim}${'─'.repeat(Math.max(20, Math.min(76, columns - 4)))}${ANSI.reset}`
  ]

  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]
    const isFocused = i === activeFieldIndex
    const prefix = isFocused ? `${ANSI.blue}>${ANSI.reset} ` : '  '

    if (f.isSelect) {
      const protocols = providerPanel.protocols || ['openai', 'anthropic', 'google']
      const currentProto = form.api || protocols[0] || 'openai'
      const valStr = isFocused ? `${ANSI.blue}‹ ${currentProto} ›${ANSI.reset}` : `${ANSI.dim}‹ ${currentProto} ›${ANSI.reset}`
      lines.push(`${prefix}${ANSI.ink}${ANSI.bold}${f.label.padEnd(22)}${ANSI.reset} : ${valStr}`)
      if (isFocused) lines.push(`     ${ANSI.dim}${f.desc}${ANSI.reset}`)
      continue
    }

    if (f.isModels) {
      const models = form.models || []
      const countStr = models.length > 0 ? `${ANSI.bash}${models.length} configured${ANSI.reset}` : `${ANSI.amber}0 models (needs ≥ 1)${ANSI.reset}`
      lines.push(`${prefix}${ANSI.ink}${ANSI.bold}${f.label.padEnd(22)}${ANSI.reset} : ${countStr}`)

      // Show first 3 models preview
      if (models.length > 0) {
        const preview = models.slice(0, 3).map(m => m.id || m.name).join(', ')
        const more = models.length > 3 ? ` ... (+${models.length - 3} more)` : ''
        lines.push(`     ${ANSI.dim}Models: ${preview}${more}${ANSI.reset}`)
      }

      if (isFocused) {
        lines.push(`     ${ANSI.dim}[F] 探测端点模型 (Fetch)  ·  [+] 手动新增  ·  [-] 删除末尾${ANSI.reset}`)
      }
      continue
    }

    let val = form[f.key] ?? ''
    if (f.isSecret) {
      val = val ? '•'.repeat(Math.min(18, val.length)) : (form.hasStoredKey ? `${ANSI.dim}(configured · type to replace)${ANSI.reset}` : `${ANSI.dim}(none / optional)${ANSI.reset}`)
    } else if (!val) {
      val = f.readonly ? `${ANSI.dim}(locked)${ANSI.reset}` : `${ANSI.dim}(empty)${ANSI.reset}`
    }

    const displayVal = isFocused ? `${ANSI.blueSoft}${val}${ANSI.blue}█${ANSI.reset}` : `${ANSI.dim}${val}${ANSI.reset}`
    lines.push(`${prefix}${ANSI.ink}${ANSI.bold}${f.label.padEnd(22)}${ANSI.reset} : ${displayVal}`)
    if (isFocused && f.desc) {
      lines.push(`     ${ANSI.dim}${f.desc}${ANSI.reset}`)
    }
  }

  if (providerPanel.formError) {
    lines.push('')
    lines.push(`  ${ANSI.coral}⚠ ${providerPanel.formError}${ANSI.reset}`)
  }

  const deleteHint = !isNew && form.id !== 'deepseek-official' ? '  ·  [Ctrl+D] Delete' : ''
  lines.push('')
  lines.push(`  ${ANSI.muted}↑↓ navigate fields  ·  Type to edit  ·  Tab/[Enter] next  ·  [Ctrl+S] Save${deleteHint}  ·  [Esc] Cancel${ANSI.reset}`)
  return lines
}

/**
 * Render discover models modal (candidate picker)
 */
export function renderDiscoverModelsModal(providerPanel, capacity, columns, ANSI = defaultAnsi) {
  if (providerPanel.discovering) {
    return [
      `  ${ANSI.muted}DISCOVERING MODELS · 探测远程模型中…${ANSI.reset}`,
      '',
      `  ${ANSI.amber}⏳ Connecting to ${providerPanel.formDraft?.baseURL || 'endpoint'} and querying model catalog...${ANSI.reset}`,
      '',
      `  ${ANSI.dim}Please wait while the endpoint responds...${ANSI.reset}`
    ]
  }

  const candidates = providerPanel.discoveredCandidates ?? []
  const picked = providerPanel.pickedCandidates ?? new Set()
  const slots = Math.max(1, capacity - 3)
  const start = Math.min(Math.max(0, providerPanel.candidateSelected - slots + 1), Math.max(0, candidates.length - slots))
  const shown = candidates.slice(start, start + slots)

  const lines = [
    `  ${ANSI.muted}CHOOSE MODELS TO ADOPT · 选择要导入的模型${ANSI.reset}  ${ANSI.dim}· ${picked.size}/${candidates.length} selected${ANSI.reset}`,
    ''
  ]

  if (candidates.length === 0) {
    lines.push(`  ${ANSI.coral}No models returned by provider endpoint. Please add models manually.${ANSI.reset}`)
  } else {
    for (let index = 0; index < shown.length; index++) {
      const cand = shown[index]
      const isSelected = index + start === providerPanel.candidateSelected
      const isChecked = picked.has(cand.id)
      const marker = isSelected ? `${ANSI.blue}>${ANSI.reset}` : ' '
      const checkbox = isChecked ? `${ANSI.bash}[x]${ANSI.reset}` : `${ANSI.dim}[ ]${ANSI.reset}`
      const cap = cand.contextWindow ? ` ${ANSI.dim}(${Math.round(cand.contextWindow / 1000)}K ctx)${ANSI.reset}` : ''
      lines.push(`${marker}  ${checkbox} ${ANSI.blueSoft}${truncateWidth(safe(cand.id), Math.max(26, columns - 30))}${ANSI.reset}${cap}`)
    }
  }

  lines.push('')
  lines.push(`  ${ANSI.muted}Space/1-9 toggle  ·  [A] Select All  ·  Enter Adopt Selected  ·  Esc Cancel${ANSI.reset}`)
  return lines
}

/**
 * Render delete confirmation modal
 */
export function renderDeleteConfirmModal(providerPanel, ANSI = defaultAnsi) {
  const target = providerPanel.deleteTarget
  const id = target?.id || target?.provider || 'unknown'
  const name = target?.name || target?.displayName || id

  return [
    `  ${ANSI.coral}${ANSI.bold}DELETE PROVIDER · 删除提供方${ANSI.reset}`,
    '',
    `  Are you sure you want to delete ${ANSI.ink}${ANSI.bold}"${name}"${ANSI.reset} (${id})?`,
    `  ${ANSI.dim}This will remove its configuration and stored API key.${ANSI.reset}`,
    '',
    `  ${ANSI.coral}❯ Press [Enter] / [Y] / [D] to Confirm Delete${ANSI.reset}`,
    `    ${ANSI.dim}Press [Esc] / [N] to Cancel${ANSI.reset}`,
    ''
  ]
}
