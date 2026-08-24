// Terminal image-paste protocol parser. Two protocols are supported:
//
//   - iTerm2 OSC 1337 inline image:
//       ESC ] 1337 ; File=inline=1 ; [size=…] : <base64> BEL | ESC \
//     The base64 payload may arrive in several stdin chunks; the sequence
//     ends with BEL or ST.
//
//   - kitty graphics protocol (direct transmission, PNG only):
//       ESC _ G f=100[,a=…][,q=2] ; m=1 <base64> ESC \
//       ESC _ G m=0 ; <base64> ESC \     (following chunks; last is m=0)
//     After the image completes the terminal expects an
//     `ESC _ Gi=<id>;OK ESC \` acknowledgement unless q=2 (quiet) was set.
//
// While an image is in flight the caller must swallow all stdin until
// feed() reports a result. `busy` is true in that state.

const OSC1337_PREFIX = '\x1b]1337;'
const KITTY_PREFIX = '\x1b_G'
const BEL = '\x07'
const ST = '\x1b\\'
const PNG_MEDIA_TYPE = 'image/png'
const MAX_HEADER_BYTES = 2048
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024
const MAX_PNG_BYTES = 5 * 1024 * 1024
const INACTIVITY_TIMEOUT_MS = 30000

export function formatImageBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes}B`
}

export function pngDimensions(data) {
  const bytes = Buffer.from(data ?? [])
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return undefined
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  return width > 0 && height > 0 ? { width, height } : undefined
}

function decodeBase64(payload) {
  return Buffer.from(payload.replace(/\s/g, ''), 'base64')
}

function parseParams(header, separator = ';') {
  const params = {}
  for (const part of header.split(separator)) {
    const index = part.indexOf('=')
    if (index === -1) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key) params[key] = value
  }
  return params
}

function decodeDisplayName(raw) {
  if (!raw) return undefined
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8')
    if (/^[\x20-\x7e\u00a0-\uffff]+$/u.test(decoded)) return decoded.slice(0, 120)
  } catch {
    // fall through to the raw value
  }
  return raw.slice(0, 120)
}

export class ImageParser {
  constructor() {
    this.reset()
  }

  reset() {
    this.state = 'idle' // idle | iterm-header | iterm-data | kitty-header | kitty-data
    this.buffer = ''
    this.itermParams = {}
    this.kittyParams = {}
    this.kittyPayload = ''
    this.kittyAwait = false
    this.lastActivity = 0
  }

  get busy() {
    return this.state !== 'idle'
  }

  /**
   * Complete a kitty chunked transmission that has stopped receiving data.
   * Call shortly after feed() reports `busy` while awaiting further chunks:
   * if no more chunks arrive the accumulated payload is the whole image.
   * Returns the same shapes as feed(), or undefined when there is nothing
   * to complete.
   */
  flushAwait() {
    if (!this.kittyAwait) return undefined
    return this.finishKitty(this.buffer)
  }

  /**
   * Feed one raw stdin chunk. Returns:
   *   undefined            — nothing complete yet
   *   { image, remainder } — one complete image; image.ack may carry a
   *                          kitty acknowledgement to write back to stdout
   *   { ignored, remainder } — recognized but unsupported protocol sequence
   *   { error }            — oversized/malformed input, parser state reset
   * `remainder` contains bytes after the sequence terminator that arrived in
   * the same chunk and should be re-processed by the caller.
   */
  feed(chunk) {
    if (this.busy && Date.now() - this.lastActivity > INACTIVITY_TIMEOUT_MS) {
      this.reset()
      return { error: 'image paste timed out' }
    }
    this.lastActivity = Date.now()
    const value = chunk.toString('utf8')
    if (this.state === 'idle') {
      const oscIndex = value.indexOf(OSC1337_PREFIX)
      const kittyIndex = value.indexOf(KITTY_PREFIX)
      const start = Math.min(
        oscIndex === -1 ? Infinity : oscIndex,
        kittyIndex === -1 ? Infinity : kittyIndex
      )
      if (!Number.isFinite(start)) return undefined
      const prefix = start === oscIndex ? OSC1337_PREFIX : KITTY_PREFIX
      this.state = start === oscIndex ? 'iterm-header' : 'kitty-header'
      this.buffer = value.slice(start + prefix.length)
      this.itermParams = {}
      this.kittyParams = {}
      this.kittyPayload = ''
    } else {
      this.buffer += value
    }
    return this.advance()
  }

  advance() {
    switch (this.state) {
      case 'iterm-header':
        return this.advanceItermHeader()
      case 'iterm-data':
        return this.advanceItermData()
      case 'kitty-header':
        return this.advanceKittyHeader()
      case 'kitty-data':
        return this.advanceKittyData()
      default:
        return undefined
    }
  }

  advanceItermHeader() {
    const colon = this.buffer.indexOf(':')
    if (colon === -1) {
      if (this.buffer.length > MAX_HEADER_BYTES) return this.drop('osc1337 header too long')
      return undefined
    }
    const params = parseParams(this.buffer.slice(0, colon))
    this.buffer = this.buffer.slice(colon + 1)
    if (params.File !== 'inline=1') {
      const remainder = this.buffer
      this.reset()
      return { ignored: true, remainder }
    }
    this.itermParams = params
    this.state = 'iterm-data'
    return this.advance()
  }

  advanceItermData() {
    const bel = this.buffer.indexOf(BEL)
    const st = this.buffer.indexOf(ST)
    const ends = [bel, st].filter((index) => index !== -1)
    if (ends.length === 0) {
      if (this.buffer.length > MAX_BUFFERED_BYTES) return this.drop('image too large')
      return undefined
    }
    const end = Math.min(...ends)
    const terminator = end === bel ? BEL : ST
    const payload = this.buffer.slice(0, end)
    const remainder = this.buffer.slice(end + terminator.length)
    const data = decodeBase64(payload)
    const size = Number(this.itermParams.size)
    if ((Number.isFinite(size) && size > MAX_PNG_BYTES) || data.length > MAX_PNG_BYTES) {
      this.reset()
      return { error: 'image exceeds 5MB limit', remainder }
    }
    const image = {
      data,
      mediaType: PNG_MEDIA_TYPE,
      name: decodeDisplayName(this.itermParams.name),
      width: this.itermParams.width ? Number(this.itermParams.width) : undefined,
      height: this.itermParams.height ? Number(this.itermParams.height) : undefined
    }
    this.reset()
    return { image, remainder }
  }

  advanceKittyHeader() {
    if (this.buffer.startsWith(KITTY_PREFIX)) {
      this.buffer = this.buffer.slice(KITTY_PREFIX.length)
    } else if (this.kittyAwait && this.buffer.length > 0) {
      // A chunked transmission is in flight and the next input is not a
      // kitty control sequence: the previous chunk was the last one.
      return this.finishKitty(this.buffer)
    }
    const separator = this.buffer.indexOf(';')
    const st = this.buffer.indexOf(ST)
    if (st !== -1 && (separator === -1 || st < separator)) {
      const remainder = this.buffer.slice(st + ST.length)
      this.reset()
      return { ignored: true, remainder }
    }
    if (separator === -1) {
      if (this.buffer.length > MAX_HEADER_BYTES) return this.drop('kitty header too long')
      return undefined
    }
    const chunkParams = parseParams(this.buffer.slice(0, separator), ',')
    this.buffer = this.buffer.slice(separator + 1)
    Object.assign(this.kittyParams, chunkParams)
    const f = this.kittyParams.f
    const m = this.kittyParams.m
    if (f !== undefined && f !== '100') {
      this.reset()
      return { ignored: true }
    }
    if (m !== undefined && m !== '0' && m !== '1') {
      this.reset()
      return { ignored: true }
    }
    this.state = 'kitty-data'
    return this.advance()
  }

  advanceKittyData() {
    const st = this.buffer.indexOf(ST)
    if (st === -1) {
      if (this.buffer.length + this.kittyPayload.length > MAX_BUFFERED_BYTES) {
        return this.drop('image too large')
      }
      return undefined
    }
    this.kittyPayload += this.buffer.slice(0, st)
    const remainder = this.buffer.slice(st + ST.length)
    if (this.kittyParams.m === '0') {
      return this.finishKitty(remainder)
    }
    // m === '1' (first chunk) or omitted (middle chunk): more chunks may
    // follow, so keep waiting for the next kitty control sequence.
    this.kittyAwait = true
    this.state = 'kitty-header'
    this.buffer = remainder
    return this.advance()
  }

  finishKitty(remainder) {
    const data = decodeBase64(this.kittyPayload)
    if (data.length > MAX_PNG_BYTES) {
      this.reset()
      return { error: 'image exceeds 5MB limit', remainder }
    }
    const quiet = this.kittyParams.q === '2'
    const image = {
      data,
      mediaType: PNG_MEDIA_TYPE,
      name: decodeDisplayName(this.kittyParams.n),
      width: this.kittyParams.s ? Number(this.kittyParams.s) : undefined,
      height: this.kittyParams.v ? Number(this.kittyParams.v) : undefined
    }
    const id = this.kittyParams.i ?? this.kittyParams.id
    if (!quiet && id) image.ack = `\x1b_Gi=${id};OK\x1b\\`
    this.reset()
    return { image, remainder }
  }

  drop(reason) {
    this.reset()
    return { error: reason }
  }
}
