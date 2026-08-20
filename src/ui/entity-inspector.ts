/**
 * Per-entity settings, shown when a placed marker is selected in edit mode.
 *
 * Every control writes a config patch immediately (debounced by one typing
 * pause) rather than waiting for an "apply" button, so the 3D view is the
 * preview: drag the intensity slider and the room actually gets brighter. That
 * only works because patches are merged locally before they are emitted — see
 * `queuePatch`.
 */

import { css, html, nothing, type TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import { defineFp, FpBaseElement } from '@/ui/base-element';
import { icon } from '@/ui/icons';
import { domainOf, getEntityName } from '@/ha/registry';
import { debounce } from '@/util/events';
import { vRound } from '@/util/math';
import type {
  ActionConfig,
  CameraPreset,
  EntityRole,
  LevelDefinition,
  LightVisualConfig,
  MarkerConfig,
  MarkerShape,
  PlacedEntity,
  Vec3,
} from '@/types/config';

const ROLES: EntityRole[] = [
  'light',
  'switch',
  'sensor',
  'binary_sensor',
  'cover',
  'climate',
  'media_player',
  'camera',
  'person',
  'marker',
];

const SHAPES: MarkerShape[] = ['auto', 'pill', 'dot', 'icon', 'label', 'none'];

const LIGHT_KINDS: NonNullable<LightVisualConfig['kind']>[] = ['point', 'spot', 'rect', 'emissive'];

const ACTIONS: ActionConfig['action'][] = [
  'more-info',
  'toggle',
  'navigate',
  'url',
  'preset',
  'none',
];

const AXIS_LABELS: Array<{ index: 0 | 1 | 2; label: string }> = [
  { index: 0, label: 'X' },
  { index: 1, label: 'Y' },
  { index: 2, label: 'Z' },
];

@defineFp('fp3d-entity-inspector')
export class Fp3dEntityInspector extends FpBaseElement {
  static override styles = [
    FpBaseElement.styles,
    css`
      :host {
        display: flex;
        pointer-events: none;
        max-height: 100%;
        min-height: 0;
      }

      .panel {
        display: flex;
        flex-direction: column;
        width: 296px;
        max-width: 100%;
        max-height: 100%;
        min-height: 0;
      }

      .body {
        padding: 4px 14px 14px;
        min-height: 0;
      }

      .entity-id {
        font-size: 11px;
        color: var(--fp3d-text-dim);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        margin: 6px 0 2px;
      }

      .grid3 {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 6px;
      }

      .grid3 label {
        display: flex;
        flex-direction: column;
        gap: 3px;
        font-size: 10.5px;
        font-weight: 700;
        color: var(--fp3d-text-dim);
      }

      .grid3 input {
        font-variant-numeric: tabular-nums;
      }

      .slider-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .slider-row input[type='range'] {
        flex: 1;
        min-width: 0;
      }

      .slider-row .num {
        flex: none;
        width: 42px;
        text-align: right;
        font-size: 11.5px;
        font-variant-numeric: tabular-nums;
        color: var(--fp3d-text-dim);
      }

      .color-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .color-row span {
        flex: 1;
        font-size: 13px;
      }

      .danger-zone {
        margin-top: 14px;
        padding-top: 10px;
        border-top: 1px solid var(--fp3d-divider);
        display: flex;
        justify-content: flex-end;
      }
    `,
  ];

  @property({ attribute: false }) entity: PlacedEntity | null = null;
  @property({ attribute: false }) levels: LevelDefinition[] = [];
  /** Rooms the model declares, for pointing the leader line at one by hand. */
  @property({ attribute: false }) rooms: Array<{ id: string; level: string | null }> = [];
  @property({ attribute: false }) presets: CameraPreset[] = [];

  /** Local echo so typing is not undone by the config round-trip. */
  @state() private draft: Partial<PlacedEntity> = {};

  private pendingPatch: Partial<PlacedEntity> = {};
  /**
   * Typed but not yet handed over; `null` when the field is not being edited.
   *
   * A name is written a letter at a time, and every letter used to be an edit:
   * the marker was relabelled per keystroke and — since the card writes to the
   * dashboard — Home Assistant rebuilt it under the cursor. Free text waits for
   * the end of the sentence, which is a blur, an Enter, or the panel closing.
   */
  @state() private nameDraft: string | null = null;

  private readonly flush = debounce(() => {
    const entityId = this.entity?.entity;
    const patch = this.pendingPatch;
    this.pendingPatch = {};
    if (!entityId || Object.keys(patch).length === 0) return;
    this.emit('fp3d-entity-patch', { entityId, patch });
  }, 150);

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (!changed.has('entity')) return;
    const previous = changed.get('entity') as PlacedEntity | null | undefined;
    // A different entity means the draft belongs to the old one.
    if (previous?.entity !== this.entity?.entity) {
      // The draft belongs to the entity we are leaving, and `this.entity` is
      // already the new one — so it is addressed by hand rather than through
      // `commitName`, which would rename whatever was just selected.
      if (this.nameDraft !== null && previous?.entity) {
        const name = this.nameDraft.trim();
        this.nameDraft = null;
        if ((previous.name ?? '') !== name) {
          this.emit('fp3d-entity-patch', {
            entityId: previous.entity,
            patch: { name: name || undefined },
          });
        }
      }
      this.flush.flush();
      this.draft = {};
      this.pendingPatch = {};
      this.flush.cancel();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    // Closing the panel is the end of the sentence, so the name goes with it
    // rather than being thrown away.
    this.commitName();
    this.flush.flush();
    this.flush.cancel();
  }

  /** Hand over a typed name, once. */
  private commitName(): void {
    const draft = this.nameDraft;
    if (draft === null) return;
    this.nameDraft = null;
    const name = draft.trim();
    if ((this.entity?.name ?? '') === name) return;
    this.queuePatch({ name: name || undefined });
    this.flush.flush();
  }

  /** Current value = persisted config with the not-yet-committed draft on top. */
  private get current(): PlacedEntity | null {
    if (!this.entity) return null;
    return { ...this.entity, ...this.draft };
  }

  private queuePatch(patch: Partial<PlacedEntity>): void {
    this.draft = { ...this.draft, ...patch };
    this.pendingPatch = { ...this.pendingPatch, ...patch };
    this.flush();
  }

  private patchMarker(patch: Partial<MarkerConfig>): void {
    this.queuePatch({ marker: { ...(this.current?.marker ?? {}), ...patch } });
  }

  private patchLight(patch: Partial<LightVisualConfig>): void {
    this.queuePatch({ light: { ...(this.current?.light ?? {}), ...patch } });
  }

  private setPosition(index: 0 | 1 | 2, value: number): void {
    const current = this.current;
    if (!current || !Number.isFinite(value)) return;
    const position = [...current.position] as Vec3;
    position[index] = value;
    this.queuePatch({ position: vRound(position) });
  }

  /**
   * Arrow keys nudge by 5 cm, Shift by 50 cm. The native number-input stepper
   * only knows one step, and 5 cm at a time across a room is unusable.
   */
  private onPositionKey(event: KeyboardEvent, index: 0 | 1 | 2): void {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    if (!event.shiftKey) return;
    event.preventDefault();
    const current = this.current;
    if (!current) return;
    const delta = (event.key === 'ArrowUp' ? 1 : -1) * 0.5;
    this.setPosition(index, Number((current.position[index] + delta).toFixed(3)));
  }

  private isLight(placed: PlacedEntity): boolean {
    const role = placed.role ?? (domainOf(placed.entity) as EntityRole);
    return role === 'light' || Boolean(placed.light);
  }

  private removeEntity(placed: PlacedEntity): void {
    const name = placed.name ?? getEntityName(this.hass, placed.entity);
    const message = this.t('ui.inspector.remove_confirm', 'Remove {name} from the model?', { name });
    if (typeof confirm === 'function' && !confirm(message)) return;
    this.emit('fp3d-entity-remove', { entityId: placed.entity });
  }

  /* -------------------------------------------------------------- pieces */

  private renderSlider(
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (value: number) => void,
    format: (value: number) => string = (v) => v.toFixed(2),
  ): TemplateResult {
    return html`
      <div class="field">
        <span class="field-label">${label}</span>
        <div class="slider-row">
          <input
            type="range"
            min=${min}
            max=${max}
            step=${step}
            .value=${String(value)}
            aria-label=${label}
            @input=${(event: Event) => onChange(Number((event.target as HTMLInputElement).value))}
          />
          <span class="num">${format(value)}</span>
        </div>
      </div>
    `;
  }

  private renderSwitch(label: string, checked: boolean, onToggle: () => void): TemplateResult {
    return html`<button class="switch" role="switch" aria-checked=${checked ? 'true' : 'false'} @click=${onToggle}>
      <span>${label}</span>
      <span class="track"></span>
    </button>`;
  }

  private renderActionSelect(
    label: string,
    key: 'tap_action' | 'hold_action' | 'double_tap_action',
    placed: PlacedEntity,
  ): TemplateResult {
    const action = placed[key];
    return html`
      <div class="field">
        <span class="field-label">${label}</span>
        <select
          aria-label=${label}
          @change=${(event: Event) => {
            const value = (event.target as HTMLSelectElement).value as ActionConfig['action'];
            this.queuePatch({ [key]: { ...(action ?? {}), action: value } } as Partial<PlacedEntity>);
          }}
        >
          <option value="" ?selected=${!action}>${this.t('ui.action.default', 'Default')}</option>
          ${ACTIONS.map(
            (name) =>
              html`<option value=${name} ?selected=${action?.action === name}>${name}</option>`,
          )}
        </select>
        ${action?.action === 'preset'
          ? html`<select
              aria-label=${this.t('ui.preset.title', 'Camera views')}
              @change=${(event: Event) =>
                this.queuePatch({
                  [key]: {
                    ...(action ?? { action: 'preset' }),
                    preset_id: (event.target as HTMLSelectElement).value,
                  },
                } as Partial<PlacedEntity>)}
            >
              ${this.presets.map(
                (preset) =>
                  html`<option value=${preset.id} ?selected=${action.preset_id === preset.id}>
                    ${preset.name}
                  </option>`,
              )}
            </select>`
          : nothing}
      </div>
    `;
  }

  private renderLight(placed: PlacedEntity): TemplateResult {
    const light = placed.light ?? {};
    return html`
      <div class="section-label">${this.t('ui.inspector.light', 'Light')}</div>
      <div class="field">
        <span class="field-label">${this.t('ui.inspector.light_kind', 'Kind')}</span>
        <select
          aria-label=${this.t('ui.inspector.light_kind', 'Kind')}
          @change=${(event: Event) =>
            this.patchLight({
              kind: (event.target as HTMLSelectElement).value as LightVisualConfig['kind'],
            })}
        >
          ${LIGHT_KINDS.map(
            (kind) =>
              html`<option value=${kind} ?selected=${(light.kind ?? 'point') === kind}>
                ${kind}
              </option>`,
          )}
        </select>
      </div>
      ${this.renderSlider(
        this.t('ui.inspector.intensity', 'Intensity'),
        light.intensity ?? 1,
        0,
        3,
        0.05,
        (value) => this.patchLight({ intensity: value }),
      )}
      ${this.renderSlider(
        this.t('ui.inspector.distance', 'Range (m)'),
        light.distance ?? 6,
        0,
        30,
        0.5,
        (value) => this.patchLight({ distance: value }),
        (value) => (value === 0 ? '∞' : value.toFixed(1)),
      )}
      ${(light.kind ?? 'point') === 'spot'
        ? html`
            ${this.renderSlider(
              this.t('ui.inspector.angle', 'Cone angle'),
              light.angle ?? 45,
              5,
              89,
              1,
              (value) => this.patchLight({ angle: value }),
              (value) => `${Math.round(value)}°`,
            )}
            ${this.renderSlider(
              this.t('ui.inspector.penumbra', 'Edge softness'),
              light.penumbra ?? 0.4,
              0,
              1,
              0.05,
              (value) => this.patchLight({ penumbra: value }),
            )}
          `
        : nothing}
      ${this.renderSwitch(
        this.t('ui.inspector.fixture', 'Show fixture'),
        light.fixture?.show !== false,
        () => this.patchLight({ fixture: { ...(light.fixture ?? {}), show: light.fixture?.show === false } }),
      )}
    `;
  }

  protected override render(): TemplateResult | typeof nothing {
    const placed = this.current;
    if (!placed) return nothing;

    const marker = placed.marker ?? {};
    const displayName = placed.name ?? getEntityName(this.hass, placed.entity);

    return html`
      <div class="panel surface solid" role="region" aria-label=${displayName}>
        <div class="sheet-title">
          ${icon('tune')}
          <span>${this.t('ui.inspector.title', 'Entity settings')}</span>
          <span class="spacer"></span>
          <button
            class="icon-btn"
            aria-label=${this.t('ui.action.close', 'Close')}
            @click=${() => this.emit('fp3d-inspector-close', {})}
          >
            ${icon('close')}
          </button>
        </div>

        <div class="body scroll-y">
          <p class="entity-id">${placed.entity}</p>

          <div class="field">
            <label for="fp3d-name">${this.t('ui.inspector.name', 'Name override')}</label>
            <input
              id="fp3d-name"
              type="text"
              .value=${this.nameDraft ?? placed.name ?? ''}
              placeholder=${getEntityName(this.hass, placed.entity)}
              @input=${(event: Event) => {
                this.nameDraft = (event.target as HTMLInputElement).value;
              }}
              @change=${() => this.commitName()}
              @keydown=${(event: KeyboardEvent) => {
                if (event.key !== 'Enter') return;
                (event.target as HTMLInputElement).blur();
              }}
            />
          </div>

          <div class="field">
            <span class="field-label">${this.t('ui.inspector.role', 'Role')}</span>
            <select
              aria-label=${this.t('ui.inspector.role', 'Role')}
              @change=${(event: Event) =>
                this.queuePatch({
                  role: ((event.target as HTMLSelectElement).value || undefined) as EntityRole,
                })}
            >
              <option value="" ?selected=${!placed.role}>${this.t('ui.action.auto', 'Auto')}</option>
              ${ROLES.map(
                (role) =>
                  html`<option value=${role} ?selected=${placed.role === role}>${role}</option>`,
              )}
            </select>
          </div>

          ${this.levels.length > 1
            ? html`<div class="field">
                <span class="field-label">${this.t('ui.toolbar.levels', 'Level')}</span>
                <select
                  aria-label=${this.t('ui.toolbar.levels', 'Level')}
                  @change=${(event: Event) =>
                    this.queuePatch({ level: (event.target as HTMLSelectElement).value || null })}
                >
                  <option value="" ?selected=${!placed.level}>
                    ${this.t('ui.placement.level_unknown', 'no level')}
                  </option>
                  ${this.levels.map(
                    (level) =>
                      html`<option value=${level.id} ?selected=${placed.level === level.id}>
                        ${level.name}
                      </option>`,
                  )}
                </select>
              </div>`
            : nothing}

          ${this.rooms.length > 0
            ? html`<div class="field">
                <span class="field-label">${this.t('ui.inspector.room', 'Room')}</span>
                <select
                  aria-label=${this.t('ui.inspector.room', 'Room')}
                  @change=${(event: Event) =>
                    this.queuePatch({ room: (event.target as HTMLSelectElement).value || undefined })}
                >
                  <option value="" ?selected=${!placed.room}>
                    ${this.t('ui.inspector.room_none', 'wherever it stands')}
                  </option>
                  ${this.rooms
                    .filter((room) => !placed.level || !room.level || room.level === placed.level)
                    .map(
                      (room) => html`<option value=${room.id} ?selected=${placed.room === room.id}>
                        ${room.id}
                      </option>`,
                    )}
                </select>
              </div>`
            : nothing}

          <div class="section-label">${this.t('ui.inspector.position', 'Position (m)')}</div>
          <div class="grid3">
            ${AXIS_LABELS.map(
              (axis) => html`
                <label>
                  ${axis.label}
                  <!-- change, not input: typing "2.45" passes through 2, 2., 2.4,
                       and each of those was a config write and a card rebuild. -->
                  <input
                    type="number"
                    step="0.05"
                    .value=${String(placed.position[axis.index] ?? 0)}
                    aria-label=${`${this.t('ui.inspector.position', 'Position')} ${axis.label}`}
                    @keydown=${(event: KeyboardEvent) => this.onPositionKey(event, axis.index)}
                    @change=${(event: Event) =>
                      this.setPosition(axis.index, Number((event.target as HTMLInputElement).value))}
                  />
                </label>
              `,
            )}
          </div>

          <div class="section-label">${this.t('ui.inspector.marker', 'Marker')}</div>
          <div class="field">
            <span class="field-label">${this.t('ui.inspector.shape', 'Shape')}</span>
            <select
              aria-label=${this.t('ui.inspector.shape', 'Shape')}
              @change=${(event: Event) =>
                this.patchMarker({
                  shape: (event.target as HTMLSelectElement).value as MarkerShape,
                })}
            >
              ${SHAPES.map(
                (shape) =>
                  html`<option value=${shape} ?selected=${(marker.shape ?? 'auto') === shape}>
                    ${shape}
                  </option>`,
              )}
            </select>
          </div>
          ${this.renderSwitch(
            this.t('ui.inspector.show_name', 'Show name'),
            marker.showName !== false,
            () => this.patchMarker({ showName: marker.showName === false }),
          )}
          ${this.renderSwitch(
            this.t('ui.inspector.show_state', 'Show state'),
            marker.showState === true,
            () => this.patchMarker({ showState: !marker.showState }),
          )}
          ${this.renderSlider(
            this.t('ui.inspector.scale', 'Scale'),
            marker.scale ?? 1,
            0.4,
            2.5,
            0.05,
            (value) => this.patchMarker({ scale: value }),
          )}
          <div class="color-row">
            <span>${this.t('ui.inspector.color', 'Colour')}</span>
            <input
              type="color"
              aria-label=${this.t('ui.inspector.color', 'Colour')}
              .value=${marker.color ?? '#03a9f4'}
              @change=${(event: Event) =>
                this.patchMarker({ color: (event.target as HTMLInputElement).value })}
            />
          </div>

          ${this.isLight(placed) ? this.renderLight(placed) : nothing}

          <div class="section-label">${this.t('ui.inspector.actions', 'Actions')}</div>
          ${this.renderActionSelect(this.t('ui.inspector.tap', 'Tap'), 'tap_action', placed)}
          ${this.renderActionSelect(this.t('ui.inspector.hold', 'Hold'), 'hold_action', placed)}

          <div class="danger-zone">
            <button class="text-btn danger" @click=${() => this.removeEntity(placed)}>
              ${icon('trash')}${this.t('ui.inspector.remove', 'Remove')}
            </button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'fp3d-entity-inspector': Fp3dEntityInspector;
  }
}
