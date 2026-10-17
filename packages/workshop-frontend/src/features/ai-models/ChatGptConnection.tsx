import { useEffect, useRef, useState } from 'react'
import { Button, Select } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AiChatAuthorInfo, AuthenticatedApi, RedactedAiModelConfig } from '@gadgets/workshop-shared/api'

type Account = { id: string; label: string; connected: boolean }
type Model = { slug: string; display_name: string }
const BRIDGE = 'http://127.0.0.1:1455'

async function call<T>(path: string, body?: object, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${BRIDGE}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'X-Cloudflare-OS': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(35_000),
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new Error('Local ChatGPT bridge unavailable.', { cause: error })
  }
  const result = await response.json()
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'ChatGPT connection failed.')
  return result
}

export const ChatGptConnection = ({ authenticatedApi, onSuccess }: {
  authenticatedApi: RpcStub<AuthenticatedApi>; onSuccess: () => void
}) => {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [accountId, setAccountId] = useState('')
  const [models, setModels] = useState<Model[]>([])
  const [model, setModel] = useState('')
  const [action, setBusy] = useState('')
  const [loadingAccounts, setLoadingAccounts] = useState(true)
  const [loadingModels, setLoadingModels] = useState(false)
  const busy = action || (loadingAccounts ? 'Loading…' : loadingModels ? 'Loading models…' : '')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [attemptId, setAttemptId] = useState('')
  const [reload, setReload] = useState(0)
  const saving = useRef(false)
  const alive = useRef(true)
  const popup = useRef<Window | null>(null)
  const selected = accounts.find(a => a.id === accountId)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; popup.current?.close() }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setLoadingAccounts(true)
    call<{ accounts: Account[] }>('status', undefined, controller.signal)
      .then(result => { setAccounts(result.accounts); setError('') })
      .catch(e => { if (!controller.signal.aborted) setError(e.message) })
      .finally(() => { if (!controller.signal.aborted) setLoadingAccounts(false) })
    return () => controller.abort()
  }, [reload])

  useEffect(() => {
    if (!selected?.connected) { setLoadingModels(false); return }
    const controller = new AbortController()
    setLoadingModels(true)
    call<{ models: Model[] }>('models', { accountId: selected.id }, controller.signal)
      .then(result => { setModels(result.models); setError('') })
      .catch(e => { if (!controller.signal.aborted) setError(e.message) })
      .finally(() => { if (!controller.signal.aborted) setLoadingModels(false) })
    return () => controller.abort()
  }, [selected?.id, selected?.connected, reload])

  useEffect(() => {
    if (!attemptId) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let finished = false
    const poll = async () => {
      try {
        const result = await call<{ status: string; accountId?: string; error?: string }>(
          'attempt', { attemptId }, controller.signal)
        if (controller.signal.aborted) return
        if (result.status === 'complete' || result.status === 'error') {
          finished = true
          popup.current?.close()
          setAttemptId('')
          setBusy('')
          if (result.status === 'complete') {
            setAccountId(result.accountId!)
            setNotice('Using ChatGPT plan')
            setReload(n => n + 1)
          } else setError(result.error ?? 'Sign-in failed.')
          return
        }
        if (popup.current?.closed) {
          await call('attempt', { attemptId, cancel: true }, controller.signal)
        }
        timer = setTimeout(poll, 1000)
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : 'Sign-in failed.')
          setAttemptId('')
          setBusy('')
        }
      }
    }
    void poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
      if (!finished) void call('attempt', { attemptId, cancel: true }).catch(() => {})
      popup.current?.close()
    }
  }, [attemptId])

  const signIn = async () => {
    if (saving.current) return
    saving.current = true
    popup.current = window.open('about:blank', '_blank')
    if (!popup.current) { saving.current = false; setError('Sign-in popup blocked. Allow popups and retry.'); return }
    popup.current.opener = null
    setBusy('Signing in…')
    setError('')
    try {
      const result = await call<{ url: string; attemptId: string }>('login', accountId ? { accountId } : {})
      if (!alive.current) { await call('attempt', { attemptId: result.attemptId, cancel: true }); return }
      popup.current.location.href = result.url
      setAttemptId(result.attemptId)
    } catch (e) {
      popup.current.close()
      setError(e instanceof Error ? e.message : 'Sign-in failed.')
      setBusy('')
    } finally { saving.current = false }
  }

  const add = async () => {
    if (saving.current) return
    if (!model || !selected?.connected) { setError('Select an account and model.'); return }
    saving.current = true
    setBusy('Saving…')
    setError('')
    try {
      const result = await call<{ profile: AiChatAuthorInfo; config: RedactedAiModelConfig }>(
        'connection', { accountId, model })
      const existing = await authenticatedApi.listModels()
      if (existing.some(m => m.id === result.profile.id)) {
        await authenticatedApi.updateModel(result.profile, result.config)
      } else await authenticatedApi.addModel(result.profile, result.config)
      onSuccess()
    } catch (e) { setError(e instanceof Error ? e.message : 'Model save failed.') }
    finally { saving.current = false; setBusy('') }
  }

  const signOut = async () => {
    if (saving.current) return
    saving.current = true
    setBusy('Signing out…')
    setError('')
    try {
      const result = await call<{ revoked: boolean }>('logout', { accountId })
      setNotice(result.revoked ? 'Signed out' : 'Signed out locally. Remote revocation unconfirmed.')
      setModel('')
      setModels([])
      setReload(n => n + 1)
    } catch (e) { setError(e instanceof Error ? e.message : 'Sign-out failed.') }
    finally { saving.current = false; setBusy('') }
  }

  return <div className="space-y-4 text-base leading-6" aria-busy={!!busy}>
    <Select label="ChatGPT account" size="lg" className="w-full min-h-11 min-w-0 max-w-full !ring-current focus-visible:!outline-2 focus-visible:!outline-offset-2 focus-visible:!outline-current" placeholder="New account" value={accountId}
      disabled={!!busy} onValueChange={value => {
        setAccountId(value ?? ''); setModels([]); setModel(''); setError(''); setNotice('')
      }} renderValue={value => accounts.find(a => a.id === value)?.label ?? 'New account'}>
      <Select.Option value="">New account</Select.Option>
      {accounts.map(account => <Select.Option key={account.id} value={account.id}>{account.label}</Select.Option>)}
    </Select>
    <div className="flex flex-wrap gap-2">
      <Button size="lg" className="min-h-11 border border-current focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current" onClick={signIn} disabled={!!busy}>Continue with ChatGPT</Button>
      {selected?.connected && <Button size="lg" className="min-h-11 border border-current focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current" onClick={signOut} disabled={!!busy}>Sign out</Button>}
      {attemptId && <Button size="lg" className="min-h-11 border border-current focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current" onClick={() => { setAttemptId(''); setBusy(''); setNotice('Sign-in cancelled.') }}>Cancel sign-in</Button>}
    </div>
    {selected?.connected && <>
      <Select label="ChatGPT model" size="lg" className="w-full min-h-11 min-w-0 max-w-full !ring-current focus-visible:!outline-2 focus-visible:!outline-offset-2 focus-visible:!outline-current" value={model} disabled={!!busy}
        placeholder={models.length ? 'Select model' : '0 models'}
        onValueChange={value => setModel(value ?? '')}
        renderValue={value => models.find(m => m.slug === value)?.display_name ?? value}>
        {models.map(item => <Select.Option key={item.slug} value={item.slug}>{item.display_name}</Select.Option>)}
      </Select>
      <Button size="lg" className="min-h-11 border border-current focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current" variant="secondary" onClick={add} disabled={!!busy}>Add ChatGPT model</Button>
    </>}
    <div role="status" className="break-words">{busy || notice || (selected?.connected ? 'Connected' : 'Not connected')}</div>
    {error && <div role="alert" className="space-y-2 break-words text-kumo-danger">
      <p>{error}</p>
      <Button size="lg" className="min-h-11 border border-current focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current" disabled={!!busy} onClick={() => setReload(n => n + 1)}>Retry</Button>
    </div>}
    <a className="inline-flex min-h-11 items-center underline text-kumo-default" href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Manage usage</a>
  </div>
}
