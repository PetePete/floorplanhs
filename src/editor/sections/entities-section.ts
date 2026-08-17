/**
 * Entities tab: the placed-entity table. Everything here can also be done by
 * dragging an entity onto the 3D view, which is what most people should do —
 * this table exists for fine-tuning and for keyboard-only editing.
 */

import { html } from 'lit';
import type { TemplateResult } from 'lit';
import type {
  ActionConfig,
  EntityRole,
  LightVisualConfig,
  MarkerConfig,
  PlacedEntity,
  Vec3,
} from '@/types/config';
import {
  MDI,
  alertBox,
  colorField,
  entityField,
  expansionPanel,
  iconButton,
  iconField,
  isExpanded,
  numberField,
  sectionTitle,
  selectField,
  setExpanded,
  sliderRow,
  switchRow,
  textButton,
  textField,
  vec3Field,
} from '@/editor/editor-styles';
import type { EditorContext, FieldOption } from '@/editor/editor-styles';

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

const ACTIONS: Array<NonNullable<ActionConfig>['action']> = [
  'more-info',
  'toggle',
  'call-service',
  'perform-action',
  'navigate',
  'url',
  'preset',
  'none',
];

function listOf(ctx: EditorContext): PlacedEntity[] {
  return ctx.config.entities ?? [];
}

function commit(ctx: EditorContext, entities: PlacedEntity[], immediate = true): void {
  ctx.update({ entities: entities.length ? entities : undefined }, immediate);
}

function updateEntity(
  ctx: EditorContext,
  index: number,
  patch: Partial<PlacedEntity>,
  immediate = false,
): void {
  const entities = [...listOf(ctx)];
  if (!entities[index]) return;
  entities[index] = { ...entities[index], ...patch };
  commit(ctx, entities, immediate);
}

function move(ctx: EditorContext, index: number, delta: number): void {
  const entities = [...listOf(ctx)];
  const target = index + delta;
  if (target < 0 || target >= entities.length) return;
  const [item] = entities.splice(index, 1);
  entities.splice(target, 0, item);
  commit(ctx, entities);
}

function levelOptions(ctx: EditorContext): FieldOption[] {
  const levels = ctx.config.model?.levels ?? [];
  return [
    { value: '', label: ctx.t('editor.level_auto', 'Auto (from height)') },
    ...levels.map((l) => ({ value: l.id, label: l.name || l.id })),
  ];
}

/** `light.kitchen` -> `light`; used to guess the role and the picker domain. */
function domainOf(entityId: string): string {
  const dot = entityId.indexOf('.');
  return dot > 0 ? entityId.slice(0, dot) : '';
}

function effectiveRole(entity: PlacedEntity): EntityRole | '' {
  if (entity.role) return entity.role;
  const domain = domainOf(entity.entity);
  return (ROLES as string[]).includes(domain) ? (domain as EntityRole) : '';
}

/* ---------------------------------------------------------------- actions */

