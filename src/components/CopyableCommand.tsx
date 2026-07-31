/**
 * A one-line shell command with a copy button. Shared by the Settings bridge
 * help and the Live board home surface.
 */

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="relative">
      <code className="block whitespace-pre-wrap break-all rounded bg-background/60 p-1.5 pr-8 font-mono text-[10px] leading-4">
        {command}
      </code>
      <Button
        variant="ghost"
        size="icon"
        className="absolute right-0.5 top-0.5 size-5"
        aria-label={copied ? 'Copied' : 'Copy command'}
        onClick={() => {
          navigator.clipboard
            .writeText(command)
            .then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
            .catch(() => {
              /* selectable fallback */
            })
        }}
      >
        {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
      </Button>
    </div>
  )
}
