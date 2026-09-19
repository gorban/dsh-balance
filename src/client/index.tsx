/**
 * dsh-balance, browser half.
 *
 * Renders a right-aligned balance chip into the sidebar foot — the
 * `sidebar.footer.action` slot, the "optional actions beside Settings"
 * extension point (it renders in the foot area directly above the Settings
 * trigger). The chip polls the host route served by the node half
 * (`GET /plugins/balance`), so the API key never reaches the browser.
 *
 * The chip is provider-aware: it reads the *active session's* selected model
 * from the model-directory store (`ctx.modelDirectories`) and asks the host for
 * the balance of the provider that model rides on. A model on the `openrouter`
 * route shows the
 * OpenRouter remaining credits, a `moonshotai` route shows the Moonshot/Kimi
 * available balance, a `zai` route shows the Zhipu/GLM (Z.ai) account balance,
 * and a `minimax` route shows the MiniMax plan remaining. Any other route
 * (including a DeepSeek model, or an unknown route keeping the plugin's
 * original behavior) shows the DeepSeek account balance. The balance shown
 * therefore follows whichever provider the active model is on.
 *
 * States: loading text → amount (click to refresh), or a muted error pill
 * with the reason in a tooltip. Refreshes every minute, on click, whenever the
 * active session changes, AND as soon as the active session's model is switched
 * (via its model-directory store) — so flipping a model in the dropdown flips
 * the chip to that provider's balance immediately. The collapsed 56px rail
 * hides the chip.
 *
 * The status dot has provider meaning: DeepSeek marks its peak/off-peak
 * billing window (green = off-peak, red = peak; peak hours are 01:00–04:00 and
 * 06:00–10:00 UTC). OpenRouter marks remaining credits (green = credits left,
 * red = exhausted), Moonshot/Zhipu/MiniMax mark a positive remaining balance
 * or quota (green = left, red = exhausted).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the sidebar SlotMap merge (the 'sidebar.footer.action'
// declaration) so PropsRuntime<'sidebar.footer.action'> resolves.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** Cordis plugin name — unused here (the entry name comes from the loader row), kept for symmetry. */
export const name = 'dsh-balance'

/**
 * Required services: the slot registry (provided by the client runtime). The
 * model-directory service (`ctx.modelDirectories`) is read lazily and treated
 * as optional — without it the chip keeps its original DeepSeek behavior.
 */
export const inject = ['slots']

/** How often the chip re-polls the balance (ms). */
const REFRESH_INTERVAL_MS = 60_000

/** Host route served by the node half. */
const BALANCE_ENDPOINT = '/plugins/balance'

/** A provider whose balance the host can serve. */
type BalanceKind = 'deepseek' | 'openrouter' | 'moonshot' | 'zhipu' | 'minimax'

/**
 * The minimal model-directory face the chip reads the active session's
 * provider from and subscribes to so it re-polls the moment the model (and thus
 * its provider) changes. This is a structural match on the runtime's
 * `ModelDirectoryResolver` / `ModelDirectory` store, kept dependency-free.
 */
interface ModelDirectoryStoreLike {
  getSnapshot(): { current?: { provider?: string } | null }
  subscribe(fn: () => void): () => void
}
interface ModelDirectoryServiceLike {
  directoryFor(sessionId: SessionId): { store: ModelDirectoryStoreLike }
}

/** Wire shape of the host route (normalized upstream payload, provider-specific). */
interface BalanceResponse {
  ok: boolean
  provider?: BalanceKind
  error?: string
  message?: string
  balance?: {
    // DeepSeek shape (host relays the body at the top level).
    is_available?: boolean
    balance_infos?: Array<{
      currency: string
      total_balance: string
      granted_balance: string
      topped_up_balance: string
    }>
    // OpenRouter shape (unwrapped from `data` by the host, from /api/v1/credits).
    total_credits?: number
    total_usage?: number
    // Moonshot shape (unwrapped from `data` by the host, from /v1/users/me/balance).
    available_balance?: number
    voucher_balance?: number
    cash_balance?: number
    // Zhipu shape (unwrapped from `data` by the host, from the account report).
    balance?: number
    availableBalance?: number
    total_balance?: number
    totalBalance?: number
    rechargeAmount?: number
    currency?: string
    // MiniMax shape (host relays the body at the top level, from /v1/token_plan/remains).
    base_resp?: { status_code?: number; status_msg?: string }
    model_remains?: Array<{
      current_interval_usage_count?: number
      current_interval_remaining_count?: number
      current_interval_remains_count?: number
      current_interval_remaining_percent?: number
      current_interval_total_count?: number
      current_subscribe_title?: string
      plan_name?: string
      plan?: string
    }>
  }
}

