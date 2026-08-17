/** Advanced tab: cross-section defaults, camera behaviour, reset and export. */

import { html } from 'lit';
import type { TemplateResult } from 'lit';
import {
  DEFAULT_CAMERA_CONFIG,
  DEFAULT_SECTION_STATE,
  type Axis,
  type CameraConfig,
  type ClipPlaneState,
  type SectionMode,
  type SectionState,
} from '@/types/config';
import { radToDeg, degToRad } from '@/util/math';
import {
  MDI,
  alertBox,
  colorField,
  numberField,
  sectionTitle,
  selectField,
  sliderRow,
  switchRow,
  textButton,
} from '@/editor/editor-styles';
import type { EditorContext, FieldOption } from '@/editor/editor-styles';
import { toYaml } from '@/editor/yaml-preview';

function sectionOf(ctx: EditorContext): SectionState {
  return ctx.config.section ?? DEFAULT_SECTION_STATE;
}

function cameraOf(ctx: EditorContext): CameraConfig {
  return ctx.config.camera ?? {};
}

function patchSection(ctx: EditorContext, patch: Partial<SectionState>, immediate = false): void {
  ctx.update({ section: { ...sectionOf(ctx), ...patch } }, immediate);
}

function patchCamera(ctx: EditorContext, patch: Partial<CameraConfig>, immediate = false): void {
  ctx.update({ camera: { ...cameraOf(ctx), ...patch } }, immediate);
}

function planesOf(state: SectionState): ClipPlaneState[] {
  if (state.planes && state.planes.length) return state.planes;
  return DEFAULT_SECTION_STATE.planes;
}

function patchPlane(
  ctx: EditorContext,
  axis: Axis,
  patch: Partial<ClipPlaneState>,
  immediate = false,
): void {
  const state = sectionOf(ctx);
  const planes = planesOf(state).map((p) => (p.axis === axis ? { ...p, ...patch } : p));
  patchSection(ctx, { planes }, immediate);
}

