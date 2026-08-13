/**
 * Shared editor chrome: styles, the context object sections receive, and a set
 * of small form controls.
 *
 * Home Assistant registers `ha-textfield`, `ha-select`, `ha-switch`, … globally
 * from the frontend bundle. They are *not* importable from a custom card, and
 * they are not present at all in a dev harness or on older HA versions. Every
 * control below therefore feature-detects its HA element and falls back to a
 * plain, identically-styled native control. This module deliberately imports
 * nothing from `@/card` or `@/ui` so the editor cannot be broken by the card UI.
 */

import { css, html } from 'lit';
import type { CSSResultGroup, TemplateResult } from 'lit';
import type { Floorplan3dCardConfig } from '@/types/config';
import type { HomeAssistant } from '@/types/hass';

/* --------------------------------------------------------- feature detect */

const detectionCache = new Map<string, boolean>();

/** True when the HA frontend has registered `tag` in this document. */
export function hasHaElement(tag: string): boolean {
  const cached = detectionCache.get(tag);
  if (cached !== undefined) return cached;
  const present =
    typeof customElements !== 'undefined' && customElements.get(tag) !== undefined;
  // Only cache positives: HA may lazily register an element after we first look.
  if (present) detectionCache.set(tag, true);
  return present;
}

/* ------------------------------------------------------------ shared types */

export interface EntityOption {
  entityId: string;
  name: string;
}

/** Transient, non-persisted UI state owned by the editor element. */
export interface EditorUiState {
  /** Keys of open expansion panels / rows. */
  expanded: Set<string>;
}

export function isExpanded(ui: EditorUiState, key: string): boolean {
  return ui.expanded.has(key);
}

export function setExpanded(ui: EditorUiState, key: string, open: boolean): void {
  if (open) ui.expanded.add(key);
  else ui.expanded.delete(key);
}

/**
 * Everything a section render function is allowed to touch. Sections are plain
 * functions rather than custom elements so the editor never registers extra
 * tags and all mutable state lives in one place.
 */
export interface EditorContext {
  readonly config: Floorplan3dCardConfig;
  readonly hass?: HomeAssistant;
  /** Shallow-merge a patch into the working config. */
  update(patch: Partial<Floorplan3dCardConfig>, immediate?: boolean): void;
  /** Localised string with an English fallback. */
  t(key: string, fallback: string): string;
  /** Entity suggestions for the fallback pickers. */
  entities(options?: { domain?: string; query?: string; limit?: number }): EntityOption[];
  ui: EditorUiState;
  /** Re-render after mutating `ui`. */
  refresh(): void;
  notify(message: string): void;
}

/* ------------------------------------------------------------- event utils */

export function stopPropagation(ev: Event): void {
  ev.stopPropagation();
}

interface ValueCarrier {
  value?: unknown;
  checked?: unknown;
}

/** Reads a value from either a native input event or an HA `value-changed`. */
export function readValue(ev: Event): string {
  const detail = (ev as CustomEvent<ValueCarrier | undefined>).detail;
  if (detail && typeof detail === 'object' && 'value' in detail) {
    const v = detail.value;
    return v === undefined || v === null ? '' : String(v);
  }
  const target = ev.target as ValueCarrier | null;
  const v = target?.value;
  return v === undefined || v === null ? '' : String(v);
}

export function readChecked(ev: Event): boolean {
  const target = ev.target as ValueCarrier | null;
  if (target && typeof target.checked === 'boolean') return target.checked;
  const detail = (ev as CustomEvent<ValueCarrier | undefined>).detail;
  if (detail && typeof detail === 'object') {
    if (typeof detail.checked === 'boolean') return detail.checked;
    if (typeof detail.value === 'boolean') return detail.value;
  }
  return false;
}

/** '' / non-numeric -> undefined, so clearing a field removes the key. */
export function parseNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '-' || trimmed === '.') return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

export function fmtNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Number(value.toFixed(digits));
  return String(rounded);
}

/** `a, b , c` -> `['a','b','c']`; empty -> undefined so the key is dropped. */
export function parseList(raw: string): string[] | undefined {
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length ? parts : undefined;
}

export function joinList(list: string[] | undefined): string {
  return list && list.length ? list.join(', ') : '';
}

/* ----------------------------------------------------------------- icons */

