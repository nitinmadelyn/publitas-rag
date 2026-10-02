import type { WidgetConfig } from './config.js';
import {
  ApiAuthError,
  ApiCatalogNotFoundError,
  ApiRateLimitedError,
  ApiUnavailableError,
  ApiValidationError,
  ChatApiClient,
} from './api-client.js';
import { renderAnswerHtml } from './format.js';
import {
  appendUserMessage,
  createInitialState,
  resolveWithAnswer,
  resolveWithError,
  type ChatMessage,
  type ChatState,
} from './state.js';

// Publitas brand accent. Kept as named constants (rather than inlined
// hex codes scattered through the template below) so a future rebrand
// is a one-line change here instead of a find-and-replace across the
// stylesheet.
const BRAND_COLOR = '#2baee4';
const BRAND_COLOR_HOVER = '#1f96c4';

// How long the teaser bubble waits after mount before it appears, giving
// the host page a moment to settle rather than popping in immediately on
// load. Purely a UX choice, not tied to any network call.
const TEASER_DELAY_MS = 1500;

const WIDGET_STYLES = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.prag-bubble {
  position: fixed; bottom: 20px; right: 20px; width: 56px; height: 56px;
  border-radius: 50%; background: ${BRAND_COLOR}; color: #fff; border: none;
  cursor: pointer; font-size: 24px; box-shadow: 0 2px 10px rgba(0,0,0,0.25);
  z-index: 2147483000;
}
.prag-bubble:hover { background: ${BRAND_COLOR_HOVER}; }
.prag-teaser {
  position: fixed; bottom: 86px; right: 20px; max-width: 220px;
  background: #fff; color: #1a1a1a; padding: 10px 14px; border-radius: 12px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.2); font-size: 13px; line-height: 1.4;
  z-index: 2147483000; display: flex; align-items: flex-start; gap: 8px;
  cursor: pointer; border: 1px solid #e5e5e5; animation: prag-teaser-in 0.2s ease-out;
}
.prag-teaser[hidden] { display: none; }
.prag-teaser-text { flex: 1; }
.prag-teaser-close {
  background: none; border: none; color: #9a9aa5; cursor: pointer; font-size: 13px;
  line-height: 1; padding: 2px; flex-shrink: 0;
}
.prag-teaser-close:hover { color: #4a4a55; }
@keyframes prag-teaser-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
.prag-panel {
  position: fixed; bottom: 88px; right: 20px; width: 340px; max-width: calc(100vw - 40px);
  height: 460px; max-height: calc(100vh - 120px); background: #fff; border-radius: 12px;
  box-shadow: 0 8px 30px rgba(0,0,0,0.2); display: flex; flex-direction: column;
  overflow: hidden; z-index: 2147483000;
}
.prag-panel[hidden] { display: none; }
.prag-header {
  background: ${BRAND_COLOR}; color: #fff; padding: 14px 16px; font-size: 15px; font-weight: 600;
  display: flex; justify-content: space-between; align-items: center;
}
.prag-close { background: none; border: none; color: #fff; font-size: 18px; cursor: pointer; line-height: 1; }
.prag-messages { flex: 1; overflow-y: auto; padding: 12px; font-size: 14px; line-height: 1.4; }
.prag-msg { margin-bottom: 10px; max-width: 88%; padding: 8px 12px; border-radius: 10px; word-wrap: break-word; }
.prag-msg-user { margin-left: auto; background: ${BRAND_COLOR}; color: #fff; }
.prag-msg-assistant { background: #f0f1f5; color: #1a1a1a; }
.prag-msg-error { background: #fde8e8; color: #8a1f1f; }
.prag-msg-pending { background: #f0f1f5; color: #8a8a8a; font-style: italic; }
.prag-citation { color: inherit; text-decoration: underline; font-weight: 600; }
.prag-noncontext { display: block; margin-top: 6px; font-size: 12px; color: #8a8a8a; }
.prag-inputrow { display: flex; border-top: 1px solid #e5e5e5; padding: 8px; gap: 8px; }
.prag-input {
  flex: 1; border: 1px solid #d5d5d5; border-radius: 8px; padding: 8px 10px; font-size: 14px;
  resize: none; max-height: 80px;
}
.prag-input:disabled { background: #f5f5f5; }
.prag-send {
  background: ${BRAND_COLOR}; color: #fff; border: none; border-radius: 8px; padding: 0 14px;
  cursor: pointer; font-size: 14px;
}
.prag-send:hover:not(:disabled) { background: ${BRAND_COLOR_HOVER}; }
.prag-send:disabled { background: #b5b5c0; cursor: not-allowed; }
`;

/**
 * Renders the DOM/shadow-root layer and wires it to the pure state
 * reducer and the API client. Not unit tested directly - like the CLI
 * entrypoints on the server side, this is the composition root that
 * touches the real DOM; the logic it calls (config parsing, the state
 * reducer, HTML escaping/citation linking, API error mapping) is all
 * covered by unit tests in files that never touch document/window.
 */
export function mountWidget(config: WidgetConfig, host: HTMLElement): void {
  const shadow = host.attachShadow({ mode: 'open' });

  const styleEl = document.createElement('style');
  styleEl.textContent = WIDGET_STYLES;
  shadow.appendChild(styleEl);

  const bubble = document.createElement('button');
  bubble.className = 'prag-bubble';
  bubble.setAttribute('aria-label', config.title);
  bubble.textContent = '\u{1F4AC}';

  // Teaser: a small speech-bubble prompt shown next to the launcher
  // before the visitor has opened the chat, to draw the eye and give a
  // concrete reason to click ("ask me about X") rather than relying on
  // the bare chat-bubble icon alone. It is not part of the panel/message
  // flow (state.ts), since it never talks to the API and disappears
  // permanently the moment the visitor engages with it in any way.
  const teaser = document.createElement('div');
  teaser.className = 'prag-teaser';
  teaser.hidden = true;
  teaser.setAttribute('role', 'status');
  const teaserText = document.createElement('span');
  teaserText.className = 'prag-teaser-text';
  teaserText.textContent = config.bubbleText;
  const teaserClose = document.createElement('button');
  teaserClose.className = 'prag-teaser-close';
  teaserClose.setAttribute('aria-label', 'Dismiss');
  teaserClose.textContent = '✕';
  teaser.append(teaserText, teaserClose);

  const panel = document.createElement('div');
  panel.className = 'prag-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', config.title);

  const header = document.createElement('div');
  header.className = 'prag-header';
  const headerTitle = document.createElement('span');
  headerTitle.textContent = config.title;
  const closeButton = document.createElement('button');
  closeButton.className = 'prag-close';
  closeButton.setAttribute('aria-label', 'Close chat');
  closeButton.textContent = '✕';
  header.append(headerTitle, closeButton);

  const messagesEl = document.createElement('div');
  messagesEl.className = 'prag-messages';
  messagesEl.setAttribute('role', 'log');
  messagesEl.setAttribute('aria-live', 'polite');

  const inputRow = document.createElement('div');
  inputRow.className = 'prag-inputrow';
  const input = document.createElement('textarea');
  input.className = 'prag-input';
  input.placeholder = config.placeholder;
  input.rows = 1;
  const sendButton = document.createElement('button');
  sendButton.className = 'prag-send';
  sendButton.textContent = 'Send';
  inputRow.append(input, sendButton);

  panel.append(header, messagesEl, inputRow);
  shadow.append(teaser, bubble, panel);

  const apiClient = new ChatApiClient();
  let state: ChatState = createInitialState(config.greeting);
  renderMessages(messagesEl, state.messages);

  let teaserTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    teaserTimer = undefined;
    if (panel.hidden) teaser.hidden = false;
  }, TEASER_DELAY_MS);

  function dismissTeaser(): void {
    if (teaserTimer !== undefined) {
      clearTimeout(teaserTimer);
      teaserTimer = undefined;
    }
    teaser.hidden = true;
  }

  function openPanel(): void {
    dismissTeaser();
    panel.hidden = false;
    input.focus();
  }

  bubble.addEventListener('click', () => {
    if (panel.hidden) {
      openPanel();
    } else {
      panel.hidden = true;
    }
  });
  closeButton.addEventListener('click', () => {
    panel.hidden = true;
  });

  // Clicking the teaser itself is a shortcut into the chat, same as
  // clicking the bubble. The close button stops propagation so
  // dismissing the teaser never also opens the panel.
  teaser.addEventListener('click', openPanel);
  teaserClose.addEventListener('click', (event) => {
    event.stopPropagation();
    dismissTeaser();
  });

  function setSendingUi(isSending: boolean): void {
    input.disabled = isSending;
    sendButton.disabled = isSending;
  }

  function submitQuery(): void {
    const text = input.value.trim();
    if (!text || state.isSending) return;

    input.value = '';
    state = appendUserMessage(state, text);
    renderMessages(messagesEl, state.messages);
    setSendingUi(true);

    apiClient
      .sendMessage(config, text)
      .then((response) => {
        state = resolveWithAnswer(state, response);
        renderMessages(messagesEl, state.messages);
        setSendingUi(false);
      })
      .catch((err: unknown) => {
        // The UI only ever shows describeError()'s friendly message, but
        // the underlying error (a real network failure, an unexpected
        // exception in the fetch call, etc.) still belongs in the
        // console: swallowing it entirely turns every failure mode into
        // an indistinguishable "could not reach the chat service" with
        // no way for a developer to diagnose it from DevTools.
        console.error('[publitas-rag-widget] chat request failed', err);
        state = resolveWithError(state, describeError(err));
        renderMessages(messagesEl, state.messages);
        setSendingUi(false);
      });
  }

  sendButton.addEventListener('click', submitQuery);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitQuery();
    }
  });
}

function describeError(err: unknown): string {
  if (err instanceof ApiAuthError) return err.message;
  if (err instanceof ApiRateLimitedError) return err.message;
  if (err instanceof ApiCatalogNotFoundError) return err.message;
  if (err instanceof ApiValidationError) return err.message;
  if (err instanceof ApiUnavailableError) return err.message;
  if (err instanceof Error) return 'Something went wrong. Please try again.';
  return 'Something went wrong. Please try again.';
}

function renderMessages(container: HTMLElement, messages: readonly ChatMessage[]): void {
  container.innerHTML = '';
  for (const message of messages) {
    container.appendChild(renderMessage(message));
  }
  container.scrollTop = container.scrollHeight;
}

function renderMessage(message: ChatMessage): HTMLElement {
  const el = document.createElement('div');

  if (message.role === 'user') {
    el.className = 'prag-msg prag-msg-user';
    el.textContent = message.text;
    return el;
  }

  if (message.role === 'pending') {
    el.className = 'prag-msg prag-msg-pending';
    el.textContent = 'Thinking...';
    return el;
  }

  if (message.role === 'error') {
    el.className = 'prag-msg prag-msg-error';
    el.textContent = message.text;
    return el;
  }

  el.className = 'prag-msg prag-msg-assistant';
  el.innerHTML = renderAnswerHtml(message.text, message.citations);
  if (message.noContextFound) {
    const note = document.createElement('span');
    note.className = 'prag-noncontext';
    note.textContent = "This catalog doesn't have that information.";
    el.appendChild(note);
  }
  return el;
}