function renderActionEditor(
  ctx: EditorContext,
  label: string,
  action: ActionConfig | undefined,
  onChange: (next: ActionConfig | undefined) => void,
): TemplateResult {
  const current = action?.action ?? 'more-info';
  const patch = (p: Partial<ActionConfig>): void => {
    onChange({ ...(action ?? { action: current }), ...p });
  };
  return html`<div class="row-card">
    ${selectField({
      label,
      value: current,
      options: ACTIONS.map((a) => ({ value: a, label: a })),
      onChange: (v) =>
        onChange(
          v === 'more-info' && !action
            ? undefined
            : { ...(action ?? {}), action: v as ActionConfig['action'] },
        ),
    })}
    ${current === 'call-service'
      ? textField({
          label: ctx.t('editor.service', 'Service'),
          value: action?.service ?? '',
          placeholder: 'light.turn_on',
          onChange: (v) => patch({ service: v || undefined }),
        })
      : ''}
    ${current === 'perform-action'
      ? textField({
          label: ctx.t('editor.perform_action', 'Action'),
          value: action?.perform_action ?? '',
          placeholder: 'scene.turn_on',
          onChange: (v) => patch({ perform_action: v || undefined }),
        })
      : ''}
    ${current === 'navigate'
      ? textField({
          label: ctx.t('editor.navigation_path', 'Navigation path'),
          value: action?.navigation_path ?? '',
          placeholder: '/lovelace/lights',
          onChange: (v) => patch({ navigation_path: v || undefined }),
        })
      : ''}
    ${current === 'url'
      ? textField({
          label: ctx.t('editor.url_path', 'URL'),
          value: action?.url_path ?? '',
          placeholder: 'https://…',
          onChange: (v) => patch({ url_path: v || undefined }),
        })
      : ''}
    ${current === 'preset'
      ? selectField({
          label: ctx.t('editor.preset', 'Camera preset'),
          value: action?.preset_id ?? '',
          options: [
            { value: '', label: '—' },
            ...(ctx.config.presets ?? []).map((p) => ({ value: p.id, label: p.name || p.id })),
          ],
          onChange: (v) => patch({ preset_id: v || undefined }),
        })
      : ''}
    ${current === 'toggle' || current === 'more-info' || current === 'call-service'
      ? entityField({
          label: ctx.t('editor.action_entity', 'Target entity (optional)'),
          value: action?.entity ?? '',
          hass: ctx.hass,
          suggestions: ctx.entities({ limit: 60 }),
          helper: ctx.t('editor.action_entity_help', 'Defaults to the placed entity itself.'),
          onChange: (v) => patch({ entity: v || undefined }),
        })
      : ''}
    ${textField({
      label: ctx.t('editor.confirmation', 'Confirmation text'),
      value: action?.confirmation?.text ?? '',
      placeholder: ctx.t('editor.confirmation_placeholder', 'empty = no confirmation'),
      onChange: (v) => patch({ confirmation: v ? { text: v } : undefined }),
    })}
  </div>`;
}

/* ----------------------------------------------------------------- light */