export const MDI = {
  add: 'M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z',
  delete:
    'M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z',
  up: 'M7.41,15.41L12,10.83L16.59,15.41L18,14L12,8L6,14L7.41,15.41Z',
  down: 'M7.41,8.59L12,13.17L16.59,8.59L18,10L12,16L6,10L7.41,8.59Z',
  copy: 'M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z',
  restore:
    'M13,3A9,9 0 0,0 4,12H1L4.89,15.89L4.96,16.03L9,12H6A7,7 0 0,1 13,5A7,7 0 0,1 20,12A7,7 0 0,1 13,19C11.07,19 9.32,18.21 8.06,16.94L6.64,18.36C8.27,20 10.5,21 13,21A9,9 0 0,0 22,12A9,9 0 0,0 13,3Z',
  magic:
    'M7.5,5.6L10,7L8.6,4.5L10,2L7.5,3.4L5,2L6.4,4.5L5,7L7.5,5.6M19.5,15.4L17,14L18.4,16.5L17,19L19.5,17.6L22,19L20.6,16.5L22,14L19.5,15.4M22,2L19.5,3.4L17,2L18.4,4.5L17,7L19.5,5.6L22,7L20.6,4.5L22,2M13.34,12.78L15.78,10.34L13.66,8.22L11.22,10.66L13.34,12.78M14.37,7.29L16.71,9.63C17.1,10 17.1,10.65 16.71,11.04L5.04,22.71C4.65,23.1 4,23.1 3.63,22.71L1.29,20.37C0.9,20 0.9,19.35 1.29,18.96L12.96,7.29C13.35,6.9 14,6.9 14.37,7.29Z',
} as const;

