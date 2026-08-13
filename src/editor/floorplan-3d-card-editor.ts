/**
 * The visual configuration editor Lovelace opens for this card.
 *
 * Design notes:
 * - Sections are plain render functions, not custom elements, so the editor
 *   registers exactly one tag and keeps all mutable state in one place.
 * - Nothing is imported from `@/card` or `@/ui`: the editor must keep working
 *   even while the card UI is being rewritten.
 * - Every HA form element is feature-detected (see `editor-styles.ts`), so the
 *   editor is fully usable in a dev harness where none of them exist.
 */

import { LitElement, css, html, unsafeCSS } from 'lit';
import type { CSSResultGroup, TemplateResult } from 'lit';
import { state } from 'lit/decorators.js';

import { CARD_TYPE, EDITOR_TAG, type Floorplan3dCardConfig } from '@/types/config';
import type { HomeAssistant, LovelaceCardEditor } from '@/types/hass';
import { debounce, fireEvent } from '@/util/events';
import { migrateConfig, normalizeConfig, validateConfig } from '@/ha/config-schema';
import { listEntitiesByDomain, searchEntities } from '@/ha/registry';
import { localize } from '@/ha/localize';

import {
  MDI,
  alertBox,
  editorStyles,
  textButton,
  type EditorContext,
  type EditorUiState,
  type EntityOption,
} from '@/editor/editor-styles';
import { renderYamlPreview, toYaml, yamlPreviewCss } from '@/editor/yaml-preview';
import { renderModelSection } from '@/editor/sections/model-section';
import { renderAppearanceSection } from '@/editor/sections/appearance-section';
import { renderPresetsSection } from '@/editor/sections/presets-section';
import { renderEntitiesSection } from '@/editor/sections/entities-section';
import { renderAdvancedSection } from '@/editor/sections/advanced-section';

/* ------------------------------------------------------------- ha adapters */

/**
 * The `@/ha/*` modules are written by another part of the codebase and their
 * exact signatures are allowed to evolve. The editor only needs a yes/no answer
 * and a list of entity ids, so it adapts at runtime instead of coupling to a
 * specific return shape — a mismatch degrades the editor, it never breaks it.
 */
type LooseFn = (...args: unknown[]) => unknown;

interface ValidationOutcome {
  ok: boolean;
  errors: string[];
}

function messagesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') {
      const rec = item as { message?: unknown; path?: unknown };
      const path = typeof rec.path === 'string' && rec.path ? `${rec.path}: ` : '';
      if (typeof rec.message === 'string') return `${path}${rec.message}`;
    }
    return String(item);
  });
}

function checkConfig(config: Floorplan3dCardConfig): ValidationOutcome {
  try {
    const result = (validateConfig as unknown as LooseFn)(config);
    if (result === undefined || result === null) return { ok: true, errors: [] };
    if (typeof result === 'boolean') return { ok: result, errors: [] };
    if (typeof result === 'object') {
      const rec = result as { ok?: unknown; valid?: unknown; errors?: unknown };
      const errors = messagesOf(rec.errors);
      if (typeof rec.ok === 'boolean') return { ok: rec.ok, errors };
      if (typeof rec.valid === 'boolean') return { ok: rec.valid, errors };
      return { ok: errors.length === 0, errors };
    }
    return { ok: true, errors: [] };
  } catch (err) {
    // A throwing validator is a perfectly reasonable contract too.
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
}

function applySchemaFn(fn: unknown, config: unknown): unknown {
  try {
    const out = (fn as LooseFn)(config);
    return out && typeof out === 'object' ? out : config;
  } catch {
    return config;
  }
}

/** Removes `undefined` values so cleared fields disappear from the YAML. */
function prune<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => prune(item)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      out[key] = prune(item);
    }
    return out as T;
  }
  return value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/* -------------------------------------------------------------------- tabs */

type TabId = 'model' | 'appearance' | 'presets' | 'entities' | 'advanced';

const TABS: Array<{ id: TabId; key: string; label: string }> = [
  { id: 'model', key: 'editor.tab_model', label: 'Model' },
  { id: 'appearance', key: 'editor.tab_appearance', label: 'Appearance' },
  { id: 'presets', key: 'editor.tab_presets', label: 'Presets' },
  { id: 'entities', key: 'editor.tab_entities', label: 'Entities' },
  { id: 'advanced', key: 'editor.tab_advanced', label: 'Advanced' },
];

/* ------------------------------------------------------------------ editor */

