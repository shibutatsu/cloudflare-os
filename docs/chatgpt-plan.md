# Local ChatGPT plan connection

This fork adds **ChatGPT plan** beside **API key · Pay as you go** in the Add AI Model dialog. The existing chat model picker switches between saved connections. ChatGPT requests do not fall back to API-key or AI Gateway billing, including auxiliary title/summary requests.

## Run

Requirements: Node.js 24 or newer and the repository-pinned pnpm, a free loopback port 1455, and an eligible ChatGPT account with plan-usage permission.

```sh
pnpm install
pnpm run-local:chatgpt
```

Open http://localhost:8787. Create or sign into your local Workshop account. In model setup or AI Providers, choose **Add AI Model → ChatGPT plan → Continue with ChatGPT**. Complete OpenAI's account and consent screens, select the saved account and an available model, then choose **Add ChatGPT model**. The chat's model picker selects that connection or an existing API-key model. API keys continue to be configured through the existing form.

For a Workshop server that is already running, start the companion with `pnpm chatgpt`. Keep it running while using ChatGPT models. Development UI at http://localhost:3000 is also allowed. The callback is always `http://127.0.0.1:1455/auth/callback`; the bridge refuses to start if that port is occupied.

## Scope and credentials

This implementation is for **one trusted OS user running the Workshop locally**, with no AI Gateway configured. It is not a hosted multi-user credential service. ChatGPT controls appear on loopback origins only and are not offered in AI Gateway mode. Cloudflare deployment does not deploy this Node companion. Remote hosting requires a separately supported integration; do not expose this bridge over a tunnel or bind it to a public interface.

The companion performs the documented dynamic client registration, PKCE, state and nonce validation, signature/issuer/audience/expiry validation, scope checking, account-specific model discovery, serialized refresh-token rotation, and session revocation. It uses `https://api.openai.com/v1/responses`, never private ChatGPT backend endpoints or another application's tokens.

OAuth tokens stay in `.chatgpt/credentials.json`, an atomically replaced local file with owner-only permissions. The directory has mode 0700 and files have mode 0600; this is filesystem protection, not encryption at rest. The directory is gitignored. Workshop stores a separate random local capability for each ChatGPT registration, using its existing secret-redaction mechanism. It does not receive the OAuth tokens. Protect Workshop's local data and the `.chatgpt` directory together.

Saved registrations are independent even when their email addresses match. Signing out attempts remote revocation and removes local tokens; the client registration and stable host ID remain for reauthorization. If revocation could not be confirmed, the UI reports that separately and links to ChatGPT usage settings. In-flight inference is aborted on sign-out.

## Usage and limitations

ChatGPT plan usage is subject to account eligibility, granted permissions, model availability and usage limits. It is not unlimited. **Manage usage** opens https://chatgpt.com/settings/usage. Cloudflare hosting and connected external services can have their own charges; this change only routes LLM requests.

The bridge uses streaming, stateless Responses requests and sends the full history. It omits fields not supported by the documented preview, strips API-only cache options and content breakpoints, and groups local function/custom tools in a namespace with its required description. Hosted tools outside that subset are rejected. Completion is accepted only after `response.completed`; incomplete, failed, and interrupted streams become errors. A limit never triggers a paid API fallback. A selected ChatGPT model's local dollar estimate is zero; actual plan usage is managed in ChatGPT, not estimated as API billing.

## Verification

```sh
pnpm test:chatgpt
pnpm --filter @gadgets/workshop-frontend test:run src/features/ai-models/ChatGptConnection.test.tsx src/AddModelModal.test.tsx src/features/chat/composer/ComposerModelSelector.test.tsx
pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/ai-models.test.ts __tests__/user-models.test.ts
pnpm lint
```

The companion tests use a local signed OIDC provider and a local inference server. They verify rejection paths, file permissions, renewal, disconnect, and streaming semantics. They do not establish eligibility or successful inference with a real ChatGPT account. Live sign-in, account-specific model discovery, a chat response, and a function-tool round trip with GPT-6.1-Sol were verified on 2026-10-18. Live API-key inference and switching billing modes within one conversation remain unverified.

Official specifications checked on 2026-10-17:

- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