/** The rendered result of one refresh, fully shaped for the chip. */
type DisplayState =
  | { kind: 'loading' }
  | { kind: 'ok'; provider: BalanceKind; symbol: string; total: string; title: string; dotColor: CSSProperties['background'] }
  | { kind: 'error'; message: string }

/**
 * Strip the modlens vision plugin's synthetic route prefix before matching.
 *
 * modlens registers `modlens-<upstream>` (and the legacy `deepseek-modlens`)
 * wrapper routes so a text-only model can accept pasted images. Those routes
 * bill the upstream provider's account, so they resolve to that provider's
 * balance kind; without this, selecting a "(modlens vision)" model fell through
 * to DeepSeek and the chip showed a missing-key error instead of the OpenRouter
 * credit the session was actually spending.
 */
function unwrapModlensProvider(provider: string): string {
  const p = provider.toLowerCase()
  if (p === 'deepseek-modlens') return 'deepseek'
  return p.startsWith('modlens-') ? p.slice('modlens-'.length) : p
}

/**
 * Map a provider route id to the balance the plugin serves. These are the
 * routes the plugin knows; a provider route it does not recognize (including a
 * custom provider id) falls back to DeepSeek, so such a session keeps showing
 * the DeepSeek balance rather than failing the chip. The route ids are the DSH
 * pi-ai built-in catalog names; each regional (`-cn`) variant maps to the same
 * kind because the host tries the matching mirror endpoint for that key's site.
 */
function kindForProvider(provider: string): BalanceKind {
  const p = unwrapModlensProvider(provider)
  if (p === 'openrouter') return 'openrouter'
  if (p === 'moonshotai' || p === 'moonshotai-cn') return 'moonshot'
  if (p === 'zai' || p === 'zai-coding-cn' || p === 'zhipu') return 'zhipu'
  if (p === 'minimax' || p === 'minimax-cn') return 'minimax'
  return 'deepseek'
}

/**
 * The sessions-list snapshot face this chip reads the open session from. DSH
 * alpha.1 carried the selected id directly as `current`; alpha.2 removed it
 * (the Sessions service now documents that "navigation belongs to view
 * owners"), so the open session is the row the main view retains. Both shapes
 * are matched structurally so the chip runs on either Host.
 */
interface SessionsSnapshotLike {
  current?: SessionId | null
  byId?: Record<string, { id?: SessionId; retainedBy?: { mainView?: number } }>
}

/**
 * Resolve the session the user currently has open.
 *
 * alpha.1: the list snapshot's `current`. alpha.2: that field is gone, so fall
 * back to the session retained by the main view — the same derivation
 * `ui-session` and `DocumentTitle` use. Returns undefined when nothing is open,
 * which the chip treats as its DeepSeek fallback (never failing the chip).
 * @param snapshot - the sessions list snapshot supplied by `useSessions`.
 * @returns the open session id, or undefined when none is retained.
 */
function currentSessionId(snapshot: SessionsSnapshotLike): SessionId | undefined {
  if (snapshot.current !== undefined && snapshot.current !== null) return snapshot.current
  return Object.values(snapshot.byId ?? {}).find(row => (row.retainedBy?.mainView ?? 0) > 0)?.id
}

/**
 * Resolve the balance kind for the active session's model from the shared
 * model-directory store — the same state the composer's model seat writes, so
 * the chip follows the exact selection the session will use next. A missing
 * session, an absent model-directory service, a directory that is not yet
 * resolved (its `current` is `null` until the catalog loads), or any lookup
 * failure falls back to DeepSeek, never failing the chip; the store
 * subscription re-polls once `current` resolves or changes.
 * @param modelDirectories - the session model-selection service, when composed.
 * @param sessionId - the active session, or undefined when none is current.
 * @returns the balance kind to query.
 */