export function icon(path: string): TemplateResult {
  return html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d=${path}></path></svg>`;
}

export interface IconButtonSpec {
  path: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}

export function iconButton(spec: IconButtonSpec): TemplateResult {
  return html`<button
    type="button"
    class="icon-button ${spec.danger ? 'danger' : ''}"
    title=${spec.label}
    aria-label=${spec.label}
    ?disabled=${spec.disabled ?? false}
    @click=${spec.onClick}
  >
    ${icon(spec.path)}
  </button>`;
}

export interface TextButtonSpec {
  label: string;
  path?: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}

export function textButton(spec: TextButtonSpec): TemplateResult {
  return html`<button
    type="button"
    class="text-button ${spec.danger ? 'danger' : ''}"
    ?disabled=${spec.disabled ?? false}
    @click=${spec.onClick}
  >
    ${spec.path ? icon(spec.path) : ''}<span>${spec.label}</span>
  </button>`;
}

/* ------------------------------------------------------------- text field */

export interface TextFieldSpec {
  label: string;
  value: string;
  helper?: string;
  placeholder?: string;
  suffix?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}

export function textField(spec: TextFieldSpec): TemplateResult {
  const handler = (ev: Event) => spec.onChange(readValue(ev));
  if (hasHaElement('ha-textfield')) {
    return html`<ha-textfield
      class="field"
      .label=${spec.label}
      .value=${spec.value}
      .placeholder=${spec.placeholder ?? ''}
      .helper=${spec.helper ?? ''}
      .suffix=${spec.suffix ?? ''}
      helperPersistent
      ?disabled=${spec.disabled ?? false}
      @input=${handler}
      @change=${handler}
    ></ha-textfield>`;
  }
  return html`<label class="field fallback">
    <span class="fallback-label">${spec.label}</span>
    <span class="fallback-input">
      <input
        type="text"
        .value=${spec.value}
        placeholder=${spec.placeholder ?? ''}
        ?disabled=${spec.disabled ?? false}
        @input=${handler}
        @change=${handler}
      />
      ${spec.suffix ? html`<span class="unit">${spec.suffix}</span>` : ''}
    </span>
    ${spec.helper ? html`<span class="helper">${spec.helper}</span>` : ''}
  </label>`;
}

/* ----------------------------------------------------------- number field */

export interface NumberFieldSpec {
  label: string;
  value: number | undefined;
  min?: number;
  max?: number;
  step?: number;
  helper?: string;
  placeholder?: string;
  suffix?: string;
  disabled?: boolean;
  onChange: (value: number | undefined) => void;
}

export function numberField(spec: NumberFieldSpec): TemplateResult {
  const handler = (ev: Event) => spec.onChange(parseNumber(readValue(ev)));
  const shown = spec.value === undefined ? '' : String(spec.value);
  if (hasHaElement('ha-textfield')) {
    return html`<ha-textfield
      class="field"
      type="number"
      .label=${spec.label}
      .value=${shown}
      .placeholder=${spec.placeholder ?? ''}
      .helper=${spec.helper ?? ''}
      .suffix=${spec.suffix ?? ''}
      helperPersistent
      min=${spec.min ?? ''}
      max=${spec.max ?? ''}
      step=${spec.step ?? 'any'}
      ?disabled=${spec.disabled ?? false}
      @input=${handler}
      @change=${handler}
    ></ha-textfield>`;
  }
  return html`<label class="field fallback">
    <span class="fallback-label">${spec.label}</span>
    <span class="fallback-input">
      <input
        type="number"
        .value=${shown}
        placeholder=${spec.placeholder ?? ''}
        min=${spec.min ?? ''}
        max=${spec.max ?? ''}
        step=${spec.step ?? 'any'}
        ?disabled=${spec.disabled ?? false}
        @input=${handler}
        @change=${handler}
      />
      ${spec.suffix ? html`<span class="unit">${spec.suffix}</span>` : ''}
    </span>
    ${spec.helper ? html`<span class="helper">${spec.helper}</span>` : ''}
  </label>`;
}

/* ---------------------------------------------------------------- select */

export interface FieldOption {
  value: string;
  label: string;
}

export interface SelectSpec {
  label: string;
  value: string;
  options: FieldOption[];
  helper?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}

export function selectField(spec: SelectSpec): TemplateResult {
  const handler = (ev: Event) => {
    const next = readValue(ev);
    if (next !== spec.value) spec.onChange(next);
  };
  if (hasHaElement('ha-select') && hasHaElement('mwc-list-item')) {
    return html`<ha-select
      class="field"
      .label=${spec.label}
      .value=${spec.value}
      .helper=${spec.helper ?? ''}
      helperPersistent
      naturalMenuWidth
      fixedMenuPosition
      ?disabled=${spec.disabled ?? false}
      @selected=${handler}
      @closed=${stopPropagation}
    >
      ${spec.options.map(
        (o) => html`<mwc-list-item .value=${o.value}>${o.label}</mwc-list-item>`,
      )}
    </ha-select>`;
  }
  return html`<label class="field fallback">
    <span class="fallback-label">${spec.label}</span>
    <span class="fallback-input">
      <select
        .value=${spec.value}
        ?disabled=${spec.disabled ?? false}
        @change=${handler}
      >
        ${spec.options.map(
          (o) =>
            html`<option value=${o.value} ?selected=${o.value === spec.value}>
              ${o.label}
            </option>`,
        )}
      </select>
    </span>
    ${spec.helper ? html`<span class="helper">${spec.helper}</span>` : ''}
  </label>`;
}

/* ---------------------------------------------------------------- switch */

export interface SwitchSpec {
  label: string;
  checked: boolean;
  helper?: string;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}

export function switchRow(spec: SwitchSpec): TemplateResult {
  const handler = (ev: Event) => spec.onChange(readChecked(ev));
  const control = hasHaElement('ha-switch')
    ? html`<ha-switch
        .checked=${spec.checked}
        ?disabled=${spec.disabled ?? false}
        @change=${handler}
      ></ha-switch>`
    : html`<input
        type="checkbox"
        class="fallback-switch"
        .checked=${spec.checked}
        ?disabled=${spec.disabled ?? false}
        @change=${handler}
      />`;
  return html`<label class="switch-row">
    <span class="switch-text">
      <span class="switch-label">${spec.label}</span>
      ${spec.helper ? html`<span class="helper">${spec.helper}</span>` : ''}
    </span>
    ${control}
  </label>`;
}

/* ---------------------------------------------------------------- slider */

export interface SliderSpec {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  digits?: number;
  helper?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}

export function sliderRow(spec: SliderSpec): TemplateResult {
  const handler = (ev: Event) => {
    const n = parseNumber(readValue(ev));
    if (n !== undefined && n !== spec.value) spec.onChange(n);
  };
  const control = hasHaElement('ha-slider')
    ? html`<ha-slider
        labeled
        .min=${spec.min}
        .max=${spec.max}
        .step=${spec.step}
        .value=${spec.value}
        ?disabled=${spec.disabled ?? false}
        @input=${handler}
        @change=${handler}
      ></ha-slider>`
    : html`<input
        type="range"
        class="fallback-range"
        min=${spec.min}
        max=${spec.max}
        step=${spec.step}
        .value=${String(spec.value)}
        ?disabled=${spec.disabled ?? false}
        @input=${handler}
        @change=${handler}
      />`;
  return html`<div class="slider-row">
    <div class="slider-head">
      <span class="switch-label">${spec.label}</span>
      <span class="slider-value">${fmtNumber(spec.value, spec.digits ?? 2)}</span>
    </div>
    ${control}
    ${spec.helper ? html`<span class="helper">${spec.helper}</span>` : ''}
  </div>`;
}

/* ----------------------------------------------------------- icon picker */

export interface IconFieldSpec {
  label: string;
  value: string;
  helper?: string;
  placeholder?: string;
  onChange: (value: string) => void;
}

export function iconField(spec: IconFieldSpec): TemplateResult {
  if (hasHaElement('ha-icon-picker')) {
    return html`<ha-icon-picker
      class="field"
      .label=${spec.label}
      .value=${spec.value}
      .helper=${spec.helper ?? ''}
      @value-changed=${(ev: Event) => spec.onChange(readValue(ev))}
    ></ha-icon-picker>`;
  }
  return textField({
    label: spec.label,
    value: spec.value,
    helper: spec.helper ?? 'Material Design Icons name, e.g. mdi:lightbulb',
    placeholder: spec.placeholder ?? 'mdi:home',
    onChange: spec.onChange,
  });
}

/* --------------------------------------------------------- entity picker */

export interface EntityFieldSpec {
  label: string;
  value: string;
  hass?: HomeAssistant;
  /** Suggestions for the fallback picker (HA's own picker uses `hass`). */
  suggestions?: EntityOption[];
  includeDomains?: string[];
  helper?: string;
  allowEmpty?: boolean;
  onChange: (value: string) => void;
}

let datalistSeq = 0;

export function entityField(spec: EntityFieldSpec): TemplateResult {
  const handler = (ev: Event) => spec.onChange(readValue(ev));
  if (hasHaElement('ha-entity-picker')) {
    return html`<ha-entity-picker
      class="field"
      .hass=${spec.hass}
      .label=${spec.label}
      .value=${spec.value}
      .includeDomains=${spec.includeDomains}
      .helper=${spec.helper ?? ''}
      allow-custom-entity
      @value-changed=${handler}
    ></ha-entity-picker>`;
  }
  datalistSeq += 1;
  const listId = `fp3d-entities-${datalistSeq}`;
  const suggestions = spec.suggestions ?? [];
  return html`<label class="field fallback">
    <span class="fallback-label">${spec.label}</span>
    <span class="fallback-input">
      <input
        type="text"
        list=${listId}
        placeholder="domain.object_id"
        .value=${spec.value}
        @input=${handler}
        @change=${handler}
      />
    </span>
    <datalist id=${listId}>
      ${suggestions.map(
        (s) => html`<option value=${s.entityId}>${s.name}</option>`,
      )}
    </datalist>
    ${spec.helper ? html`<span class="helper">${spec.helper}</span>` : ''}
  </label>`;
}

/* ------------------------------------------------------------------ misc */

export type AlertKind = 'info' | 'warning' | 'error' | 'success';

export function alertBox(kind: AlertKind, content: unknown): TemplateResult {
  if (hasHaElement('ha-alert')) {
    return html`<ha-alert alert-type=${kind}>${content}</ha-alert>`;
  }
  return html`<div class="alert alert-${kind}" role="status">${content}</div>`;
}

export interface PanelSpec {
  header: string;
  secondary?: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  content: unknown;
}

export function expansionPanel(spec: PanelSpec): TemplateResult {
  if (hasHaElement('ha-expansion-panel')) {
    return html`<ha-expansion-panel
      class="panel"
      .header=${spec.header}
      .secondary=${spec.secondary ?? ''}
      .expanded=${spec.open}
      @expanded-changed=${(ev: Event) => {
        const detail = (ev as CustomEvent<{ expanded?: boolean }>).detail;
        spec.onToggle(detail?.expanded ?? !spec.open);
      }}
    >
      ${spec.content}
    </ha-expansion-panel>`;
  }
  return html`<details
    class="panel fallback-panel"
    ?open=${spec.open}
    @toggle=${(ev: Event) => {
      const el = ev.currentTarget as HTMLDetailsElement;
      if (el.open !== spec.open) spec.onToggle(el.open);
    }}
  >
    <summary>
      <span>${spec.header}</span>
      ${spec.secondary ? html`<span class="helper">${spec.secondary}</span>` : ''}
    </summary>
    <div class="panel-body">${spec.content}</div>
  </details>`;
}

export function sectionTitle(title: string, description?: string): TemplateResult {
  return html`<div class="section-title">
    <h3>${title}</h3>
    ${description ? html`<p>${description}</p>` : ''}
  </div>`;
}

export function colorField(spec: TextFieldSpec): TemplateResult {
  const swatch = /^#[0-9a-fA-F]{3,8}$/.test(spec.value) ? spec.value : '#8a8f98';
  return html`<div class="color-field">
    ${textField(spec)}
    <input
      type="color"
      class="swatch"
      aria-label="${spec.label} colour"
      .value=${swatch}
      @input=${(ev: Event) => spec.onChange(readValue(ev))}
    />
  </div>`;
}

/** Three linked numeric inputs for a `[x, y, z]` triple. */
export interface Vec3FieldSpec {
  label: string;
  value: [number, number, number];
  step?: number;
  helper?: string;
  suffix?: string;
  onChange: (value: [number, number, number]) => void;
}

export function vec3Field(spec: Vec3FieldSpec): TemplateResult {
  const axes: Array<{ key: 'X' | 'Y' | 'Z'; index: 0 | 1 | 2 }> = [
    { key: 'X', index: 0 },
    { key: 'Y', index: 1 },
    { key: 'Z', index: 2 },
  ];
  const set = (index: 0 | 1 | 2, raw: number | undefined) => {
    const next: [number, number, number] = [...spec.value];
    next[index] = raw ?? 0;
    spec.onChange(next);
  };
  return html`<div class="vec3-field">
    <span class="switch-label">${spec.label}${spec.suffix ? ` (${spec.suffix})` : ''}</span>
    <div class="vec3-inputs">
      ${axes.map((axis) =>
        numberField({
          label: axis.key,
          value: spec.value[axis.index],
          step: spec.step ?? 0.001,
          onChange: (v) => set(axis.index, v),
        }),
      )}
    </div>
    ${spec.helper ? html`<span class="helper">${spec.helper}</span>` : ''}
  </div>`;
}

/* ---------------------------------------------------------------- styles */

export const editorStyles: CSSResultGroup = css`
  :host {
    display: block;
    color: var(--primary-text-color, #212121);
    font-family: var(--paper-font-body1_-_font-family, inherit);
    font-size: 14px;
  }

  * {
    box-sizing: border-box;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    border-bottom: 1px solid var(--divider-color, #e0e0e0);
    margin-bottom: 12px;
  }

  .tabs {
    display: flex;
    flex: 1 1 auto;
    gap: 2px;
    overflow-x: auto;
    scrollbar-width: thin;
  }

  .tab {
    appearance: none;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--secondary-text-color, #727272);
    cursor: pointer;
    font: inherit;
    font-weight: 500;
    padding: 10px 12px;
    white-space: nowrap;
    transition: color 0.15s ease, border-color 0.15s ease;
  }

  .tab[aria-selected='true'] {
    color: var(--primary-color, #03a9f4);
    border-bottom-color: var(--primary-color, #03a9f4);
  }

  .tab:hover {
    color: var(--primary-text-color, #212121);
  }

  .tab:focus-visible,
  .icon-button:focus-visible,
  .text-button:focus-visible,
  input:focus-visible,
  select:focus-visible,
  summary:focus-visible {
    outline: 2px solid var(--primary-color, #03a9f4);
    outline-offset: 2px;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding-bottom: 8px;
  }

  .section-title h3 {
    margin: 4px 0 2px;
    font-size: 15px;
    font-weight: 600;
  }

  .section-title p,
  .helper {
    margin: 0;
    color: var(--secondary-text-color, #727272);
    font-size: 12px;
    line-height: 1.4;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
  }

  .grid.two {
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }

  .field {
    display: block;
    width: 100%;
  }

  ha-textfield.field,
  ha-select.field,
  ha-icon-picker.field,
  ha-entity-picker.field {
    width: 100%;
  }

  /* ---- native fallbacks, styled to sit next to HA's own controls ---- */

  .fallback {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .fallback-label {
    color: var(--secondary-text-color, #727272);
    font-size: 12px;
  }

  .fallback-input {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .fallback input[type='text'],
  .fallback input[type='number'],
  .fallback select {
    width: 100%;
    min-width: 0;
    padding: 8px 10px;
    border: 1px solid var(--divider-color, #e0e0e0);
    border-radius: 6px;
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color, #212121);
    font: inherit;
  }

  .unit {
    color: var(--secondary-text-color, #727272);
    font-size: 12px;
  }

  .fallback-switch {
    width: 40px;
    height: 20px;
    accent-color: var(--primary-color, #03a9f4);
  }

  .fallback-range,
  ha-slider {
    width: 100%;
  }

  .fallback-range {
    accent-color: var(--primary-color, #03a9f4);
  }

  .switch-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 40px;
    cursor: pointer;
  }

  .switch-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .switch-label {
    font-size: 14px;
  }

  .slider-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .slider-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }

  .slider-value {
    color: var(--secondary-text-color, #727272);
    font-variant-numeric: tabular-nums;
    font-size: 12px;
  }

  .vec3-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .vec3-inputs {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }

  .color-field {
    display: flex;
    align-items: flex-end;
    gap: 8px;
  }

  .color-field .field {
    flex: 1 1 auto;
  }

  .swatch {
    flex: 0 0 auto;
    width: 40px;
    height: 40px;
    padding: 2px;
    border: 1px solid var(--divider-color, #e0e0e0);
    border-radius: 6px;
    background: none;
    cursor: pointer;
  }

  /* ------------------------------- buttons ------------------------------- */

  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    flex: 0 0 auto;
    border: none;
    border-radius: 50%;
    background: none;
    color: var(--secondary-text-color, #727272);
    cursor: pointer;
    transition: background-color 0.15s ease, color 0.15s ease;
  }

  .icon-button:hover:not([disabled]) {
    background: var(--secondary-background-color, rgba(0, 0, 0, 0.06));
    color: var(--primary-text-color, #212121);
  }

  .icon-button[disabled] {
    opacity: 0.35;
    cursor: default;
  }

  .icon-button.danger:hover:not([disabled]) {
    color: var(--error-color, #db4437);
  }

  .icon-button svg,
  .text-button svg {
    width: 20px;
    height: 20px;
    fill: currentColor;
  }

  .text-button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    border: 1px solid var(--divider-color, #e0e0e0);
    border-radius: 20px;
    background: none;
    color: var(--primary-color, #03a9f4);
    cursor: pointer;
    font: inherit;
    font-weight: 500;
  }

  .text-button:hover:not([disabled]) {
    background: var(--secondary-background-color, rgba(0, 0, 0, 0.06));
  }

  .text-button[disabled] {
    opacity: 0.4;
    cursor: default;
  }

  .text-button.danger {
    color: var(--error-color, #db4437);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  /* -------------------------------- rows -------------------------------- */

  .row-card {
    border: 1px solid var(--divider-color, #e0e0e0);
    border-radius: 10px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--card-background-color, transparent);
  }

  .row-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .row-title {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .row-title strong {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mono {
    font-family: var(--code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 12px;
  }

  .empty {
    padding: 16px;
    border: 1px dashed var(--divider-color, #e0e0e0);
    border-radius: 10px;
    color: var(--secondary-text-color, #727272);
    text-align: center;
  }

  .alert {
    padding: 10px 12px;
    border-radius: 8px;
    font-size: 13px;
    line-height: 1.4;
    border-left: 4px solid var(--info-color, #039be5);
    background: var(--secondary-background-color, rgba(0, 0, 0, 0.04));
  }

  .alert-warning {
    border-left-color: var(--warning-color, #ffa600);
  }

  .alert-error {
    border-left-color: var(--error-color, #db4437);
  }

  .alert-success {
    border-left-color: var(--success-color, #43a047);
  }

  .panel {
    border: 1px solid var(--divider-color, #e0e0e0);
    border-radius: 10px;
  }

  .fallback-panel > summary {
    cursor: pointer;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-weight: 500;
  }

  .panel-body {
    padding: 0 12px 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  @media (prefers-reduced-motion: reduce) {
    * {
      transition: none !important;
      animation: none !important;
    }
  }
`;
