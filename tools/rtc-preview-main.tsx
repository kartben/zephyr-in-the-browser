import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { RtcBody } from '@/components/RtcCard'
import { createPcf8523 } from '@/virtio/devices/rtc/pcf8523'
import '@/index.css'

const armed = createPcf8523({
  time: { year: 2026, month: 7, day: 25, weekday: 6, hour: 8, minute: 30, second: 12 },
})
armed.setAlarm(0, { hour: 8, minute: 31, day: 25, weekday: 6 })

const fired = createPcf8523({
  time: { year: 2026, month: 7, day: 25, weekday: 6, hour: 8, minute: 31, second: 0 },
})
fired.setAlarm(0, { hour: 8, minute: 31, day: 25, weekday: 6 })

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="w-[320px] overflow-hidden rounded-lg border border-border bg-card shadow-xl">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5 text-xs font-semibold">
        {title}
        <span className="ml-auto font-mono text-[10px] font-normal text-muted-foreground">
          virtio_i2c0 · 0x68
        </span>
      </div>
      {children}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div className="flex min-h-screen items-start justify-center gap-6 bg-background p-8">
      <div>
        <p className="mb-3 text-[11px] uppercase tracking-wide text-muted-foreground">
          RTC card · alarm armed
        </p>
        <Frame title="PCF8523 RTC">
          <div id="shot-armed">
            <RtcBody chip={armed} />
          </div>
        </Frame>
      </div>
      <div>
        <p className="mb-3 text-[11px] uppercase tracking-wide text-muted-foreground">
          RTC card · alarm fired
        </p>
        <Frame title="PCF8523 RTC">
          <div id="shot-fired">
            <RtcBody chip={fired} />
          </div>
        </Frame>
      </div>
    </div>
  </StrictMode>,
)