function kindForSession(
  modelDirectories: ModelDirectoryServiceLike | undefined,
  sessionId: SessionId | undefined,
): BalanceKind {
  if (sessionId === undefined || modelDirectories === undefined) return 'deepseek'
  try {
    const provider = modelDirectories.directoryFor(sessionId).store.getSnapshot().current?.provider
    return provider === undefined ? 'deepseek' : kindForProvider(provider)
  } catch {
    // e.g. an addressed subagent session with no directory, or a scope not yet bound.
    return 'deepseek'
  }
}

/** Currency code → glyph; unknown codes fall back to the code itself. */
function currencySymbol(currency: string): string {
  switch (currency.toUpperCase()) {
    case 'CNY': return '¥'
    case 'USD': return '$'
    case 'EUR': return '€'
    case 'GBP': return '£'
    case 'JPY': return '¥'
    default: return `${currency} `
  }
}

/**
 * DeepSeek peak/off-peak billing (official footnote:
 * https://api-docs.deepseek.com/quick_start/pricing). Peak is **Monday–Friday**,
 * Beijing time (UTC+8) 09:00–12:00 and 14:00–18:00 — which is 01:00–04:00 and
 * 06:00–10:00 UTC on the same day. Every other hour, including the whole
 * weekend, is off-peak (half the peak price). Both peak windows fall inside the
 * same UTC day as their Beijing weekday, so the weekend check uses the UTC day.
 * @param now - the instant to classify (defaults to now).
 * @returns whether the instant falls inside a peak window.
 */
export function isPeakHour(now: Date = new Date()): boolean {
  const day = now.getUTCDay()
  if (day === 0 || day === 6) return false // Saturday/Sunday are off-peak all day
  const hour = now.getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
}

/**
 * Shape the OpenRouter response into the chip display state. The host serves
 * `total_credits`/`total_usage` (from `/api/v1/credits`), whose difference is
 * the remaining balance in dollars.
 */
function renderOpenRouter(data: BalanceResponse): DisplayState {
  const info = data.balance
  const totalCredits = typeof info?.total_credits === 'number' ? info.total_credits : undefined
  const totalUsage = typeof info?.total_usage === 'number' ? info.total_usage : undefined
  if (totalCredits === undefined || totalUsage === undefined) {
    return { kind: 'error', message: 'No OpenRouter balance info returned' }
  }
  const remaining = Math.max(0, totalCredits - totalUsage)
  const total = remaining.toFixed(2)
  return {
    kind: 'ok',
    provider: 'openrouter',
    symbol: '$',
    total,
    title: `OpenRouter · remaining $${total}`,
    dotColor: remaining > 0
      ? 'var(--dsw-alias-state-success-primary)'
      : 'var(--dsw-alias-state-error-primary)',
  }
}

/** Shape the DeepSeek response into the chip display state (the original behavior). */
function renderDeepSeek(data: BalanceResponse): DisplayState {
  const info = data.balance?.balance_infos?.[0]
  if (info === undefined) return { kind: 'error', message: 'No balance info returned' }
  const symbol = currencySymbol(info.currency)
  const breakdown = `Total ${symbol}${info.total_balance} · Granted ${symbol}${info.granted_balance} · Topped up ${symbol}${info.topped_up_balance}`
  const peak = isPeakHour()
  const windowLabel = peak
    ? 'Peak · Mon–Fri 09:00–12:00, 14:00–18:00 Beijing (01:00–04:00, 06:00–10:00 UTC)'
    : 'Off-peak · 50% of the peak price'
  return {
    kind: 'ok',
    provider: 'deepseek',
    symbol,
    total: info.total_balance,
    title: `${windowLabel} · ${breakdown}`,
    dotColor: peak
      ? 'var(--dsw-alias-state-error-primary)'
      : 'var(--dsw-alias-state-success-primary)',
  }
}