export class Floorplan3dCardEditor extends LitElement implements LovelaceCardEditor {
  @state() private _config: Floorplan3dCardConfig = { type: CARD_TYPE };
  @state() private _tab: TabId = 'model';
  @state() private _showYaml = false;
  @state() private _errors: string[] = [];
  @state() private _toast: string | null = null;
  @state() private _revision = 0;

  private _hass?: HomeAssistant;
  private _ui: EditorUiState = { expanded: new Set<string>() };
  private _pending: Floorplan3dCardConfig | null = null;
  private _toastTimer: ReturnType<typeof setTimeout> | null = null;

  /** Debounced for typing and slider drags; toggles/selects flush immediately. */
  private _scheduleFlush = debounce(() => this._flush(), 250);

  set hass(hass: HomeAssistant | undefined) {
    this._hass = hass;
    this.requestUpdate('hass');
  }

  get hass(): HomeAssistant | undefined {
    return this._hass;
  }

  /** Lovelace hands us the raw YAML object; migrate + normalise before use. */
  setConfig(config: unknown): void {
    const source = config && typeof config === 'object' ? config : { type: CARD_TYPE };
    const migrated = applySchemaFn(migrateConfig, clone(source));
    const normalised = applySchemaFn(normalizeConfig, migrated) as Floorplan3dCardConfig;
    this._config = prune({ ...normalised, type: normalised.type || CARD_TYPE });
    this._errors = [];
    this._pending = null;
  }

  override disconnectedCallback(): void {
    // Do not silently drop an in-flight edit when the dialog closes.
    this._scheduleFlush.cancel();
    this._flush();
    if (this._toastTimer) clearTimeout(this._toastTimer);
    super.disconnectedCallback();
  }

  private _flush(): void {
    const config = this._pending;
    this._pending = null;
    if (!config) return;
    fireEvent(this, 'config-changed', { config });
  }

  private _update(patch: Partial<Floorplan3dCardConfig>, immediate = false): void {
    const next = prune({ ...this._config, ...patch }) as Floorplan3dCardConfig;
    this._config = next;

    const outcome = checkConfig(next);
    this._errors = outcome.errors;
    if (!outcome.ok) {
      // Keep the typed value on screen, but never hand Lovelace a broken config.
      this._pending = null;
      this._scheduleFlush.cancel();
      return;
    }

    this._pending = next;
    if (immediate) {
      this._scheduleFlush.cancel();
      this._flush();
    } else {
      this._scheduleFlush();
    }
  }

