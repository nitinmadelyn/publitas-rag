import { describe, expect, it } from 'vitest';
import { escapeHtml, linkifyCitations, renderAnswerHtml } from '../src/format.js';
import type { Citation } from '../src/types.js';

function citation(overrides: Partial<Citation> = {}): Citation {
  return {
    index: 1,
    chunkId: 1,
    publicUrl: 'https://view.publitas.com/x/y/page/4',
    pageNumber: 4,
    productRef: null,
    ...overrides,
  };
}

describe('escapeHtml', () => {
  it('escapes all five reserved HTML characters', () => {
    expect(escapeHtml(`<script>alert("x") & 'y'</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;',
    );
  });

  it('leaves ordinary text unchanged', () => {
    expect(escapeHtml('The pan costs $49.99')).toBe('The pan costs $49.99');
  });

  it('handles an empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('escapes a string that is only reserved characters', () => {
    expect(escapeHtml('<<<>>>')).toBe('&lt;&lt;&lt;&gt;&gt;&gt;');
  });
});

describe('linkifyCitations', () => {
  it('wraps a matching citation marker in a link to its public URL', () => {
    const result = linkifyCitations('The pan costs $49.99 [1].', [citation({ index: 1 })]);
    expect(result).toContain('href="https://view.publitas.com/x/y/page/4"');
    expect(result).toContain('target="_blank"');
    expect(result).toContain('rel="noopener noreferrer"');
    expect(result).toContain('>[1]</a>');
  });

  it('links multiple distinct citation markers independently', () => {
    const citations = [citation({ index: 1, publicUrl: 'https://a.example/1' }), citation({ index: 2, publicUrl: 'https://a.example/2' })];
    const result = linkifyCitations('See [1] and [2].', citations);
    expect(result).toContain('href="https://a.example/1"');
    expect(result).toContain('href="https://a.example/2"');
  });

  it('leaves a marker with no matching citation as plain text', () => {
    const result = linkifyCitations('See [99] only.', [citation({ index: 1 })]);
    expect(result).not.toContain('href');
    expect(result).toContain('[99]');
  });

  it('links a known marker while leaving an unknown one in the same string as plain text', () => {
    const result = linkifyCitations('See [1] and [99].', [citation({ index: 1 })]);
    expect(result).toContain('href="https://view.publitas.com/x/y/page/4"');
    expect(result).toContain('>[1]</a>');
    expect(result).toContain('and [99].');
  });

  it('leaves text with no citation markers unchanged', () => {
    expect(linkifyCitations('No citations here.', [citation()])).toBe('No citations here.');
  });

  it('returns the input unchanged when there are no citations at all', () => {
    expect(linkifyCitations('See [1].', [])).toBe('See [1].');
  });

  it('escapes the citation URL itself to prevent attribute injection', () => {
    const malicious = citation({ publicUrl: 'https://x.com/"><script>alert(1)</script>' });
    const result = linkifyCitations('[1]', [malicious]);
    expect(result).not.toContain('<script>alert(1)</script>');
  });
});

describe('renderAnswerHtml', () => {
  it('escapes the answer text and then links citations in one call', () => {
    const result = renderAnswerHtml('<b>The pan</b> costs $49.99 [1].', [citation({ index: 1 })]);
    expect(result).toContain('&lt;b&gt;The pan&lt;/b&gt;');
    expect(result).toContain('href="https://view.publitas.com/x/y/page/4"');
  });

  it('never leaves raw HTML from the answer text unescaped', () => {
    const result = renderAnswerHtml('<img src=x onerror=alert(1)>', []);
    expect(result).not.toContain('<img');
  });
});