/**
 * Shape the Moonshot (Kimi) response into the chip display state. The host
 * unwraps `data` and serves `available_balance` (USD, cash + voucher) from
 * `/v1/users/me/balance`.
 */
function renderMoonshot(data: BalanceResponse): DisplayState {
  const info = data.balance
  const available = typeof info?.available_balance === 'number' ? info.available_balance : undefined
  if (available === undefined) return { kind: 'error', message: 'No Moonshot balance info returned' }
  const total = Math.max(0, available).toFixed(2)
  const cash = typeof info?.cash_balance === 'number' ? info.cash_balance : undefined
  const voucher = typeof info?.voucher_balance === 'number' ? info.voucher_balance : undefined
  const breakdown = cash !== undefined && voucher !== undefined
    ? `Cash $${cash.toFixed(2)} · Voucher $${voucher.toFixed(2)}`
    : `Available $${total}`
  return {
    kind: 'ok',
    provider: 'moonshot',
    symbol: '$',
    total,
    title: `Moonshot · ${breakdown}`,
    dotColor: available > 0
      ? 'var(--dsw-alias-state-success-primary)'
      : 'var(--dsw-alias-state-error-primary)',
  }
}

/**
 * Shape the Zhipu / GLM (Z.ai) response into the chip display state. The host
 * unwraps the account-report container, whose balance sits under a variety of
 * names (`balance`, `availableBalance`, `available_balance`, …) with a currency
 * that defaults to CNY. This is a prepaid account amount in the provider's
 * currency, not necessarily dollars.
 */
function renderZhipu(data: BalanceResponse): DisplayState {
  const info = data.balance
  const container = info !== undefined && info !== null && typeof info === 'object' && !Array.isArray(info)
    ? (info as Record<string, unknown>)
    : undefined
  if (container === undefined) return { kind: 'error', message: 'No Zhipu balance info returned' }
  // The report may be a list of resource-pack entries; take the first that
  // names a numeric balance.
  const entries = Array.isArray(container.data)
    ? (container.data as Array<Record<string, unknown>>)
    : [container]
  let remaining: number | undefined
  for (const entry of entries) {
    for (const key of ['available_balance', 'availableBalance', 'balance', 'total_balance', 'totalBalance', 'rechargeAmount']) {
      const value = entry[key]
      if (typeof value === 'number') { remaining = value; break }
    }
    if (remaining !== undefined) break
  }
  if (remaining === undefined) return { kind: 'error', message: 'No Zhipu balance amount returned' }
  const currency = typeof container.currency === 'string' ? container.currency : 'CNY'
  const symbol = currencySymbol(currency)
  const total = Math.max(0, remaining).toFixed(2)
  return {
    kind: 'ok',
    provider: 'zhipu',
    symbol,
    total,
    title: `Zhipu · remaining ${symbol}${total}`,
    dotColor: remaining > 0
      ? 'var(--dsw-alias-state-success-primary)'
      : 'var(--dsw-alias-state-error-primary)',
  }
}

/**
 * Shape the MiniMax response into the chip display state. The host relays the
 * top-level token-plan body; the first `model_remains` entry carries the
 * remaining prompts (MiniMax reports the mislabeled `current_interval_usage_count`
 * as the remainder, with explicit `*_remaining_*` aliases) or a remaining
 * percentage. This is a subscription quota, not a prepaid dollar balance, so
 * the chip renders the count or percent rather than a currency amount.
 */