function renderLightOptions(
  ctx: EditorContext,
  index: number,
  light: LightVisualConfig,
): TemplateResult {
  const patch = (p: Partial<LightVisualConfig>, immediate = false): void =>
    updateEntity(ctx, index, { light: { ...light, ...p } }, immediate);
  const kind = light.kind ?? 'point';
  const fixture = light.fixture ?? {};
  return html`
    <div class="grid two">
      ${selectField({
        label: ctx.t('editor.light_kind', 'Light type'),
        value: kind,
        options: [
          { value: 'point', label: ctx.t('editor.light_point', 'Point (bulb)') },
          { value: 'spot', label: ctx.t('editor.light_spot', 'Spot (downlight)') },
          { value: 'rect', label: ctx.t('editor.light_rect', 'Rect area (panel)') },
          { value: 'emissive', label: ctx.t('editor.light_emissive', 'Emissive only (no cast)') },
        ],
        onChange: (v) => patch({ kind: v as LightVisualConfig['kind'] }, true),
      })}
      ${numberField({
        label: ctx.t('editor.light_intensity', 'Intensity multiplier'),
        value: light.intensity,
        step: 0.05,
        min: 0,
        placeholder: '1',
        onChange: (v) => patch({ intensity: v }),
      })}
      ${numberField({
        label: ctx.t('editor.light_distance', 'Falloff distance'),
        value: light.distance,
        step: 0.1,
        min: 0,
        suffix: 'm',
        placeholder: '8',
        helper: ctx.t('editor.light_distance_help', '0 = unlimited range'),
        onChange: (v) => patch({ distance: v }),
      })}
      ${numberField({
        label: ctx.t('editor.light_decay', 'Decay'),
        value: light.decay,
        step: 0.1,
        min: 0,
        placeholder: '2',
        helper: ctx.t('editor.light_decay_help', '2 = physically correct'),
        onChange: (v) => patch({ decay: v }),
      })}
    </div>
    ${kind === 'spot'
      ? html`
          ${sliderRow({
            label: ctx.t('editor.light_angle', 'Cone angle (°)'),
            value: light.angle ?? 35,
            min: 5,
            max: 89,
            step: 1,
            digits: 0,
            onChange: (v) => patch({ angle: v }),
          })}
          ${sliderRow({
            label: ctx.t('editor.light_penumbra', 'Penumbra'),
            value: light.penumbra ?? 0.4,
            min: 0,
            max: 1,
            step: 0.01,
            helper: ctx.t('editor.light_penumbra_help', 'Softness of the cone edge.'),
            onChange: (v) => patch({ penumbra: v }),
          })}
          ${vec3Field({
            label: ctx.t('editor.light_target_offset', 'Target offset'),
            value: light.targetOffset ?? [0, -1, 0],
            step: 0.05,
            suffix: 'm',
            helper: ctx.t('editor.light_target_offset_help', 'Where the cone points, relative to the light.'),
            onChange: (v) => patch({ targetOffset: v }),
          })}
        `
      : ''}
    ${kind === 'rect'
      ? html`<div class="grid">
          ${numberField({
            label: ctx.t('editor.light_width', 'Width'),
            value: light.size?.[0],
            step: 0.05,
            suffix: 'm',
            placeholder: '1',
            onChange: (v) => patch({ size: [v ?? 1, light.size?.[1] ?? 1] }),
          })}
          ${numberField({
            label: ctx.t('editor.light_height', 'Height'),
            value: light.size?.[1],
            step: 0.05,
            suffix: 'm',
            placeholder: '1',
            onChange: (v) => patch({ size: [light.size?.[0] ?? 1, v ?? 1] }),
          })}
        </div>`
      : ''}
    ${switchRow({
      label: ctx.t('editor.light_use_entity_color', 'Use the entity colour'),
      checked: light.useEntityColor ?? true,
      helper: ctx.t(
        'editor.light_use_entity_color_help',
        'RGB / colour temperature reported by the light entity drives the 3D light.',
      ),
      onChange: (v) => patch({ useEntityColor: v }, true),
    })}
    ${light.useEntityColor === false
      ? colorField({
          label: ctx.t('editor.light_color', 'Fixed colour'),
          value: light.color ?? '',
          placeholder: '#ffd9a0',
          onChange: (v) => patch({ color: v || undefined }),
        })
      : ''}
    ${switchRow({
      label: ctx.t('editor.light_fixture', 'Show luminaire'),
      checked: fixture.show ?? true,
      helper: ctx.t('editor.light_fixture_help', 'A small glowing body at the light position.'),
      onChange: (v) => patch({ fixture: { ...fixture, show: v } }, true),
    })}
    ${(fixture.show ?? true)
      ? html`<div class="grid">
          ${numberField({
            label: ctx.t('editor.fixture_radius', 'Luminaire radius'),
            value: fixture.radius,
            step: 0.01,
            min: 0.01,
            suffix: 'm',
            placeholder: '0.06',
            onChange: (v) => patch({ fixture: { ...fixture, radius: v } }),
          })}
          ${numberField({
            label: ctx.t('editor.fixture_emissive', 'Luminaire emissive'),
            value: fixture.emissive,
            step: 0.1,
            min: 0,
            placeholder: '2',
            onChange: (v) => patch({ fixture: { ...fixture, emissive: v } }),
          })}
        </div>`
      : ''}
  `;
}

/* ---------------------------------------------------------------- marker */

