import { describe, expect, it } from 'vitest';
import {
  appendUserMessage,
  createInitialState,
  resolveWithAnswer,
  resolveWithError,
} from '../src/state.js';
import type { ChatResponseBody } from '../src/types.js';

describe('createInitialState', () => {
  it('seeds the message list with a single greeting message', () => {
    const state = createInitialState('Hello!');
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ role: 'assistant', text: 'Hello!' });
    expect(state.isSending).toBe(false);
  });
});

describe('appendUserMessage', () => {
  it('appends the user message and a trailing pending placeholder', () => {
    const state = appendUserMessage(createInitialState('Hi'), 'How much is the pan?');
    expect(state.messages).toHaveLength(3);
    expect(state.messages[1]).toMatchObject({ role: 'user', text: 'How much is the pan?' });
    expect(state.messages[2]).toMatchObject({ role: 'pending' });
  });

  it('marks the state as sending', () => {
    const state = appendUserMessage(createInitialState('Hi'), 'q');
    expect(state.isSending).toBe(true);
  });

  it('does not mutate the input state', () => {
    const initial = createInitialState('Hi');
    const originalLength = initial.messages.length;
    appendUserMessage(initial, 'q');
    expect(initial.messages).toHaveLength(originalLength);
    expect(initial.isSending).toBe(false);
  });

  it('assigns each message a unique, stable id', () => {
    const state = appendUserMessage(createInitialState('Hi'), 'q');
    const ids = state.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('resolveWithAnswer', () => {
  const response: ChatResponseBody = {
    answer: 'The pan costs $49.99 [1].',
    citations: [
      { index: 1, chunkId: 1, publicUrl: 'https://view.publitas.com/x/y/page/4', pageNumber: 4, productRef: null },
    ],
    noContextFound: false,
  };

  it('replaces the trailing pending placeholder with the assistant answer', () => {
    const pendingState = appendUserMessage(createInitialState('Hi'), 'How much is the pan?');
    const state = resolveWithAnswer(pendingState, response);

    expect(state.messages).toHaveLength(3);
    expect(state.messages[2]).toMatchObject({
      role: 'assistant',
      text: response.answer,
      citations: response.citations,
      noContextFound: false,
    });
  });

  it('clears isSending', () => {
    const pendingState = appendUserMessage(createInitialState('Hi'), 'q');
    const state = resolveWithAnswer(pendingState, response);
    expect(state.isSending).toBe(false);
  });

  it('preserves every message before the pending placeholder', () => {
    const pendingState = appendUserMessage(createInitialState('Hi'), 'How much is the pan?');
    const state = resolveWithAnswer(pendingState, response);
    expect(state.messages[0]).toMatchObject({ role: 'assistant', text: 'Hi' });
    expect(state.messages[1]).toMatchObject({ role: 'user', text: 'How much is the pan?' });
  });

  it('carries noContextFound through when true', () => {
    const pendingState = appendUserMessage(createInitialState('Hi'), 'q');
    const state = resolveWithAnswer(pendingState, { ...response, noContextFound: true });
    expect(state.messages[2]).toMatchObject({ noContextFound: true });
  });
});

describe('resolveWithError', () => {
  it('replaces the trailing pending placeholder with an error message', () => {
    const pendingState = appendUserMessage(createInitialState('Hi'), 'q');
    const state = resolveWithError(pendingState, 'Something went wrong.');

    expect(state.messages).toHaveLength(3);
    expect(state.messages[2]).toMatchObject({ role: 'error', text: 'Something went wrong.' });
  });

  it('clears isSending', () => {
    const pendingState = appendUserMessage(createInitialState('Hi'), 'q');
    const state = resolveWithError(pendingState, 'boom');
    expect(state.isSending).toBe(false);
  });
});
