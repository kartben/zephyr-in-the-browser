/**
 * Top-bar Settings: the page's language, and the desktop bridge.
 * Copy for Zephyr learners — keep clutter low (tooltips over subtitles).
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Info, Languages, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CopyableCommand } from '@/components/CopyableCommand'
import { chooseLanguage, languageChoice, LANGUAGES } from '@/i18n'
import {
  SOURCE_LANGUAGE,
  languageName,
  pickLanguage,
  savedLanguage,
} from '@/i18n/languages'
import { registerCommand } from '@/lib/commands'
import { getMode, subscribe as subscribeMode } from '@/lib/modeStore'
import { cn } from '@/lib/utils'
import {
  BRIDGE_GO_VERSION,
  BRIDGE_INSTALL_COMMAND,
  BRIDGE_QUERY_PARAM,
  BRIDGE_RUN_COMMAND,
  getSettings,
  isValidBridgeUrl,
  mixedContentHint,
  resolveBridgeConfig,
  setEnabled,
  setUrl,
  subscribe,
} from '@/lib/bridgeStore'
import * as bridge from '@/probe/client'

const TRANSLATING_URL =
  'https://github.com/kartben/zephyr-in-the-browser/blob/main/docs/i18n.md'

export function SettingsMenu() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const settings = useSyncExternalStore(subscribe, getSettings, getSettings)
  const snap = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot)
  const mode = useSyncExternalStore(subscribeMode, getMode, getMode)
  const [url, setUrlLocal] = useState(settings.url)
  const [showHelp, setShowHelp] = useState(false)

  useEffect(() => {
    setUrlLocal(settings.url)
  }, [settings.url])

  // The Live board home surface deep-links here ("Open Settings").
  useEffect(() => registerCommand('open-settings', () => setOpen(true)), [])

  const resolved = resolveBridgeConfig()
  const queryForced = resolved.source === 'query'
  const urlInvalid = url.trim() !== '' && !isValidBridgeUrl(url.trim())
  const wsHint = settings.enabled ? mixedContentHint(url.trim()) : ''

  const commitUrl = () => {
    const next = url.trim()
    if (next === '' || isValidBridgeUrl(next)) setUrl(next)
  }

  const phase = snap.phase
  const dot =
    phase === 'connected'
      ? 'bg-success'
      : phase === 'connecting'
        ? 'bg-warning animate-pulse'
        : phase === 'error'
          ? 'bg-destructive'
          : 'bg-muted-foreground'

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        className={cn('size-8', open && 'bg-accent')}
        aria-label={t('settings.title')}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        <Settings className="size-4" />
      </Button>

      {open && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 cursor-default"
            aria-label={t('settings.dismiss')}
            onClick={() => setOpen(false)}
          />
          <div
            role="dialog"
            aria-label={t('settings.title')}
            className="absolute right-0 top-full z-50 mt-1 w-[22rem] max-w-[calc(100vw-1.5rem)] rounded-lg border border-border bg-card p-3 shadow-xl"
          >
            <LanguageSetting />

            <div className="mb-2 flex items-center gap-1.5">
              <h2 className="text-sm font-semibold">{t('settings.bridge.title')}</h2>
              <Button
                variant="ghost"
                size="icon"
                className={cn('ml-auto size-6', showHelp && 'text-primary')}
                aria-label={t('settings.bridge.howTo')}
                aria-pressed={showHelp}
                onClick={() => setShowHelp((s) => !s)}
              >
                <Info className="size-3.5" />
              </Button>
            </div>

            {showHelp && (
              <div className="mb-2 space-y-1.5 rounded-md border border-primary/40 bg-primary/5 p-2 text-[11px] leading-relaxed">
                <p>{t('settings.bridge.intro')}</p>
                <p>{t('settings.bridge.install', { version: BRIDGE_GO_VERSION })}</p>
                <CopyableCommand command={BRIDGE_INSTALL_COMMAND} />
                <p>{t('settings.bridge.run')}</p>
                <CopyableCommand command={BRIDGE_RUN_COMMAND} />
                <p>
                  <Trans
                    i18nKey="settings.bridge.notes"
                    components={{
                      link: (
                        <a
                          className="underline decoration-dotted underline-offset-2 hover:text-primary-text"
                          href="https://github.com/kartben/zephyr-in-the-browser/blob/main/docs/bridge.md"
                          target="_blank"
                          rel="noreferrer"
                        />
                      ),
                    }}
                  />
                </p>
              </div>
            )}

            <label className="mb-2 flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                className="size-3.5 accent-primary"
                checked={settings.enabled}
                disabled={queryForced}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              {t('settings.bridge.use')}
            </label>

            <span className="flex min-w-0 items-center rounded-md border border-input bg-background px-2">
              <input
                type="text"
                aria-label={t('settings.bridge.url')}
                placeholder="ws://localhost:8740/?token=…"
                value={url}
                disabled={queryForced}
                onChange={(e) => setUrlLocal(e.target.value)}
                onBlur={commitUrl}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitUrl()
                }}
                className="min-w-0 flex-1 bg-transparent py-1.5 font-mono text-[11px] text-foreground outline-none placeholder:text-muted-foreground/60"
              />
            </span>
            {urlInvalid && (
              <p className="mt-1 font-mono text-[11px] text-destructive">
                {t('settings.bridge.invalidUrl')}
              </p>
            )}
            {!urlInvalid && wsHint && (
              <p className="mt-1 text-[11px] text-muted-foreground">{wsHint}</p>
            )}

            {queryForced && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                <Trans
                  i18nKey="settings.bridge.setByQuery"
                  values={{ param: BRIDGE_QUERY_PARAM }}
                  components={{ code: <code className="font-mono" /> }}
                />
              </p>
            )}

            {settings.enabled && (
              <div className="mt-2 flex items-center gap-1.5">
                <span
                  className={cn('size-2 shrink-0 rounded-full', dot)}
                  role="status"
                  aria-label={t('settings.bridge.state', {
                    phase: t(`settings.bridge.phase.${phase}`),
                  })}
                />
                <span className="font-mono text-[11px]">{t(`settings.bridge.phase.${phase}`)}</span>
                {snap.features && (
                  <span className="truncate text-[10px] text-muted-foreground">
                    {[
                      snap.features.ctf && t('settings.bridge.feature.tracing'),
                      snap.features.net && t('settings.bridge.feature.network'),
                      snap.features.gdb && t('settings.bridge.feature.debug'),
                    ]
                      .filter(Boolean)
                      .join(' · ') || '…'}
                  </span>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  className="ml-auto h-7 shrink-0 text-xs"
                  onClick={() =>
                    phase === 'connected' || phase === 'connecting'
                      ? bridge.disconnect()
                      : bridge.connect()
                  }
                >
                  {phase === 'connected' || phase === 'connecting'
                    ? t('settings.bridge.disconnect')
                    : phase === 'error'
                      ? t('settings.bridge.retry')
                      : t('settings.bridge.connect')}
                </Button>
              </div>
            )}

            {settings.enabled && phase === 'connected' && snap.serial?.phase === 'streaming' && (
              <p
                className="mt-1 truncate text-[10px] text-muted-foreground"
                title={snap.serial.path ?? undefined}
              >
                {t('settings.bridge.streaming', { path: snap.serial.path })}
              </p>
            )}

            {settings.enabled && phase === 'connected' && mode === 'sim' && (
              <p className="mt-1 text-[10px] text-muted-foreground">
                {t('settings.bridge.liveHint')}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * The page's language. Picking one reloads the page (src/i18n/index.ts), so
 * the choice is a native select that does nothing until it changes.
 */
