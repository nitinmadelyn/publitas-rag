import { parseWidgetConfig, WidgetConfigError, type RawWidgetDataset } from './config.js';
import { mountWidget } from './ui.js';

/**
 * Composition root: read the embedding <script> tag's data-* attributes,
 * validate them, and mount the chat UI. This file is the only place that
 * touches document.currentScript - everything it calls (parseWidgetConfig,
 * mountWidget's dependencies) is DOM-free and independently unit tested.
 *
 * document.currentScript is captured synchronously at the top of this
 * module's own execution, which is the one point browsers guarantee it
 * reliably points at this <script> element - including when the tag
 * carries `async` or `defer`, as a site embedding this is expected to
 * use. Reading it later (inside a promise callback, a timeout, etc.)
 * would return null.
 */
const currentScript = document.currentScript;

function readDataset(script: HTMLOrSVGScriptElement | null): RawWidgetDataset {
  if (!script || !('dataset' in script)) return {};
  const dataset = script.dataset;
  return {
    apiBaseUrl: dataset.apiBaseUrl,
    apiKey: dataset.apiKey,
    catalog: dataset.catalog,
    lang: dataset.lang,
    title: dataset.title,
    placeholder: dataset.placeholder,
    greeting: dataset.greeting,
    bubbleText: dataset.bubbleText,
  };
}

function init(): void {
  let config;
  try {
    config = parseWidgetConfig(readDataset(currentScript));
  } catch (err) {
    // A misconfigured embed must never break the host page. Reporting
    // loudly to the console is exactly what a site owner debugging their
    // own snippet needs, and exactly what an end user should never see.
    if (err instanceof WidgetConfigError) {
      console.error(`[publitas-rag-widget] ${err.message}`);
    } else {
      console.error('[publitas-rag-widget] failed to initialize', err);
    }
    return;
  }

  const host = document.createElement('div');
  host.id = 'publitas-rag-widget-root';
  document.body.appendChild(host);
  mountWidget(config, host);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