function renderMarkerOptions(
  ctx: EditorContext,
  index: number,
  marker: MarkerConfig,
): TemplateResult {
  const patch = (p: Partial<MarkerConfig>, immediate = false): void =>
    updateEntity(ctx, index, { marker: { ...marker, ...p } }, immediate);
  return html`
    <div class="grid two">
      ${selectField({
        label: ctx.t('editor.marker_shape', 'Shape'),
        value: marker.shape ?? 'auto',
        options: [
          { value: 'auto', label: ctx.t('editor.marker_auto', 'Auto (by role)') },
          { value: 'pill', label: 'Pill' },
          { value: 'dot', label: 'Dot' },
          { value: 'icon', label: 'Icon' },
          { value: 'label', label: 'Label' },
          { value: 'none', label: ctx.t('editor.marker_none', 'None (invisible)') },
        ],
        onChange: (v) => patch({ shape: v as MarkerConfig['shape'] }, true),
      })}
      ${iconField({
        label: ctx.t('editor.icon', 'Icon'),
        value: marker.icon ?? '',
        onChange: (v) => patch({ icon: v || undefined }, true),
      })}
      ${numberField({
        label: ctx.t('editor.marker_scale', 'Scale'),
        value: marker.scale,
        step: 0.05,
        min: 0.1,
        placeholder: '1',
        onChange: (v) => patch({ scale: v }),
      })}
      ${numberField({
        label: ctx.t('editor.marker_max_distance', 'Hide beyond'),
        value: marker.maxDistance,
        step: 0.5,
        min: 0,
        suffix: 'm',
        placeholder: ctx.t('editor.never', 'never'),
        onChange: (v) => patch({ maxDistance: v }),
      })}
    </div>
    ${switchRow({
      label: ctx.t('editor.marker_show_name', 'Show name'),
      checked: marker.showName ?? true,
      onChange: (v) => patch({ showName: v }, true),
    })}
    ${switchRow({
      label: ctx.t('editor.marker_show_state', 'Show state'),
      checked: marker.showState ?? true,
      onChange: (v) => patch({ showState: v }, true),
    })}
    ${switchRow({
      label: ctx.t('editor.marker_fixed_size', 'Constant screen size'),
      checked: marker.fixedSize ?? true,
      helper: ctx.t('editor.marker_fixed_size_help', 'Off = the marker shrinks with distance.'),
      onChange: (v) => patch({ fixedSize: v }, true),
    })}
    ${colorField({
      label: ctx.t('editor.marker_color', 'Colour'),
      value: marker.color ?? '',
      placeholder: ctx.t('editor.marker_color_placeholder', 'empty = state colour'),
      onChange: (v) => patch({ color: v || undefined }),
    })}
    ${vec3Field({
      label: ctx.t('editor.marker_offset', 'Offset'),
      value: marker.offset ?? [0, 0, 0],
      step: 0.01,
      suffix: 'm',
      onChange: (v) => patch({ offset: v }),
    })}
  `;
}

/* ------------------------------------------------------------------- row */

