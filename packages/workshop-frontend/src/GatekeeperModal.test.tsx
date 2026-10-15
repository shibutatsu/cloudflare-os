// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AiChatAuthorInfo, AuthenticatedApi, ConnectedAccountsSubscriber, ModelKind } from '@gadgets/workshop-shared/api'
import type { AccountDescription, SupportedResource } from '@gadgets/workshop-shared/gatekeeper'

const testState = vi.hoisted(() => ({
  authenticatedApi: null as RpcStub<AuthenticatedApi> | null,
  readinessEvents: [] as (boolean | null)[],
  configurator: null as {
    acceptedResourceUrlPatterns: readonly string[]
    initialResourceUrl?: string
    resourceUrlPattern?: string
  } | null,
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: testState.authenticatedApi }),
}))

vi.mock('./ResourceConfiguratorHost', async () => {
  const { useEffect } = await import('react')

  const ResourceConfiguratorHost = ({
    frame,
    loading,
    disabled,
    acceptedResourceUrlPatterns,
    initialResourceUrl,
    resourceUrlPattern,
    onCollectResourceUrlChange,
    onSelectionReadyChange,
  }: {
    frame: object | null
    loading: boolean
    disabled: boolean
    acceptedResourceUrlPatterns: readonly string[]
    initialResourceUrl?: string
    resourceUrlPattern?: string
    onCollectResourceUrlChange?: (collect: (() => Promise<string>) | null) => void
    onSelectionReadyChange?: (ready: boolean | null) => void
  }) => {
    useEffect(() => {
      testState.configurator = { acceptedResourceUrlPatterns, initialResourceUrl, resourceUrlPattern }
    }, [acceptedResourceUrlPatterns, initialResourceUrl, resourceUrlPattern])
    const mounted = Boolean(frame && !loading && !disabled)
    useEffect(() => {
      if (!mounted) return
      onCollectResourceUrlChange?.(() => Promise.resolve('https://catalog.example.com/'))
      testState.readinessEvents.push(null)
      onSelectionReadyChange?.(null)
      return () => onCollectResourceUrlChange?.(null)
    }, [mounted, onCollectResourceUrlChange, onSelectionReadyChange])
    return mounted ? <div data-testid="resource-configurator" /> : null
  }

  return { default: ResourceConfiguratorHost }
})

import GatekeeperModal from './GatekeeperModal'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RESOURCE = {
  urlPattern: 'https://catalog.example.com/*',
  title: 'Service catalog',
  description: 'Example service catalog',
}

function subscription() {
  return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), {
    [Symbol.dispose]() {},
  })
}

const CHAT_MODEL: AiChatAuthorInfo = { type: 'agent', id: 'chat-model', name: 'Chat model' }
const DECISION_MODEL: AiChatAuthorInfo = { type: 'agent', id: 'decision-model', name: 'Decision model' }

type Catalog = {
  resources?: SupportedResource[]
  description?: Partial<AccountDescription>
  startResourceConfigurator?: (accountId: number, resourceUrlPattern: string) => void
  ensureAccountResources?: (accountId: number, resourceUrlPatterns: string[]) => void
}

function authenticatedApi(catalog: Catalog = {}): RpcStub<AuthenticatedApi> {
  const vendor = { displayName: 'Service catalog', url: 'https://catalog.example.com/' }
  return {
    listModels: async (kind?: ModelKind) => kind === 'decision' ? [DECISION_MODEL] : [CHAT_MODEL],
    listGatekeeperVendors: async () => [{
      id: 'catalog',
      description: vendor,
      supportedResources: catalog.resources ?? [RESOURCE],
    }],
    subscribeConnectedAccounts: (subscriber: ConnectedAccountsSubscriber) => {
      subscriber.add(1, {
        displayName: 'Catalog account',
        avatar: { url: 'https://catalog.example.com/avatar' },
        ...catalog.description,
      }, vendor, catalog.resources ?? [RESOURCE], true, 'catalog')
      subscriber.ready()
      return subscription()
    },
    startResourceConfigurator: async (accountId: number, resourceUrlPattern: string) => {
      catalog.startResourceConfigurator?.(accountId, resourceUrlPattern)
      return { iframeHtml: '<!doctype html>', ui: { [Symbol.dispose]() {} } }
    },
    ensureAccountResources: async (accountId: number, resourceUrlPatterns: string[]) => {
      catalog.ensureAccountResources?.(accountId, resourceUrlPatterns)
      return null
    },
  } as unknown as RpcStub<AuthenticatedApi>
}

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  testState.authenticatedApi = null
  testState.readinessEvents = []
  testState.configurator = null
  vi.unstubAllGlobals()
})

async function renderModal(
  props: { initialVendorId?: string, initialResourceUrl?: string, initialResourceUrlPattern?: string } = {},
  catalog?: Catalog,
) {
  testState.authenticatedApi = authenticatedApi(catalog)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => root!.render(<GatekeeperModal
    open
    onClose={() => {}}
    getOverseer={() => { throw new Error('not called') }}
    onCreated={() => Promise.resolve()}
    {...props}
  />))
}

