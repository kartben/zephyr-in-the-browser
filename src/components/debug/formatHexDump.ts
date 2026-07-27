import { compactHex } from '@/debug/hexFormat'

export function formatHexDump(addr: number, hex: string): string {
  if (!hex) return ''
  const bytes: number[] = []
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(Number.parseInt(hex.slice(i, i + 2), 16))
  }
  const addrDigits = Math.max(8, compactHex(addr.toString(16)).length)
  const lines: string[] = []
  for (let i = 0; i < bytes.length; i += 16) {
    const slice = bytes.slice(i, i + 16)
    const hexPart = slice.map((b) => b.toString(16).padStart(2, '0')).join(' ')
    const ascii = slice.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')
    lines.push(
      `${(addr + i).toString(16).padStart(addrDigits, '0')}  ${hexPart.padEnd(47)}  ${ascii}`,
    )
  }
  return lines.join('\n')
}
