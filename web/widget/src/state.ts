import type { ChatResponseBody, Citation } from './types.js';

export type ChatMessage =
  | { role: 'user'; id: string; text: string }
  | { role: 'assistant'; id: string; text: string; citations: Citation[]; noContextFound: boolean }
  | { role: 'error'; id: string; text: string }
  | { role: 'pending'; id: string };

export interface ChatState {
  messages: ChatMessage[];
  isSending: boolean;
}

/**
 * Every id is derived from the message's position rather than a module-
 * level counter or Date.now(), which keeps every function here a pure
 * function of its inputs - the same starting state and the same call
 * always produce the same result, with nothing to reset between tests
 * and nothing that depends on wall-clock time.
 */
function idAt(index: number): string {
  return `msg-${index}`;
}

export function createInitialState(greeting: string): ChatState {
  return {
    messages: [{ role: 'assistant', id: idAt(0), text: greeting, citations: [], noContextFound: false }],
    isSending: false,
  };
}

/**
 * Appends the user's question and a trailing "pending" placeholder (what
 * the UI renders as a typing indicator) in one state transition, and
 * marks the state as sending so the UI can disable the input/send button
 * until resolveWithAnswer or resolveWithError is called.
 */
export function appendUserMessage(state: ChatState, text: string): ChatState {
  const userMessage: ChatMessage = { role: 'user', id: idAt(state.messages.length), text };
  const pendingMessage: ChatMessage = { role: 'pending', id: idAt(state.messages.length + 1) };
  return {
    messages: [...state.messages, userMessage, pendingMessage],
    isSending: true,
  };
}

/** Replaces the trailing pending placeholder with the real assistant answer. */
export function resolveWithAnswer(state: ChatState, response: ChatResponseBody): ChatState {
  const withoutPending = state.messages.slice(0, -1);
  const assistantMessage: ChatMessage = {
    role: 'assistant',
    id: idAt(withoutPending.length),
    text: response.answer,
    citations: response.citations,
    noContextFound: response.noContextFound,
  };
  return { messages: [...withoutPending, assistantMessage], isSending: false };
}

/** Replaces the trailing pending placeholder with a user-facing error message. */
export function resolveWithError(state: ChatState, errorText: string): ChatState {
  const withoutPending = state.messages.slice(0, -1);
  const errorMessage: ChatMessage = { role: 'error', id: idAt(withoutPending.length), text: errorText };
  return { messages: [...withoutPending, errorMessage], isSending: false };
}
