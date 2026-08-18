/** Appearance tab: renderer quality, lighting look, and the card's own chrome. */

import { html } from 'lit';
import type { TemplateResult } from 'lit';
import {
  DEFAULT_RENDER_CONFIG,
  DEFAULT_UI_CONFIG,
  type RenderConfig,
  type UiConfig,
} from '@/types/config';
import {
  colorField,
  numberField,
  sectionTitle,
  selectField,
  sliderRow,
  switchRow,
  textField,
} from '@/editor/editor-styles';
import type { EditorContext } from '@/editor/editor-styles';

function renderOf(ctx: EditorContext): RenderConfig {
  return ctx.config.render ?? {};
}

function uiOf(ctx: EditorContext): UiConfig {
  return ctx.config.ui ?? {};
}

function patchRender(ctx: EditorContext, patch: Partial<RenderConfig>, immediate = false): void {
  ctx.update({ render: { ...renderOf(ctx), ...patch } }, immediate);
}

function patchUi(ctx: EditorContext, patch: Partial<UiConfig>, immediate = false): void {
  ctx.update({ ui: { ...uiOf(ctx), ...patch } }, immediate);
}

export function renderAppearanceSection(ctx: EditorContext): TemplateResult {
  const r = renderOf(ctx);
  const ui = uiOf(ctx);
  const d = DEFAULT_RENDER_CONFIG;
  const du = DEFAULT_UI_CONFIG;

  return html`
    <div class="section">
      ${sectionTitle(
        ctx.t('editor.quality', 'Rendering'),
        ctx.t(
          'editor.quality_desc',
          'Auto picks a tier from the device. Drop to medium or low on wall tablets.',
        ),
      )}
      <div class="grid two">
        ${selectField({
          label: ctx.t('editor.render_quality', 'Quality'),
          value: r.quality ?? d.quality,
          options: [
            { value: 'auto', label: ctx.t('editor.quality_auto', 'Auto (recommended)') },
            { value: 'high', label: ctx.t('editor.quality_high', 'High') },
            { value: 'medium', label: ctx.t('editor.quality_medium', 'Medium') },
            { value: 'low', label: ctx.t('editor.quality_low', 'Low') },
          ],
          onChange: (v) =>
            patchRender(ctx, { quality: v as NonNullable<RenderConfig['quality']> }, true),
        })}
        ${numberField({
          label: ctx.t('editor.max_pixel_ratio', 'Max pixel ratio'),
          value: r.maxPixelRatio,
          min: 0.5,
          max: 3,
          step: 0.25,
          placeholder: String(d.maxPixelRatio),
          helper: ctx.t('editor.max_pixel_ratio_help', 'Lower = fewer pixels to shade. 1 is fine on tablets.'),
          onChange: (v) => patchRender(ctx, { maxPixelRatio: v }),
        })}
      </div>
      ${switchRow({
        label: ctx.t('editor.on_demand', 'On-demand rendering'),
        checked: r.onDemand ?? d.onDemand,
        helper: ctx.t(
          'editor.on_demand_help',
          'Stop drawing frames when nothing changed. Big battery win; leave this on.',
        ),
        onChange: (v) => patchRender(ctx, { onDemand: v }, true),
      })}
      ${numberField({
        label: ctx.t('editor.fps_limit', 'FPS limit'),
        value: r.fpsLimit,
        min: 10,
        max: 120,
        step: 1,
        placeholder: String(d.fpsLimit),
        helper: ctx.t('editor.fps_limit_help', 'Caps the frame rate while the view is animating.'),
        onChange: (v) => patchRender(ctx, { fpsLimit: v }),
      })}

      ${sectionTitle(ctx.t('editor.lighting', 'Light & atmosphere'))}
      ${sliderRow({
        label: ctx.t('editor.exposure', 'Exposure'),
        value: r.exposure ?? d.exposure,
        min: 0.2,
        max: 3,
        step: 0.05,
        helper: ctx.t('editor.exposure_help', 'Overall brightness of the tone-mapped image.'),
        onChange: (v) => patchRender(ctx, { exposure: v }),
      })}
      ${sliderRow({
        label: ctx.t('editor.ambient', 'Ambient intensity'),
        value: r.ambientIntensity ?? d.ambientIntensity,
        min: 0,
        max: 1.5,
        step: 0.01,
        helper: ctx.t(
          'editor.ambient_help',
          'Base fill so a house with every light off is readable rather than black.',
        ),
        onChange: (v) => patchRender(ctx, { ambientIntensity: v }),
      })}
      ${colorField({
        label: ctx.t('editor.background', 'Background'),
        value: r.background ?? '',
        placeholder: ctx.t('editor.background_placeholder', 'empty = follow the dashboard theme'),
        helper: ctx.t('editor.background_help', 'CSS colour for the area around the house.'),
        onChange: (v) => patchRender(ctx, { background: v || undefined }),
      })}

      ${sectionTitle(
        ctx.t('editor.ui', 'Card interface'),
        ctx.t('editor.ui_desc', 'Which controls are shown on top of the 3D view.'),
      )}
      ${switchRow({
        label: ctx.t('editor.show_toolbar', 'Toolbar'),
        checked: ui.showToolbar ?? du.showToolbar,
        onChange: (v) => patchUi(ctx, { showToolbar: v }, true),
      })}
      ${switchRow({
        label: ctx.t('editor.show_level_selector', 'Level selector'),
        checked: ui.showLevelSelector ?? du.showLevelSelector,
        onChange: (v) => patchUi(ctx, { showLevelSelector: v }, true),
      })}
      ${switchRow({
        label: ctx.t('editor.show_section_controls', 'Cross-section controls'),
        checked: ui.showSectionControls ?? du.showSectionControls,
        onChange: (v) => patchUi(ctx, { showSectionControls: v }, true),
      })}
      ${switchRow({
        label: ctx.t('editor.show_legend', 'Legend'),
        checked: ui.showLegend ?? du.showLegend,
        onChange: (v) => patchUi(ctx, { showLegend: v }, true),
      })}
      ${switchRow({
        label: ctx.t('editor.show_fps', 'FPS counter'),
        checked: ui.showFps ?? du.showFps,
        helper: ctx.t('editor.show_fps_help', 'Diagnostics only.'),
        onChange: (v) => patchUi(ctx, { showFps: v }, true),
      })}
      ${switchRow({
        label: ctx.t('editor.compact', 'Compact layout'),
        checked: ui.compact ?? du.compact,
        helper: ctx.t('editor.compact_help', 'Smaller chrome for narrow dashboard columns.'),
        onChange: (v) => patchUi(ctx, { compact: v }, true),
      })}
      <div class="grid two">
        ${selectField({
          label: ctx.t('editor.theme', 'Theme'),
          value: ui.theme ?? du.theme,
          options: [
            { value: 'auto', label: ctx.t('editor.theme_auto', 'Follow Home Assistant') },
            { value: 'light', label: ctx.t('editor.theme_light', 'Light') },
            { value: 'dark', label: ctx.t('editor.theme_dark', 'Dark') },
          ],
          onChange: (v) => patchUi(ctx, { theme: v as NonNullable<UiConfig['theme']> }, true),
        })}
        ${textField({
          label: ctx.t('editor.height', 'Height'),
          value: ui.height ?? '',
          placeholder: du.height,
          helper: ctx.t('editor.height_help', 'Any CSS length. Ignored in panel mode.'),
          onChange: (v) => patchUi(ctx, { height: v || undefined }),
        })}
      </div>
      ${textField({
        label: ctx.t('editor.aspect_ratio', 'Aspect ratio'),
        value: ui.aspectRatio ?? '',
        placeholder: '16:9',
        helper: ctx.t('editor.aspect_ratio_help', 'Overrides the height when set, e.g. 16:9 or 4:3.'),
        onChange: (v) => patchUi(ctx, { aspectRatio: v || undefined }),
      })}
    </div>
  `;
}