function renderMiniMax(data: BalanceResponse): DisplayState {
  const info = data.balance
  const entry = info?.model_remains?.[0]
  if (entry === undefined) return { kind: 'error', message: 'No MiniMax plan info returned' }
  const remainingCount = typeof entry.current_interval_remaining_count === 'number'
    ? entry.current_interval_remaining_count
    : typeof entry.current_interval_remains_count === 'number'
      ? entry.current_interval_remains_count
      : typeof entry.current_interval_usage_count === 'number'
        ? entry.current_interval_usage_count
        : undefined
  const remainingPercent = typeof entry.current_interval_remaining_percent === 'number'
    ? entry.current_interval_remaining_percent
    : undefined
  const plan = entry.current_subscribe_title ?? entry.plan_name ?? entry.plan ?? 'MiniMax'
  if (remainingCount !== undefined) {
    const label = remainingPercent !== undefined ? `${remainingCount} (${remainingPercent}%)` : String(remainingCount)
    return {
      kind: 'ok',
      provider: 'minimax',
      symbol: '',
      total: label,
      title: `${plan} · ${remainingCount} remaining`,
      dotColor: remainingCount > 0
        ? 'var(--dsw-alias-state-success-primary)'
        : 'var(--dsw-alias-state-error-primary)',
    }
  }
  if (remainingPercent !== undefined) {
    return {
      kind: 'ok',
      provider: 'minimax',
      symbol: '',
      total: `${remainingPercent}%`,
      title: `${plan} · ${remainingPercent}% remaining`,
      dotColor: remainingPercent > 0
        ? 'var(--dsw-alias-state-success-primary)'
        : 'var(--dsw-alias-state-error-primary)',
    }
  }
  return { kind: 'error', message: 'No MiniMax remaining value returned' }
}

/** Choose the provider-aware display state for a host response. */
function displayState(data: BalanceResponse): DisplayState {
  switch (data.provider ?? 'deepseek') {
    case 'openrouter': return renderOpenRouter(data)
    case 'moonshot': return renderMoonshot(data)
    case 'zhipu': return renderZhipu(data)
    case 'minimax': return renderMiniMax(data)
    case 'deepseek':
    default: return renderDeepSeek(data)
  }
}

/** DeepSeek brand mark (whale), LobeHub 24×24 glyph — fills `currentColor`, so it inherits the chip color. */
const DEEPSEEK_LOGO_PATH = 'M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z'

/** OpenRouter brand mark (route), LobeHub 24×24 glyph — fills `currentColor`. */
const OPENROUTER_LOGO_PATH = 'M18.654 3.87a5.087 5.087 0 110 10.174L23.7 19.09c.64.641.187 1.737-.72 1.737H8.48a8.479 8.479 0 010-16.958h10.175zM8.479 7.26a5.087 5.087 0 100 10.176 5.087 5.087 0 000-10.175z'

/** Moonshot/Kimi brand mark (Kimi), LobeHub 24×24 glyph — two paths, both fill `currentColor`. */
const MOONSHOT_LOGO_PATHS = [
  'M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z',
  'M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z',
]

/** Zhipu / Z.ai (GLM) brand mark, LobeHub 24×24 glyph — fills `currentColor`. */
const ZHIPU_LOGO_PATH = 'M12.105 2L9.927 4.953H.653L2.83 2h9.276zM23.254 19.048L21.078 22h-9.242l2.174-2.952h9.244zM24 2L9.264 22H0L14.736 2H24z'

/** MiniMax brand mark, LobeHub 24×24 glyph — fills `currentColor`. */
const MINIMAX_LOGO_PATH = 'M16.278 2c1.156 0 2.093.927 2.093 2.07v12.501a.74.74 0 00.744.709.74.74 0 00.743-.709V9.099a2.06 2.06 0 012.071-2.049A2.06 2.06 0 0124 9.1v6.561a.649.649 0 01-.652.645.649.649 0 01-.653-.645V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v7.472a2.037 2.037 0 01-2.048 2.026 2.037 2.037 0 01-2.048-2.026v-12.5a.785.785 0 00-.788-.753.785.785 0 00-.789.752l-.001 15.904A2.037 2.037 0 0113.441 22a2.037 2.037 0 01-2.048-2.026V18.04c0-.356.292-.645.652-.645.36 0 .652.289.652.645v1.934c0 .263.142.506.372.638.23.131.514.131.744 0a.734.734 0 00.372-.638V4.07c0-1.143.937-2.07 2.093-2.07zm-5.674 0c1.156 0 2.093.927 2.093 2.07v11.523a.648.648 0 01-.652.645.648.648 0 01-.652-.645V4.07a.785.785 0 00-.789-.78.785.785 0 00-.789.78v14.013a2.06 2.06 0 01-2.07 2.048 2.06 2.06 0 01-2.071-2.048V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v3.8a2.06 2.06 0 01-2.071 2.049A2.06 2.06 0 010 12.9v-1.378c0-.357.292-.646.652-.646.36 0 .653.29.653.646V12.9c0 .418.343.757.766.757s.766-.339.766-.757V9.099a2.06 2.06 0 012.07-2.048 2.06 2.06 0 012.071 2.048v8.984c0 .419.343.758.767.758.423 0 .766-.339.766-.758V4.07c0-1.143.937-2.07 2.093-2.07z'

