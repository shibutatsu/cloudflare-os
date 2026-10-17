// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { ChatGptConnection } from './ChatGptConnection'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals() })
const click = async (name: string) => {
  const button = [...document.querySelectorAll('button')].find(b => b.textContent === name)
  if (!button) throw new Error(`Missing button ${name}`)
  await act(async () => button.click())
}
const choose = async (label: string, option: string) => {
  const select = document.querySelectorAll<HTMLElement>('[role="combobox"]')[label === 'ChatGPT account' ? 0 : 1]
  await act(async () => select.click())
  const item = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(el => el.textContent === option)!
  const view: { PointerEvent?: typeof MouseEvent } = window
  view.PointerEvent = MouseEvent
  try {
    await act(async () => { item.focus() })
    await act(async () => { item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
  } finally { delete view.PointerEvent }

}
const setup = async (route: (path: string, body: any) => unknown | Promise<unknown>) => {
  const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url: string, init?: RequestInit) => {
    const data = await route(new URL(url).pathname, JSON.parse(String(init?.body ?? '{}')))
    return data instanceof Response ? data : Response.json(data)
  })
  vi.stubGlobal('fetch', fetcher)
  const api = { addModel: vi.fn<AuthenticatedApi['addModel']>(async () => {}), updateModel: vi.fn<AuthenticatedApi['updateModel']>(async () => {}), listModels: vi.fn<AuthenticatedApi['listModels']>(async () => []) }
  const onSuccess = vi.fn<() => void>()
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(<ChatGptConnection authenticatedApi={api as unknown as RpcStub<AuthenticatedApi>} onSuccess={onSuccess} />))
  return { fetcher, api, onSuccess }
}
const accounts = [{ id: 'account', label: 'example@example.test · account', connected: true }]
const catalog = [{ slug: 'model', display_name: 'Test model' }]
const connection = { profile: { id: 'chatgpt:account:model', type: 'agent', name: 'ChatGPT · Test' },
  config: { provider: 'openai', model: 'model', apiToken: 'local-capability', billingMode: 'chatgpt-plan' } }
const route = (path: string) => ({ '/status': { accounts }, '/models': { models: catalog }, '/connection': connection }[path])

it('shows an empty state and retries an unavailable local bridge', async () => {
  let failed = true
  await setup(() => { if (failed) throw new TypeError('offline'); return { accounts: [] } })
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Local ChatGPT bridge unavailable')
  failed = false
  await click('Retry')
  expect(document.querySelector('[role="alert"]')).toBeNull()
  expect(document.querySelector('[role="status"]')?.textContent).toBe('Not connected')
})
it('does not save an empty selection and retains valid account selection', async () => {
  const { api } = await setup(route)
  await choose('ChatGPT account', accounts[0].label)
  await click('Add ChatGPT model')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Select an account and model')
  expect(api.addModel).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain(accounts[0].label)
})
it('saves once on three rapid clicks and never submits an OAuth token', async () => {
  let resolve: (value: unknown) => void
  const { api, onSuccess } = await setup(path => path === '/connection' ? new Promise(r => { resolve = r }) : route(path))
  await choose('ChatGPT account', accounts[0].label)
  await choose('ChatGPT model', 'Test model')
  const add = [...document.querySelectorAll('button')].find(b => b.textContent === 'Add ChatGPT model')!
  await act(async () => { add.click(); add.click(); add.click() })
  expect(document.querySelector('[role="status"]')?.textContent).toBe('Saving…')
  await act(async () => resolve!(connection))
  expect(api.addModel).toHaveBeenCalledTimes(1)
  expect(api.addModel).toHaveBeenCalledWith(connection.profile, connection.config)
  expect(onSuccess).toHaveBeenCalledTimes(1)
})
it('retains input and permits retry after a save failure', async () => {
  const { api, onSuccess } = await setup(route)
  api.addModel.mockRejectedValueOnce(new Error('Storage unavailable'))
  await choose('ChatGPT account', accounts[0].label)
  await choose('ChatGPT model', 'Test model')
  await click('Add ChatGPT model')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Storage unavailable')
  expect(document.body.textContent).toContain('Test model')
  expect(onSuccess).not.toHaveBeenCalled()
  await click('Add ChatGPT model')
  expect(onSuccess).toHaveBeenCalledOnce()
})
it('handles an empty model catalog without a blank form', async () => {
  await setup(path => path === '/models' ? { models: [] } : route(path))
  await choose('ChatGPT account', accounts[0].label)
  expect(document.body.textContent).toContain('0 models')
})
it('keeps remote revocation failure distinct from local sign-out', async () => {
  await setup(path => path === '/logout' ? { revoked: false } : route(path))
  await choose('ChatGPT account', accounts[0].label)
  await click('Sign out')
  expect(document.body.textContent).toContain('Remote revocation unconfirmed')
})
it('reports popup blocking without starting authorization', async () => {
  const { fetcher } = await setup(route)
  vi.spyOn(window, 'open').mockReturnValue(null)
  await click('Continue with ChatGPT')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('popup blocked')
  expect(fetcher.mock.calls.some(call => call[0].endsWith('/login'))).toBe(false)
})
