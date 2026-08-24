/**
 * Presets tab: named viewpoints. Camera coordinates are shown read-only on
 * purpose — typing a position/target by hand almost never gives a usable shot,
 * and the card can capture the live view in one click.
 */

import { html } from 'lit';
import type { TemplateResult } from 'lit';
import { CUT_SIDES, type CameraPreset, type SectionState, type Vec3 } from '@/types/config';
import { slugify, uid } from '@/util/math';
import {
  MDI,
  alertBox,
  iconButton,
  iconField,
  numberField,
  sectionTitle,
  selectField,
  switchRow,
  textButton,
  textField,
} from '@/editor/editor-styles';
import type { EditorContext } from '@/editor/editor-styles';

function presetsOf(ctx: EditorContext): CameraPreset[] {
  return ctx.config.presets ?? [];
}

function commit(ctx: EditorContext, presets: CameraPreset[], immediate = true): void {
  ctx.update({ presets: presets.length ? presets : undefined }, immediate);
}

function updatePreset(
  ctx: EditorContext,
  index: number,
  patch: Partial<CameraPreset>,
  immediate = false,
): void {
  const presets = [...presetsOf(ctx)];
  if (!presets[index]) return;
  presets[index] = { ...presets[index], ...patch };
  commit(ctx, presets, immediate);
}

/** Exactly one preset may be the default. */
function setDefault(ctx: EditorContext, index: number, value: boolean): void {
  const presets = presetsOf(ctx).map((p, i) => ({
    ...p,
    default: value && i === index ? true : undefined,
  }));
  commit(ctx, presets);
}

function move(ctx: EditorContext, index: number, delta: number): void {
  const presets = [...presetsOf(ctx)];
  const target = index + delta;
  if (target < 0 || target >= presets.length) return;
  const [item] = presets.splice(index, 1);
  presets.splice(target, 0, item);
  commit(ctx, presets);
}

function formatVec(v: Vec3 | undefined): string {
  if (!v) return '—';
  return v.map((n) => (Number.isFinite(n) ? n.toFixed(2) : '0')).join(', ');
}

function levelOptions(ctx: EditorContext): Array<{ value: string; label: string }> {
  const levels = ctx.config.model?.levels ?? [];
  return [
    { value: '', label: ctx.t('editor.all_levels', 'All levels') },
    ...levels.map((l) => ({ value: l.id, label: l.name || l.id })),
  ];
}

