/**
 * Typed keys: `t('topBar.restart')` is checked against src/locales/en.json, so
 * a misspelt key fails `npm run typecheck` instead of showing on the page.
 */

import 'i18next'
import type en from '@/locales/en.json'

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation'
    resources: { translation: typeof en }
  }
}