describe('GatekeeperModal configurator readiness', () => {
  it('keeps Add connection disabled for a lifecycle null readiness event', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    await renderModal({ initialVendorId: 'catalog', initialResourceUrlPattern: RESOURCE.urlPattern })

    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-testid="resource-configurator"]')).not.toBeNull()
      expect(testState.readinessEvents).toEqual([null])
    })

    const addConnection = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === 'Add connection')!
    expect(addConnection.disabled).toBe(true)
  })
})

describe('GatekeeperModal grouped resource types', () => {
  const CATALOG = {
    urlPattern: 'https://catalog.example.com/:path+',
    title: 'Whole catalog',
    description: 'Every service',
    grantable: true,
  }
  const SERVICE = {
    urlPattern: 'https://catalog.example.com/services/:id',
    title: 'Service',
    description: 'One service',
    grantable: true,
    groupedWith: CATALOG.urlPattern,
  }
  // The catalog's pattern also matches a service's URL, as a GitLab project's matches a merge
  // request's, so the vendor declares the more specific type first: resolving a URL takes the first
  // match.
  const RESOURCES = [SERVICE, CATALOG]
  const BOTH_GRANTED = { grantedResourceUrlPatterns: [CATALOG.urlPattern, SERVICE.urlPattern] }

  const buttonLabels = () => Array.from(document.body.querySelectorAll('button'), button => button.textContent)

  it('lists grouped types as one card', async () => {
    await renderModal({}, { resources: RESOURCES, description: BOTH_GRANTED })
    await vi.waitFor(() => {
      expect(document.body.querySelector('[aria-controls="connection-group-panel-vendor:catalog"]')).not.toBeNull()
    })
    await act(async () => document.body.querySelector<HTMLButtonElement>(
      '[aria-controls="connection-group-panel-vendor:catalog"]')!.click())

    expect(Array.from(document.getElementById('connection-group-panel-vendor:catalog')!
      .querySelectorAll('button p:first-child'), title => title.textContent)).toEqual([CATALOG.title])
  })

  // The agent asked for a service, so the card that picks services opens on it, while the user may
  // still choose anything the card offers.
  it('opens an agent request for a grouped type on its card, pre-filled', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    const startResourceConfigurator = vi.fn<(accountId: number, resourceUrlPattern: string) => void>()
    const initialResourceUrl = 'https://catalog.example.com/services/s1'
    await renderModal(
      { initialVendorId: 'catalog', initialResourceUrl, initialResourceUrlPattern: SERVICE.urlPattern },
      { resources: RESOURCES, description: BOTH_GRANTED, startResourceConfigurator },
    )

    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-testid="resource-configurator"]')).not.toBeNull()
    })
    expect(startResourceConfigurator.mock.calls).toEqual([[1, CATALOG.urlPattern]])
    expect(testState.configurator).toEqual({
      acceptedResourceUrlPatterns: [SERVICE.urlPattern, CATALOG.urlPattern],
      initialResourceUrl,
      resourceUrlPattern: SERVICE.urlPattern,
    })
  })

  // The configurator can return any of the card's types, so the account must hold every one first.
  it('asks an account missing a grouped type to grant it before the configurator opens', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    const ensureAccountResources = vi.fn<(accountId: number, resourceUrlPatterns: string[]) => void>()
    await renderModal({ initialVendorId: 'catalog', initialResourceUrlPattern: CATALOG.urlPattern }, {
      resources: RESOURCES,
      description: { grantedResourceUrlPatterns: [CATALOG.urlPattern] },
      ensureAccountResources,
    })

    await vi.waitFor(() => expect(buttonLabels()).toContain('Grant access'))
    expect(document.body.querySelector('[data-testid="resource-configurator"]')).toBeNull()
    await act(async () => Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === 'Grant access')!.click())
    expect(ensureAccountResources.mock.calls).toEqual([[1, [SERVICE.urlPattern]]])
  })
})

describe('GatekeeperModal model pickers', () => {
  // A decision model can back an AI Model binding but can't run an agent. The AI Model picker labels
  // each model with its kind.
  it.each([
    { groupKey: 'platform:ai-model', picker: 'Select an AI model',
      options: ['Language models: Chat model', 'Decision models: Decision model'] },
    { groupKey: 'platform:agent-spawner', picker: 'Agent model', options: ['None (no agent)', 'Chat model'] },
  ])('offers $options in the $groupKey picker', async ({ groupKey, picker, options }) => {
    await renderModal()

    const group = document.body.querySelector<HTMLButtonElement>(
      `[aria-controls="connection-group-panel-${groupKey}"]`)!
    await act(async () => group.click())
    await act(async () => document.getElementById(`connection-group-panel-${groupKey}`)!
      .querySelector('button')!.click())
    await act(async () => document.body.querySelector<HTMLButtonElement>(`[aria-label="${picker}"]`)!.click())

    expect(Array.from(document.body.querySelectorAll('[role="option"]'), option => {
      const heading = option.closest('[role="group"]')?.getAttribute('aria-labelledby')
      return heading ? `${document.getElementById(heading)!.textContent}: ${option.textContent}` : option.textContent
    })).toEqual(options)
  })
})