function LanguageSetting() {
  const { t } = useTranslation()
  const choice = languageChoice()
  const saved = savedLanguage()
  const browser = pickLanguage(navigator.languages ?? [], LANGUAGES) ?? SOURCE_LANGUAGE
  // A `?lang=` link outranks the saved choice, so the select shows what runs.
  // With neither, the page follows the browser: the first option.
  const value =
    choice.source === 'query' ? choice.lang : saved && LANGUAGES.includes(saved) ? saved : ''

  return (
    <div className="mb-3 border-b border-border pb-3">
      <div className="mb-2 flex items-center gap-1.5">
        <Languages className="size-3.5 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-semibold">{t('settings.language.title')}</h2>
        <a
          className="ml-auto text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-primary-text"
          href={TRANSLATING_URL}
          target="_blank"
          rel="noreferrer"
        >
          {t('settings.language.contribute')}
        </a>
      </div>
      <select
        aria-label={t('settings.language.label')}
        value={value}
        onChange={(e) => chooseLanguage(e.target.value || null)}
        className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground"
      >
        <option value="">{t('settings.language.browser', { name: languageName(browser) })}</option>
        {LANGUAGES.map((code) => (
          <option key={code} value={code} lang={code}>
            {languageName(code)}
          </option>
        ))}
      </select>
      {choice.source === 'query' && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          <Trans
            i18nKey="settings.language.fromLink"
            values={{ lang: choice.lang }}
            components={{ code: <code className="font-mono" /> }}
          />
        </p>
      )}
      <p className="mt-1 text-[10px] text-muted-foreground">{t('settings.language.reloads')}</p>
    </div>
  )
}