function levelOptions(ctx: EditorContext): FieldOption[] {
  const levels = ctx.config.model?.levels ?? [];
  return [
    { value: '', label: ctx.t('editor.no_level', 'None') },
    ...levels.map((l) => ({ value: l.id, label: l.name || l.id })),
  ];
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* falls through to the textarea path below */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function renderAdvancedSection(ctx: EditorContext): TemplateResult {
  const section = sectionOf(ctx);
  const cam = cameraOf(ctx);
  const dc = DEFAULT_CAMERA_CONFIG;
  const planes = planesOf(section);

  return html`
    <div class="section">
      ${sectionTitle(
        ctx.t('editor.section_defaults', 'Cross-section defaults'),
        ctx.t(
          'editor.section_defaults_desc',
          'The state the card starts in. Users can still change it live from the toolbar; ' +
            'only what you set here is persisted.',
        ),
      )}
      ${selectField({
        label: ctx.t('editor.section_mode', 'Mode'),
        value: section.mode ?? 'none',
        options: [
          { value: 'none', label: ctx.t('editor.section_none', 'None — whole house') },
          { value: 'level', label: ctx.t('editor.section_level', 'Isolate one level') },
          { value: 'plane', label: ctx.t('editor.section_plane', 'Cut planes') },
        ],
        onChange: (v) => patchSection(ctx, { mode: v as SectionMode }, true),
      })}
      ${section.mode === 'level'
        ? selectField({
            label: ctx.t('editor.section_level_id', 'Isolated level'),
            value: section.levelId ?? '',
            options: levelOptions(ctx),
            onChange: (v) => patchSection(ctx, { levelId: v || null }, true),
          })
        : ''}
      ${section.mode === 'plane'
        ? html`${planes.map((plane) =>
            html`<div class="row-card">
              <div class="row-head">
                <div class="row-title">
                  <strong>${ctx.t('editor.plane', 'Plane')} ${plane.axis.toUpperCase()}</strong>
                </div>
              </div>
              ${switchRow({
                label: ctx.t('editor.enabled', 'Enabled'),
                checked: plane.enabled,
                onChange: (v) => patchPlane(ctx, plane.axis, { enabled: v }, true),
              })}
              ${numberField({
                label: ctx.t('editor.plane_position', 'Position'),
                value: plane.position,
                step: 0.05,
                suffix: 'm',
                onChange: (v) => patchPlane(ctx, plane.axis, { position: v ?? 0 }),
              })}
              ${switchRow({
                label: ctx.t('editor.plane_invert', 'Keep the other half'),
                checked: plane.invert,
                onChange: (v) => patchPlane(ctx, plane.axis, { invert: v }, true),
              })}
            </div>`,
          )}`
        : ''}
      ${switchRow({
        label: ctx.t('editor.section_caps', 'Solid cut caps'),
        checked: section.caps ?? true,
        helper: ctx.t(
          'editor.section_caps_help',
          'Fills cut surfaces so walls look solid instead of hollow. Needs a stencil buffer; ' +
            'falls back to hollow shells where that is unavailable.',
        ),
        onChange: (v) => patchSection(ctx, { caps: v }, true),
      })}
      ${(section.caps ?? true)
        ? colorField({
            label: ctx.t('editor.cap_color', 'Cap colour'),
            value: section.capColor ?? DEFAULT_SECTION_STATE.capColor ?? '#8a8f98',
            onChange: (v) => patchSection(ctx, { capColor: v || undefined }),
          })
        : ''}
      ${switchRow({
        label: ctx.t('editor.ghost_above', 'Ghost the levels above'),
        checked: section.ghostAbove ?? false,
        helper: ctx.t(
          'editor.ghost_above_help',
          'Levels above the active one fade out instead of disappearing.',
        ),
        onChange: (v) => patchSection(ctx, { ghostAbove: v }, true),
      })}

      ${sectionTitle(ctx.t('editor.camera', 'Camera'))}
      <div class="grid two">
        ${numberField({
          label: ctx.t('editor.fov', 'Field of view'),
          value: cam.fov,
          min: 10,
          max: 120,
          step: 1,
          suffix: '°',
          placeholder: String(dc.fov),
          onChange: (v) => patchCamera(ctx, { fov: v }),
        })}
        ${numberField({
          label: ctx.t('editor.near', 'Near clip'),
          value: cam.near,
          min: 0.001,
          step: 0.01,
          suffix: 'm',
          placeholder: String(dc.near),
          onChange: (v) => patchCamera(ctx, { near: v }),
        })}
        ${numberField({
          label: ctx.t('editor.far', 'Far clip'),
          value: cam.far,
          min: 1,
          step: 10,
          suffix: 'm',
          placeholder: String(dc.far),
          onChange: (v) => patchCamera(ctx, { far: v }),
        })}
        ${numberField({
          label: ctx.t('editor.min_distance', 'Min zoom distance'),
          value: cam.minDistance,
          min: 0.1,
          step: 0.1,
          suffix: 'm',
          placeholder: String(dc.minDistance),
          onChange: (v) => patchCamera(ctx, { minDistance: v }),
        })}
        ${numberField({
          label: ctx.t('editor.max_distance', 'Max zoom distance'),
          value: cam.maxDistance,
          min: 1,
          step: 1,
          suffix: 'm',
          placeholder: String(dc.maxDistance),
          onChange: (v) => patchCamera(ctx, { maxDistance: v }),
        })}
        ${numberField({
          label: ctx.t('editor.max_polar', 'Max polar angle'),
          value:
            cam.maxPolarAngle === undefined
              ? undefined
              : Number(radToDeg(cam.maxPolarAngle).toFixed(1)),
          min: 10,
          max: 180,
          step: 1,
          suffix: '°',
          placeholder: String(Math.round(radToDeg(dc.maxPolarAngle))),
          helper: ctx.t('editor.max_polar_help', 'Below 90° the user cannot orbit under the floor.'),
          onChange: (v) =>
            patchCamera(ctx, { maxPolarAngle: v === undefined ? undefined : degToRad(v) }),
        })}
      </div>
      ${sliderRow({
        label: ctx.t('editor.damping', 'Orbit damping'),
        value: cam.damping ?? dc.damping,
        min: 0.01,
        max: 0.5,
        step: 0.01,
        helper: ctx.t('editor.damping_help', 'Higher = snappier, lower = floatier.'),
        onChange: (v) => patchCamera(ctx, { damping: v }),
      })}
      ${sliderRow({
        label: ctx.t('editor.transition_duration', 'Preset transition (s)'),
        value: cam.transitionDuration ?? dc.transitionDuration,
        min: 0,
        max: 4,
        step: 0.05,
        onChange: (v) => patchCamera(ctx, { transitionDuration: v }),
      })}
      ${numberField({
        label: ctx.t('editor.idle_return', 'Return to default view after'),
        value: cam.idleReturnAfter,
        min: 0,
        step: 5,
        suffix: 's',
        placeholder: String(dc.idleReturnAfter),
        helper: ctx.t('editor.idle_return_help', '0 disables it. Handy on a wall tablet.'),
        onChange: (v) => patchCamera(ctx, { idleReturnAfter: v }),
      })}
      ${switchRow({
        label: ctx.t('editor.auto_rotate', 'Auto-rotate'),
        checked: cam.autoRotate ?? dc.autoRotate,
        helper: ctx.t('editor.auto_rotate_help', 'Slow orbit while nobody is interacting.'),
        onChange: (v) => patchCamera(ctx, { autoRotate: v }, true),
      })}
      ${(cam.autoRotate ?? dc.autoRotate)
        ? sliderRow({
            label: ctx.t('editor.auto_rotate_speed', 'Auto-rotate speed'),
            value: cam.autoRotateSpeed ?? dc.autoRotateSpeed,
            min: 0.05,
            max: 3,
            step: 0.05,
            onChange: (v) => patchCamera(ctx, { autoRotateSpeed: v }),
          })
        : ''}

      ${sectionTitle(ctx.t('editor.maintenance', 'Maintenance'))}
      <div class="actions">
        ${textButton({
          label: ctx.t('editor.export_config', 'Copy config as YAML'),
          path: MDI.copy,
          onClick: () => {
            void copyToClipboard(toYaml(ctx.config)).then((ok) =>
              ctx.notify(
                ok
                  ? ctx.t('editor.copied', 'Configuration copied to the clipboard')
                  : ctx.t('editor.copy_failed', 'Could not access the clipboard'),
              ),
            );
          },
        })}
        ${textButton({
          label: ctx.t('editor.reset_defaults', 'Reset look & camera to defaults'),
          path: MDI.restore,
          danger: true,
          onClick: () => {
            const confirmed =
              typeof window === 'undefined' ||
              window.confirm(
                ctx.t(
                  'editor.reset_confirm',
                  'Reset rendering, interface, camera and cross-section settings to their ' +
                    'defaults? Your model, presets and placed entities are kept.',
                ),
              );
            if (!confirmed) return;
            ctx.update(
              {
                render: undefined,
                ui: undefined,
                camera: undefined,
                section: undefined,
              },
              true,
            );
          },
        })}
      </div>
      ${alertBox(
        'info',
        ctx.t(
          'editor.reset_note',
          'Reset clears the rendering, interface, camera and cross-section blocks. The model, ' +
            'camera presets and placed entities are never touched.',
        ),
      )}
    </div>
  `;
}