function renderEntityRow(
  ctx: EditorContext,
  entity: PlacedEntity,
  index: number,
  count: number,
): TemplateResult {
  const role = effectiveRole(entity);
  const key = `entity:${index}`;
  const position: Vec3 = entity.position ?? [0, 0, 0];
  return html`<div class="row-card">
    <div class="row-head">
      <div class="row-title">
        <strong>${entity.name || entity.entity || ctx.t('editor.new_entity', 'New entity')}</strong>
        <span class="helper mono"
          >${entity.entity} · ${position.map((n) => n.toFixed(2)).join(', ')}</span
        >
      </div>
      ${iconButton({
        path: MDI.up,
        label: ctx.t('editor.move_up', 'Move up'),
        disabled: index === 0,
        onClick: () => move(ctx, index, -1),
      })}
      ${iconButton({
        path: MDI.down,
        label: ctx.t('editor.move_down', 'Move down'),
        disabled: index === count - 1,
        onClick: () => move(ctx, index, 1),
      })}
      ${iconButton({
        path: MDI.delete,
        label: ctx.t('editor.remove', 'Remove'),
        danger: true,
        onClick: () => {
          const entities = [...listOf(ctx)];
          entities.splice(index, 1);
          commit(ctx, entities);
        },
      })}
    </div>
    ${entityField({
      label: ctx.t('editor.entity', 'Entity'),
      value: entity.entity,
      hass: ctx.hass,
      suggestions: ctx.entities({ limit: 80 }),
      onChange: (v) => updateEntity(ctx, index, { entity: v }, true),
    })}
    <div class="grid two">
      ${textField({
        label: ctx.t('editor.name_override', 'Name override'),
        value: entity.name ?? '',
        placeholder: ctx.t('editor.name_override_placeholder', 'friendly name'),
        onChange: (v) => updateEntity(ctx, index, { name: v || undefined }),
      })}
      ${selectField({
        label: ctx.t('editor.role', 'Role'),
        value: entity.role ?? '',
        options: [
          { value: '', label: ctx.t('editor.role_auto', 'Auto (from domain)') },
          ...ROLES.map((r) => ({ value: r, label: r })),
        ],
        onChange: (v) =>
          updateEntity(ctx, index, { role: (v || undefined) as EntityRole | undefined }, true),
      })}
      ${selectField({
        label: ctx.t('editor.level', 'Level'),
        value: entity.level ?? '',
        options: levelOptions(ctx),
        onChange: (v) => updateEntity(ctx, index, { level: v || null }, true),
      })}
      ${textField({
        label: ctx.t('editor.bind_node', 'Bind to glTF node'),
        value: entity.bindNode ?? '',
        placeholder: 'ground/kitchen/led_strip',
        helper: ctx.t('editor.bind_node_help', 'That node is tinted or animated by this entity.'),
        onChange: (v) => updateEntity(ctx, index, { bindNode: v || undefined }),
      })}
    </div>
    ${vec3Field({
      label: ctx.t('editor.position', 'Position'),
      value: position,
      step: 0.001,
      suffix: 'm',
      helper: ctx.t('editor.position_help', 'World coordinates in metres, Y is up.'),
      onChange: (v) => updateEntity(ctx, index, { position: v }),
    })}
    ${role === 'light'
      ? expansionPanel({
          header: ctx.t('editor.light_options', 'Light options'),
          secondary: ctx.t('editor.light_options_desc', 'How this entity lights the room'),
          open: isExpanded(ctx.ui, `${key}:light`),
          onToggle: (open) => {
            setExpanded(ctx.ui, `${key}:light`, open);
            ctx.refresh();
          },
          content: renderLightOptions(ctx, index, entity.light ?? {}),
        })
      : ''}
    ${expansionPanel({
      header: ctx.t('editor.marker_options', 'Marker options'),
      open: isExpanded(ctx.ui, `${key}:marker`),
      onToggle: (open) => {
        setExpanded(ctx.ui, `${key}:marker`, open);
        ctx.refresh();
      },
      content: renderMarkerOptions(ctx, index, entity.marker ?? {}),
    })}
    ${expansionPanel({
      header: ctx.t('editor.actions', 'Actions'),
      open: isExpanded(ctx.ui, `${key}:actions`),
      onToggle: (open) => {
        setExpanded(ctx.ui, `${key}:actions`, open);
        ctx.refresh();
      },
      content: html`
        ${renderActionEditor(ctx, ctx.t('editor.tap_action', 'Tap action'), entity.tap_action, (a) =>
          updateEntity(ctx, index, { tap_action: a }, true),
        )}
        ${renderActionEditor(ctx, ctx.t('editor.hold_action', 'Hold action'), entity.hold_action, (a) =>
          updateEntity(ctx, index, { hold_action: a }, true),
        )}
        ${renderActionEditor(
          ctx,
          ctx.t('editor.double_tap_action', 'Double tap action'),
          entity.double_tap_action,
          (a) => updateEntity(ctx, index, { double_tap_action: a }, true),
        )}
      `,
    })}
  </div>`;
}

export function renderEntitiesSection(ctx: EditorContext): TemplateResult {
  const entities = listOf(ctx);
  return html`
    <div class="section">
      ${sectionTitle(
        ctx.t('editor.entities', 'Placed entities'),
        ctx.t(
          'editor.entities_desc',
          'Entities anchored to a point in the house. Lights become real three.js lights; ' +
            'everything else gets a marker.',
        ),
      )}
      ${alertBox(
        'info',
        ctx.t(
          'editor.entities_dnd_hint',
          'Faster route: open the card, switch it to edit mode and drag an entity from the ' +
            'sidebar onto the 3D view. It lands where you drop it, on the right level, with the ' +
            'position already rounded to millimetres.',
        ),
      )}
      ${entities.length === 0
        ? html`<div class="empty">
            ${ctx.t('editor.entities_empty', 'Nothing placed yet.')}
          </div>`
        : entities.map((e, i) => renderEntityRow(ctx, e, i, entities.length))}
      <div class="actions">
        ${textButton({
          label: ctx.t('editor.add_entity', 'Add entity'),
          path: MDI.add,
          onClick: () => {
            const entities2 = [...listOf(ctx)];
            entities2.push({ entity: '', position: [0, 1.5, 0] });
            commit(ctx, entities2);
          },
        })}
      </div>
    </div>
  `;
}
