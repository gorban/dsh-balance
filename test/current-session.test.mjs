// Regression coverage for the alpha.2 sessions-snapshot change.
//
// DSH alpha.1 carried the open Session id on the sessions list snapshot as
// `current`. alpha.2 removed that field — ISessions.list now documents that
// "navigation belongs to view owners" — so `useSessions(s => s.current)` became
// permanently undefined. The chip then fell through to its DeepSeek fallback,
// and because this machine has no DEEPSEEK_API_KEY the sidebar showed
// "Balance —" instead of the OpenRouter credit the session was really spending.
//
// The chip must therefore resolve the open Session from BOTH shapes: alpha.1's
// `current`, and alpha.2's main-view retention (`retainedBy.mainView`), which is
// the derivation ui-session and DocumentTitle use.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BUNDLE = join(ROOT, 'lib/client.js')

/**
 * Extract one `function name(...) { ... }` declaration by brace matching.
 * @param source - the bundle text.
 * @param name - the function name to find.
 * @returns the function's source text, or undefined when the bundle omits it.
 */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) return undefined
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}`)
}

/**
 * Evaluate the session resolver exactly as it appears in the built bundle.
 * @param bundle - the bundle text.
 * @returns the bundle's own `currentSessionId`.
 */
function loadResolver(bundle) {
  const source = extractFunction(bundle, 'currentSessionId')
  assert.notEqual(source, undefined, 'the bundle must declare currentSessionId')
  return new Function(`${source}\nreturn currentSessionId`)()
}

test('alpha.1 snapshot: the selected id is read from `current`', () => {
  const currentSessionId = loadResolver(readFileSync(BUNDLE, 'utf8'))
  assert.equal(currentSessionId({ current: 'session-alpha1', byId: {} }), 'session-alpha1')
  // `current` wins even when rows also carry retention.
  assert.equal(
    currentSessionId({
      current: 'session-selected',
      byId: { other: { id: 'session-retained', retainedBy: { mainView: 1 } } },
    }),
    'session-selected',
  )
})

test('alpha.2 snapshot: the open Session comes from main-view retention', () => {
  const currentSessionId = loadResolver(readFileSync(BUNDLE, 'utf8'))
  // The reported case: `current` is gone, so the retained row must be used.
  assert.equal(
    currentSessionId({
      byId: {
        idle: { id: 'session-idle', retainedBy: {} },
        open: { id: 'session-open', retainedBy: { mainView: 1 } },
      },
    }),
    'session-open',
  )
  // Retention is a count: any positive number means the main view owns it.
  assert.equal(
    currentSessionId({ byId: { open: { id: 'session-open', retainedBy: { mainView: 2 } } } }),
    'session-open',
  )
})

test('an empty or unresolved snapshot yields no Session rather than throwing', () => {
  const currentSessionId = loadResolver(readFileSync(BUNDLE, 'utf8'))
  // alpha.2's SessionListState always has byId, but be total on the shape.
  assert.equal(currentSessionId({}), undefined)
  assert.equal(currentSessionId({ byId: {} }), undefined)
  assert.equal(currentSessionId({ current: null, byId: {} }), undefined)
  assert.equal(currentSessionId({ byId: { idle: { id: 'session-idle', retainedBy: {} } } }), undefined)
  // A row without an id is skipped instead of returning undefined-as-found.
  assert.equal(currentSessionId({ byId: { open: { retainedBy: { mainView: 1 } } } }), undefined)
})
