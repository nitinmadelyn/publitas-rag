# Publitas RAG Chat Widget

An embeddable, vanilla TypeScript chat widget that lets shoppers ask
questions about a Publitas digital catalogue and get grounded, cited
answers from the RAG API (Phase 7). No framework, no build step on the
consuming page: it ships as a single self-contained `widget.js` file.

## Quick start

Add one `<script>` tag to any catalogue page:

```html
<script
  src="https://cdn.example.com/publitas-rag/widget.js"
  data-api-base-url="https://rag-api.publitas.com"
  data-api-key="YOUR_API_KEY"
  data-catalog="tupperware-digital-09-2026"
  data-lang="pt"
  async
></script>
```

That's it. The script mounts a chat bubble in the bottom-right corner of
the page on load. Clicking it opens a chat panel rendered inside a
Shadow DOM, so the widget's styles never leak into the host page and the
host page's styles never leak into the widget.

## Configuration attributes

All configuration is passed as `data-*` attributes on the `<script>` tag
itself. The widget reads `document.currentScript` synchronously at
load time, so the attributes must be present on the tag before the
script executes (this is why the script should not be moved or cloned
after the page loads).

| Attribute            | Required | Default                        | Description |
|-----------------------|:--------:|---------------------------------|-------------|
| `data-api-base-url`   | yes      | none                             | Base URL of the RAG API, e.g. `https://rag-api.publitas.com`. No trailing slash. |
| `data-api-key`        | yes      | none                             | API key sent as the `x-api-key` header on every request. See **Security** below. |
| `data-catalog`        | yes      | none                             | The catalogue slug to answer questions about, e.g. `tupperware-digital-09-2026`. Must match a catalogue already ingested by the RAG pipeline. |
| `data-lang`           | no       | `en`                             | BCP-47-ish language code used to pick the system prompt and UI copy (`en`, `pt`, ...). Falls back to `en` for unrecognized codes. |
| `data-title`          | no       | `"Ask about this catalog"`       | Header text shown at the top of the chat panel. |
| `data-placeholder`    | no       | `"Type your question..."`        | Placeholder text in the chat input box. |
| `data-greeting`       | no       | (language-specific default)      | First message shown from the assistant before the user asks anything. |
| `data-bubble-text`    | no       | `"Looking for something specific? Ask me 👋"` | Teaser text shown next to the launcher button (see **Teaser bubble** below) before the visitor opens the chat. |

Any attribute left out falls back to its default; an empty string is
treated the same as "not provided". Missing a required attribute
(`data-api-base-url`, `data-api-key`, or `data-catalog`) throws a
`WidgetConfigError` at load time and the widget does not mount, so a
misconfigured embed fails loudly in the console instead of silently
showing a broken UI.

## Teaser bubble

A short delay (1.5s) after the widget mounts, a small speech-bubble
prompt appears next to the launcher button showing `data-bubble-text`
(default: "Looking for something specific? Ask me 👋"). It is meant to
catch a browsing shopper's eye and give them a concrete reason to open
the chat, rather than relying on the bare chat icon alone.

The teaser disappears permanently for that page view the moment the
visitor does anything with it: clicking the teaser text opens the chat
panel directly, clicking its small close (✕) button dismisses it, and
opening the chat via the launcher button dismisses it too. It never
reappears afterward, even if the visitor closes the panel again, so it
never competes with the panel itself or nags a visitor who has already
engaged.

## What the widget does

1. Renders a floating chat bubble; clicking it opens/closes the panel.
2. On a user question, calls `POST {apiBaseUrl}/v1/catalogs/{catalog}/chat`
   with the `x-api-key` header and `{ query, lang }` body.
3. Renders the answer as sanitized HTML: all model output is
   HTML-escaped first, then citation markers like `[1]` are turned into
   clickable links to the source catalogue page, so the widget is safe
   against prompt-injected or adversarial model output.
4. Renders friendly, specific messages for the error cases the API can
   return: invalid/missing API key (401), rate limited (429), unknown
   catalogue (404), invalid request (400), and a generic "service
   unavailable, try again" message for 5xx/network failures.

## Local development

```bash
npm run widget:typecheck   # type-check the widget in isolation
npm run widget:build       # bundle web/widget/src -> web/widget/dist/widget.js
npm run widget:dev         # bundle in watch mode
```

`web/widget/demo.html` is a local test page that loads
`dist/widget.js` against a locally running API
(`npm run dev` from the repo root, listening on `http://localhost:3000`).
To try it end-to-end:

```bash
npm run dev              # in one terminal, from the repo root
npm run widget:build      # in another terminal
open web/widget/demo.html # or serve the folder and open it in a browser
```

The demo page's `data-api-key` matches the server's default
`API_KEYS` value (`dev-local-key-change-me`) so it works out of the
box against a default local `.env`.

## Testing

Widget unit tests cover every pure/logic module (`config.ts`,
`api-client.ts`, `format.ts`, `state.ts`) with fakes for `fetch`, the
same dependency-injection pattern used throughout the rest of the
codebase. The DOM-composition modules (`ui.ts`, `widget.ts`) are
intentionally not unit tested, the same convention applied to CLI
scripts elsewhere in the repo: they are thin glue over already-tested
logic, and testing them would require a DOM emulation dependency
(`jsdom`/`happy-dom`) purely to re-verify wiring. They are instead
verified manually via `demo.html`.

```bash
npx vitest run web/widget   # widget test suite only
npx vitest run              # full repo test suite (server + widget)
```

## Security

**Known limitation:** this widget is built for Phase 7's "single
shared-secret tier" auth model. The `data-api-key` value is embedded
directly in public, client-visible HTML/JS: anyone who views page
source or inspects network requests can read and reuse it. This is
acceptable for an MVP behind a single shared key with server-side rate
limiting, but it means the key cannot be treated as a secret once the
widget is deployed on a public page, and a key rotation is needed if
it is ever scraped and abused.

For a production rollout beyond MVP, the recommended follow-up is
one of:

- **Backend-for-frontend (BFF) proxy**: the widget calls a
  same-origin (or Publitas-owned) endpoint that holds the real API
  key server-side and forwards the request, so no secret reaches the
  browser at all.
- **Short-lived public tokens**: the API issues narrowly-scoped,
  time-limited tokens (e.g. valid for one catalogue, expiring in
  minutes) that a page can safely embed, instead of the long-lived
  shared key.

Neither is implemented yet; this README documents the gap so it is an
explicit, tracked decision rather than an oversight.

## Bundle

The build (`npm run widget:build`) produces a single IIFE bundle at
`web/widget/dist/widget.js` (no ES module requirement on the host
page, so a plain `<script src="...">` works with or without `async`/
`defer`). It is minified and has no runtime dependencies: `zod` is
deliberately not used in the widget (unlike the server) to keep the
bundle small, in favor of hand-rolled sequential validation in
`config.ts`.
