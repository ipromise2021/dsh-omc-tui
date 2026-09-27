/**
 * SGR mouse protocol parser (\x1b[<Cb;Cx;CyM or \x1b[<Cb;Cx;Cym)
 */
export function parseSgrMouse(sequence) {
  const match = sequence.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/)
  if (!match) return null

  const cb = parseInt(match[1], 10)
  const col = parseInt(match[2], 10) - 1 // 0-indexed
  const row = parseInt(match[3], 10) - 1 // 0-indexed
  const isRelease = match[4] === 'm'

  const shift = (cb & 4) !== 0
  const meta = (cb & 8) !== 0
  const ctrl = (cb & 16) !== 0
  const motion = (cb & 32) !== 0

  // Wheel events
  if ((cb & 64) !== 0) {
    const isWheelDown = (cb & 3) === 1
    return {
      type: 'wheel',
      deltaY: isWheelDown ? 2 : -2,
      col,
      row,
      shift,
      meta,
      ctrl
    }
  }

  // Button events
  const buttonCode = cb & 3
  let button = 'left'
  if (buttonCode === 1) button = 'middle'
  else if (buttonCode === 2) button = 'right'

  let action = 'press'
  if (isRelease) {
    action = 'release'
  } else if (motion) {
    action = (buttonCode === 3) ? 'hover' : 'move'
  } else if (buttonCode === 3) {
    action = 'release'
  }

  return {
    type: 'mouse',
    action,
    button,
    col,
    row,
    shift,
    meta,
    ctrl,
    motion
  }
}

/**
 * urxvt 1015 mouse protocol: CSI Cb;Cx;CyM.
 * Its button code is offset by 32, unlike SGR 1006's `<Cb` form.
 */
export function parseUrxvtMouse(sequence) {
  const match = sequence.match(/^\x1b\[(\d+);(\d+);(\d+)M$/)
  if (!match) return null
  const cb = Number.parseInt(match[1], 10) - 32
  if (cb < 0) return null
  return parseSgrMouse(`\x1b[<${cb};${match[2]};${match[3]}M`)
}

/**
 * X10 / Standard mouse protocol parser (\x1b[M Cb Cx Cy)
 */
export function parseX10Mouse(sequence) {
  if (!sequence.startsWith('\x1b[M') || sequence.length < 6) return null

  const cb = sequence.charCodeAt(3) - 32
  const col = Math.max(0, sequence.charCodeAt(4) - 32 - 1)
  const row = Math.max(0, sequence.charCodeAt(5) - 32 - 1)

  const shift = (cb & 4) !== 0
  const meta = (cb & 8) !== 0
  const ctrl = (cb & 16) !== 0
  const motion = (cb & 32) !== 0

  if ((cb & 64) !== 0) {
    const isWheelDown = (cb & 3) === 1
    return {
      type: 'wheel',
      deltaY: isWheelDown ? 2 : -2,
      col,
      row,
      shift,
      meta,
      ctrl
    }
  }

  const buttonCode = cb & 3
  let button = 'left'
  if (buttonCode === 1) button = 'middle'
  else if (buttonCode === 2) button = 'right'

  let action = 'press'
  if (motion) {
    action = (buttonCode === 3) ? 'hover' : 'move'
  } else if (buttonCode === 3) {
    action = 'release'
  }

  return {
    type: 'mouse',
    action,
    button,
    col,
    row,
    shift,
    meta,
    ctrl,
    motion
  }
}