/**
 * One or more LobeHub 24×24 brand-mark paths per provider, all filled with
 * `currentColor` so they inherit the chip's muted label color across
 * light/dark themes. Every known provider has a real mark; adding a provider
 * means adding an entry here (and its kind to {@link BalanceKind}).
 */
const PROVIDER_LOGO_PATHS: Record<BalanceKind, string[]> = {
  deepseek: [DEEPSEEK_LOGO_PATH],
  openrouter: [OPENROUTER_LOGO_PATH],
  moonshot: MOONSHOT_LOGO_PATHS,
  zhipu: [ZHIPU_LOGO_PATH],
  minimax: [MINIMAX_LOGO_PATH],
}

/**
 * A small theme-friendly brand glyph for a provider, rendered left of the
 * amount. Each provider's mark fills `currentColor`, so it adapts to the
 * chip's muted label color across light/dark themes.
 */
function ProviderLogo({ provider, size = 14 }: { provider: BalanceKind; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      style={{ flexShrink: 0, display: 'block' }}
      aria-hidden="true"
    >
      {PROVIDER_LOGO_PATHS[provider].map((d) => <path key={d} d={d} />)}
    </svg>
  )
}

/** Slim right-aligned chip. */
const chipStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 6,
  marginLeft: 'auto',
  padding: '0 12px',
  height: 30,
  margin: '4px 0 6px',
  minWidth: 0,
  flexShrink: 0,
  boxSizing: 'border-box',
  borderRadius: 12,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  color: 'var(--dsw-alias-label-secondary)',
  fontFamily: 'inherit',
  fontSize: 12,
  lineHeight: '18px',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
}

/**
 * The sidebar core normally stacks footer actions above Settings. This helper
 * mirrors the one-row layout (Settings left, actions right) from the plugin's
 * own DOM anchor, so no core DSH CSS patch is required.
 */
function applySidebarFooterLayout(anchor: HTMLElement): void {
  const outlet = anchor.closest<HTMLElement>('[data-slot="sidebar.footer.action"]')
  const actions = outlet?.parentElement
  const foot = actions?.parentElement
  const settings = actions?.nextElementSibling
  if (outlet !== null && outlet !== undefined) outlet.style.display = 'contents'
  if (actions !== undefined && actions !== null) {
    actions.style.flex = '1'
    actions.style.minWidth = '0'
    actions.style.width = 'auto'
    actions.style.display = 'flex'
    actions.style.justifyContent = 'flex-end'
  }
  if (settings !== undefined && settings !== null) {
    settings.style.flex = 'none'
    settings.style.minWidth = '0'
    settings.style.width = 'auto'
  }
  if (foot !== undefined && foot !== null) {
    foot.style.display = 'flex'
    foot.style.flexDirection = 'row-reverse'
    foot.style.alignItems = 'center'
  }
}

/**
 * The balance chip component. Rendered by the slot runtime with the sidebar's
 * owner share (`wide`) plus the standard seat; `getModelDirectories` is the
 * lazy accessor the wrapper closes over, so the chip still resolves the service
 * when the model-selection plugin activates after this one.
 * @param props - composed slot props plus the injected model-directory accessor.
 * @returns the chip element, or null in the collapsed rail.
 */