function renderPresetRow(
  ctx: EditorContext,
  preset: CameraPreset,
  index: number,
  count: number,
): TemplateResult {
  const visible = preset.visibleLevels ?? null;
  const singleLevel = visible && visible.length === 1 ? visible[0] : '';
  return html`<div class="row-card">
    <div class="row-head">
      <div class="row-title">
        <strong>${preset.name || preset.id}</strong>
        <span class="helper mono">
          ${ctx.t('editor.preset_pos', 'pos')} ${formatVec(preset.position)} ·
          ${ctx.t('editor.preset_target', 'target')} ${formatVec(preset.target)}
        </span>
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
          const presets = [...presetsOf(ctx)];
          presets.splice(index, 1);
          commit(ctx, presets);
        },
      })}
    </div>
    <div class="grid">
      ${textField({
        label: ctx.t('editor.name', 'Name'),
        value: preset.name,
        onChange: (v) => updatePreset(ctx, index, { name: v }),
      })}
      ${iconField({
        label: ctx.t('editor.icon', 'Icon'),
        value: preset.icon ?? '',
        onChange: (v) => updatePreset(ctx, index, { icon: v || undefined }, true),
      })}
      ${selectField({
        label: ctx.t('editor.visible_levels', 'Visible levels'),
        value: singleLevel,
        options: levelOptions(ctx),
        helper: ctx.t(
          'editor.visible_levels_help',
          'Restores this level selection with the viewpoint.',
        ),
        onChange: (v) => updatePreset(ctx, index, { visibleLevels: v ? [v] : null }, true),
      })}
      ${numberField({
        label: ctx.t('editor.fov', 'Field of view'),
        value: preset.fov,
        min: 10,
        max: 120,
        step: 1,
        suffix: '°',
        placeholder: ctx.t('editor.inherit', 'inherit'),
        onChange: (v) => updatePreset(ctx, index, { fov: v }),
      })}
    </div>
    ${preset.orthoZoom !== undefined || true
      ? numberField({
          label: ctx.t('editor.ortho_zoom', 'Orthographic zoom'),
          value: preset.orthoZoom,
          step: 0.1,
          min: 0.1,
          onChange: (v) => updatePreset(ctx, index, { orthoZoom: v }),
        })
      : ''}
    ${switchRow({
      label: ctx.t('editor.preset_default', 'Default view'),
      checked: preset.default === true,
      helper: ctx.t('editor.preset_default_help', 'Applied when the card loads.'),
      onChange: (v) => setDefault(ctx, index, v),
    })}
    ${switchRow({
      label: ctx.t('editor.preset_tour', 'Include in tour'),
      checked: preset.inTour === true,
      helper: ctx.t('editor.preset_tour_help', 'Part of the auto-rotate slideshow.'),
      onChange: (v) => updatePreset(ctx, index, { inTour: v || undefined }, true),
    })}
    ${sectionSummary(preset.section)
      ? html`<span class="helper"
          >${ctx.t('editor.preset_section', 'Saved cross-section')}:
          <span class="mono">${sectionSummary(preset.section)}</span></span
        >`
      : ''}
  </div>`;
}

/**
 * What this preset's cut amounts to, in one line: the isolated storey, the
 * faces cut away, or nothing at all. `mode` alone stopped saying anything once
 * cuts became independent of it — a view that takes the front wall off is
 * `mode: none`.
 */
function sectionSummary(section: SectionState | undefined): string {
  if (!section) return '';
  const parts: string[] = [];
  if (section.mode === 'level') parts.push(section.levelId ?? 'level');
  for (const side of CUT_SIDES) {
    const depth = section.cuts?.[side];
    if (depth && depth > 0) parts.push(`${side} ${depth}m`);
  }
  return parts.join(', ');
}

export function renderPresetsSection(ctx: EditorContext): TemplateResult {
  const presets = presetsOf(ctx);
  return html`
    <div class="section">
      ${sectionTitle(
        ctx.t('editor.presets', 'Camera presets'),
        ctx.t(
          'editor.presets_desc',
          'Named viewpoints shown in the preset bar. Each one stores the camera, ' +
            'optionally the cross-section and which levels were visible.',
        ),
      )}
      ${alertBox(
        'info',
        ctx.t(
          'editor.presets_capture_hint',
          'Position the camera in the card and use “Save current view” in its toolbar — that ' +
            'writes the position and target for you. They are read-only here because hand-typed ' +
            'coordinates almost never frame the shot you wanted.',
        ),
      )}
      ${presets.length === 0
        ? html`<div class="empty">
            ${ctx.t('editor.presets_empty', 'No presets yet.')}
          </div>`
        : presets.map((p, i) => renderPresetRow(ctx, p, i, presets.length))}
      <div class="actions">
        ${textButton({
          label: ctx.t('editor.add_preset', 'Add empty preset'),
          path: MDI.add,
          onClick: () => {
            const presets2 = [...presetsOf(ctx)];
            const name = `View ${presets2.length + 1}`;
            presets2.push({
              id: `${slugify(name)}_${uid('p').slice(-4)}`,
              name,
              position: [8, 6, 8],
              target: [0, 1, 0],
            });
            commit(ctx, presets2);
          },
        })}
      </div>
      ${presets.length > 0 && !presets.some((p) => p.default)
        ? alertBox(
            'info',
            ctx.t(
              'editor.presets_no_default',
              'No preset is marked as the default, so the card frames the whole house on load.',
            ),
          )
        : ''}
    </div>
  `;
}