  private _notify(message: string): void {
    this._toast = message;
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this._toast = null;
      this._toastTimer = null;
    }, 2600);
  }

  private _t = (key: string, fallback: string): string => {
    try {
      const out = (localize as unknown as LooseFn)(key, fallback, this._hass);
      if (typeof out === 'string' && out.length > 0 && out !== key) return out;
    } catch {
      /* localisation is best-effort */
    }
    return fallback;
  };

  private _entityOptions = (options?: {
    domain?: string;
    query?: string;
    limit?: number;
  }): EntityOption[] => {
    const hass = this._hass;
    if (!hass) return [];
    const limit = options?.limit ?? 200;
    let raw: unknown;
    try {
      if (options?.query) {
        raw = (searchEntities as unknown as LooseFn)(hass, options.query, limit);
      } else if (options?.domain) {
        raw = (listEntitiesByDomain as unknown as LooseFn)(hass, options.domain);
      }
    } catch {
      raw = undefined;
    }
    const ids = this._entityIds(raw, options?.domain);
    return ids.slice(0, limit).map((entityId) => ({
      entityId,
      name: hass.states[entityId]?.attributes.friendly_name ?? entityId,
    }));
  };

  private _entityIds(raw: unknown, domain?: string): string[] {
    if (Array.isArray(raw)) {
      const ids: string[] = [];
      for (const item of raw) {
        if (typeof item === 'string') ids.push(item);
        else if (item && typeof item === 'object') {
          const rec = item as { entity_id?: unknown; entityId?: unknown };
          const id = rec.entity_id ?? rec.entityId;
          if (typeof id === 'string') ids.push(id);
        }
      }
      if (ids.length) return ids;
    }
    const all = this._hass ? Object.keys(this._hass.states) : [];
    const filtered = domain ? all.filter((id) => id.startsWith(`${domain}.`)) : all;
    return filtered.sort();
  }

  private get _ctx(): EditorContext {
    return {
      config: this._config,
      hass: this._hass,
      update: (patch, immediate) => this._update(patch, immediate),
      t: this._t,
      entities: this._entityOptions,
      ui: this._ui,
      refresh: () => {
        this._revision += 1;
      },
      notify: (message) => this._notify(message),
    };
  }

  private _onTabKeydown(ev: KeyboardEvent): void {
    const index = TABS.findIndex((tab) => tab.id === this._tab);
    let next = index;
    switch (ev.key) {
      case 'ArrowRight':
        next = (index + 1) % TABS.length;
        break;
      case 'ArrowLeft':
        next = (index - 1 + TABS.length) % TABS.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = TABS.length - 1;
        break;
      default:
        return;
    }
    ev.preventDefault();
    this._tab = TABS[next].id;
    void this.updateComplete.then(() => {
      const el = this.renderRoot.querySelector<HTMLButtonElement>(`#tab-${this._tab}`);
      el?.focus();
    });
  }

  private _renderTab(): TemplateResult {
    const ctx = this._ctx;
    switch (this._tab) {
      case 'appearance':
        return renderAppearanceSection(ctx);
      case 'presets':
        return renderPresetsSection(ctx);
      case 'entities':
        return renderEntitiesSection(ctx);
      case 'advanced':
        return renderAdvancedSection(ctx);
      case 'model':
      default:
        return renderModelSection(ctx);
    }
  }

  private async _copyYaml(yaml: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(yaml);
      this._notify(this._t('editor.copied', 'Configuration copied to the clipboard'));
    } catch {
      this._notify(this._t('editor.copy_failed', 'Could not access the clipboard'));
    }
  }

  protected override render(): TemplateResult {
    // `_revision` only exists to make `ctx.refresh()` re-render expansion state.
    const revision = this._revision;
    return html`
      <div class="editor" data-revision=${revision}>
        <div class="toolbar">
          <div
            class="tabs"
            role="tablist"
            aria-label=${this._t('editor.tabs', 'Card settings')}
            @keydown=${this._onTabKeydown}
          >
            ${TABS.map(
              (tab) => html`<button
                type="button"
                class="tab"
                id="tab-${tab.id}"
                role="tab"
                aria-selected=${tab.id === this._tab ? 'true' : 'false'}
                aria-controls="panel"
                tabindex=${tab.id === this._tab ? '0' : '-1'}
                @click=${() => {
                  this._tab = tab.id;
                }}
              >
                ${this._t(tab.key, tab.label)}
              </button>`,
            )}
          </div>
          ${textButton({
            label: this._showYaml
              ? this._t('editor.hide_yaml', 'Hide YAML')
              : this._t('editor.show_yaml', 'Show YAML'),
            path: MDI.copy,
            onClick: () => {
              this._showYaml = !this._showYaml;
            },
          })}
        </div>

        ${this._errors.length
          ? alertBox(
              'error',
              html`<strong>${this._t('editor.invalid', 'Not saved — fix these first:')}</strong>
                <ul>
                  ${this._errors.map((message) => html`<li>${message}</li>`)}
                </ul>`,
            )
          : ''}

        <div id="panel" role="tabpanel" aria-labelledby="tab-${this._tab}" class="tab-panel">
          ${this._renderTab()}
        </div>

        ${this._showYaml
          ? renderYamlPreview({
              yaml: toYaml(this._config),
              onCopy: (yaml) => void this._copyYaml(yaml),
              copyLabel: this._t('editor.copy_yaml', 'Copy YAML to clipboard'),
            })
          : ''}
        ${this._toast ? html`<div class="toast" role="status">${this._toast}</div>` : ''}
      </div>
    `;
  }

  static override get styles(): CSSResultGroup {
    return [
      editorStyles,
      css`
        ${unsafeCSS(yamlPreviewCss)}
      `,
      css`
        .editor {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .tab-panel {
          min-height: 120px;
        }

        .toast {
          position: sticky;
          bottom: 0;
          align-self: center;
          margin-top: 8px;
          padding: 8px 14px;
          border-radius: 18px;
          background: var(--primary-text-color, #212121);
          color: var(--card-background-color, #fff);
          font-size: 13px;
        }

        ul {
          margin: 4px 0 0;
          padding-left: 20px;
        }
      `,
    ];
  }
}

// Guarded: a dashboard can end up loading the bundle twice (HACS + a stale
// resource entry), and a second `define()` of the same tag throws.
if (!customElements.get(EDITOR_TAG)) {
  customElements.define(EDITOR_TAG, Floorplan3dCardEditor);
}

declare global {
  interface HTMLElementTagNameMap {
    'floorplan-3d-card-editor': Floorplan3dCardEditor;
  }
}