export function BalanceChip({
  wide,
  getModelDirectories,
  useSessions,
}: PropsRuntime<'sidebar.footer.action'> & {
  getModelDirectories: () => ModelDirectoryServiceLike | undefined
}) {
  const [state, setState] = useState<DisplayState>({ kind: 'loading' })
  const anchorRef = useRef<HTMLDivElement>(null)
  const activeSession = useSessions(
    (snapshot) => currentSessionId(snapshot as unknown as SessionsSnapshotLike),
  )

  const refresh = useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      const kind = kindForSession(getModelDirectories(), activeSession)
      const res = await fetch(`${BALANCE_ENDPOINT}?kind=${kind}`, { headers: { accept: 'application/json' } })
      const data = (await res.json()) as BalanceResponse
      setState(data.ok ? displayState(data) : { kind: 'error', message: data.message ?? data.error ?? 'unavailable' })
    } catch {
      setState({ kind: 'error', message: 'Failed to load' })
    }
  }, [getModelDirectories, activeSession])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, REFRESH_INTERVAL_MS)
    return () => { window.clearInterval(timer) }
  }, [refresh])

  // Subscribe to the active session's model-directory store so the chip
  // re-polls as soon as the directory resolves and whenever flipping the model
  // in the dropdown changes the current provider, without waiting for the next
  // 60s tick.
  useEffect(() => {
    const modelDirectories = getModelDirectories()
    if (modelDirectories === undefined || activeSession === undefined) return
    let directory: { store: ModelDirectoryStoreLike }
    try {
      directory = modelDirectories.directoryFor(activeSession)
    } catch {
      return // e.g. an addressed subagent session — the timer/direct refresh still cover it.
    }
    let lastProvider = directory.store.getSnapshot().current?.provider
    const onModelChange = (): void => {
      const provider = directory.store.getSnapshot().current?.provider
      if (provider !== lastProvider) {
        lastProvider = provider
        void refresh()
      }
    }
    const unsubscribe = directory.store.subscribe(onModelChange)
    return () => { unsubscribe() }
  }, [getModelDirectories, activeSession, refresh])

  useLayoutEffect(() => {
    if (!wide) return
    const anchor = anchorRef.current
    if (anchor !== null) applySidebarFooterLayout(anchor)
  }, [wide])

  // The collapsed 56px rail has no room beside the settings gear; the chip
  // appears only in the wide sidebar.
  if (!wide) return null

  return (
    <div ref={anchorRef} style={{ display: 'contents' }}>
      {state.kind === 'loading' ? (
        <div style={chipStyle} title="Loading balance…" aria-busy="true">
          <span>Loading…</span>
        </div>
      ) : state.kind === 'error' ? (
        <button type="button" style={chipStyle} title={`Balance unavailable — ${state.message} (click to retry)`} onClick={() => { void refresh() }}>
          <span>Balance —</span>
        </button>
      ) : (
        <button type="button" style={chipStyle} title={`${state.title} (click to refresh)`} onClick={() => { void refresh() }}>
          <ProviderLogo provider={state.provider} />
          <span>{state.symbol}{state.total}</span>
          <span
            role="img"
            aria-label={state.title}
            style={{
              flex: 'none',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: state.dotColor,
            }}
          />
        </button>
      )}
    </div>
  )
}

/**
 * Register the chip into the sidebar foot on the `sidebar.footer.action`
 * slot (declared by the ui-sidebar package; registration is an effect that
 * unwinds when this plugin unloads). The wrapper closes over the plugin scope
 * so the chip can read the active model's provider from the model-directory
 * service — resolved lazily, because that service is optional and may
 * activate after this plugin.
 * @param ctx - client plugin context carrying `slots`.
 */
export function apply(ctx: ClientContext): void {
  ctx.inject(['slots'], (scope: ClientContext) => {
    // Optional: the model-directory service lets the chip read the active
    // session's provider and re-poll the moment the model changes. Absent in a
    // composition without the model-selection plugin; the chip then keeps its
    // original DeepSeek behavior.
    const getModelDirectories = (): ModelDirectoryServiceLike | undefined =>
      scope.get('modelDirectories') as ModelDirectoryServiceLike | undefined
    scope.slots.inject('sidebar.footer.action', () => scope.slots.register({
      name: 'sidebar.footer.action',
      id: 'balance',
      order: 0,
    }, (props) => (
      <BalanceChip {...props} getModelDirectories={getModelDirectories} />
    )))
  })
}
