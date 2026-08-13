/** Model tab: where the geometry comes from, how it is placed, and storeys. */

import { html } from 'lit';
import type { TemplateResult } from 'lit';
import type { LevelDefinition, ModelConfig, Vec3 } from '@/types/config';
import { slugify, uid } from '@/util/math';
import {
  MDI,
  alertBox,
  iconButton,
  iconField,
  joinList,
  numberField,
  parseList,
  sectionTitle,
  selectField,
  textButton,
  textField,
  vec3Field,
} from '@/editor/editor-styles';
import type { EditorContext } from '@/editor/editor-styles';

const ZERO: Vec3 = [0, 0, 0];

function modelOf(ctx: EditorContext): ModelConfig {
  return ctx.config.model ?? {};
}

function patchModel(ctx: EditorContext, patch: Partial<ModelConfig>, immediate = false): void {
  ctx.update({ model: { ...modelOf(ctx), ...patch } }, immediate);
}

function patchLevels(ctx: EditorContext, levels: LevelDefinition[] | undefined): void {
  patchModel(ctx, { levels: levels && levels.length ? levels : undefined }, true);
}

function moveLevel(ctx: EditorContext, index: number, delta: number): void {
  const levels = [...(modelOf(ctx).levels ?? [])];
  const target = index + delta;
  if (target < 0 || target >= levels.length) return;
  const [item] = levels.splice(index, 1);
  levels.splice(target, 0, item);
  patchLevels(ctx, levels);
}

function updateLevel(
  ctx: EditorContext,
  index: number,
  patch: Partial<LevelDefinition>,
  immediate = false,
): void {
  const levels = [...(modelOf(ctx).levels ?? [])];
  if (!levels[index]) return;
  levels[index] = { ...levels[index], ...patch };
  patchModel(ctx, { levels }, immediate);
}

function addLevel(ctx: EditorContext): void {
  const levels = [...(modelOf(ctx).levels ?? [])];
  const previous = levels[levels.length - 1];
  const elevation = previous ? previous.elevation + (previous.height || 2.7) : 0;
  const name = levels.length === 0 ? 'Ground floor' : `Level ${levels.length}`;
  levels.push({
    id: slugify(name) || uid('level'),
    name,
    elevation: Number(elevation.toFixed(3)),
    height: previous?.height ?? 2.7,
  });
  patchLevels(ctx, levels);
}

function renderLevelRow(
  ctx: EditorContext,
  level: LevelDefinition,
  index: number,
  count: number,
): TemplateResult {
  return html`<div class="row-card">
    <div class="row-head">
      <div class="row-title">
        <strong>${level.name || level.id || `Level ${index + 1}`}</strong>
        <span class="helper mono"
          >${level.id} · y ${level.elevation} → ${(level.elevation + level.height).toFixed(2)} m</span
        >
      </div>
      ${iconButton({
        path: MDI.up,
        label: ctx.t('editor.move_up', 'Move up'),
        disabled: index === 0,
        onClick: () => moveLevel(ctx, index, -1),
      })}
      ${iconButton({
        path: MDI.down,
        label: ctx.t('editor.move_down', 'Move down'),
        disabled: index === count - 1,
        onClick: () => moveLevel(ctx, index, 1),
      })}
      ${iconButton({
        path: MDI.delete,
        label: ctx.t('editor.remove', 'Remove'),
        danger: true,
        onClick: () => {
          const levels = [...(modelOf(ctx).levels ?? [])];
          levels.splice(index, 1);
          patchLevels(ctx, levels);
        },
      })}
    </div>
    <div class="grid">
      ${textField({
        label: ctx.t('editor.level_id', 'ID'),
        value: level.id,
        helper: ctx.t('editor.level_id_help', 'Referenced by presets and entities'),
        onChange: (v) => updateLevel(ctx, index, { id: slugify(v) }),
      })}
      ${textField({
        label: ctx.t('editor.name', 'Name'),
        value: level.name,
        onChange: (v) => updateLevel(ctx, index, { name: v }),
      })}
      ${numberField({
        label: ctx.t('editor.elevation', 'Elevation'),
        value: level.elevation,
        step: 0.01,
        suffix: 'm',
        helper: ctx.t('editor.elevation_help', 'World Y of the finished floor'),
        onChange: (v) => updateLevel(ctx, index, { elevation: v ?? 0 }),
      })}
      ${numberField({
        label: ctx.t('editor.height', 'Storey height'),
        value: level.height,
        step: 0.01,
        min: 0.1,
        suffix: 'm',
        onChange: (v) => updateLevel(ctx, index, { height: v ?? 2.7 }),
      })}
      ${iconField({
        label: ctx.t('editor.icon', 'Icon'),
        value: level.icon ?? '',
        onChange: (v) => updateLevel(ctx, index, { icon: v || undefined }, true),
      })}
      ${textField({
        label: ctx.t('editor.level_nodes', 'glTF nodes'),
        value: joinList(level.nodes),
        placeholder: 'ground/*, stairs_lower',
        helper: ctx.t(
          'editor.level_nodes_help',
          'Comma separated. Leave empty to derive the level from geometry bounds.',
        ),
        onChange: (v) => updateLevel(ctx, index, { nodes: parseList(v) }),
      })}
    </div>
  </div>`;
}

export function renderModelSection(ctx: EditorContext): TemplateResult {
  const model = modelOf(ctx);
  const levels = model.levels ?? [];
  const usingDemo = model.demo === true || !model.url;

  return html`
    <div class="section">
      ${sectionTitle(
        ctx.t('editor.model', 'Model'),
        ctx.t(
          'editor.model_desc',
          'The card renders a built-in demo house until you point it at your own glTF/GLB file.',
        ),
      )}
      ${textField({
        label: ctx.t('editor.title', 'Card title'),
        value: ctx.config.title ?? '',
        placeholder: ctx.t('editor.title_placeholder', 'Optional heading above the view'),
        onChange: (v) => ctx.update({ title: v || undefined }),
      })}
      ${selectField({
        label: ctx.t('editor.model_source', 'Source'),
        value: model.demo === true ? 'demo' : 'url',
        options: [
          { value: 'demo', label: ctx.t('editor.model_demo', 'Built-in demo house') },
          { value: 'url', label: ctx.t('editor.model_url_opt', 'Own model file (.glb / .gltf)') },
        ],
        onChange: (v) => patchModel(ctx, { demo: v === 'demo' ? true : undefined }, true),
      })}
      ${textField({
        label: ctx.t('editor.model_url', 'Model URL'),
        value: model.url ?? '',
        placeholder: '/local/house.glb',
        helper: ctx.t(
          'editor.model_url_help',
          'Files in config/www/ are served from /local/. config/www/house.glb → /local/house.glb. ' +
            'Append ?v=2 after replacing the file to bust the browser cache.',
        ),
        onChange: (v) => patchModel(ctx, { url: v || undefined }),
      })}
      ${usingDemo && model.url
        ? alertBox(
            'info',
            ctx.t(
              'editor.model_demo_override',
              'Source is set to the demo house, so the URL above is ignored for now.',
            ),
          )
        : ''}
      ${!usingDemo && model.url && !/^(https?:)?\/\/|^\//.test(model.url)
        ? alertBox(
            'warning',
            ctx.t(
              'editor.model_url_relative',
              'The URL looks relative. Use an absolute path such as /local/house.glb.',
            ),
          )
        : ''}

      <div class="grid">
        ${numberField({
          label: ctx.t('editor.scale', 'Scale'),
          value: model.scale,
          step: 0.001,
          placeholder: '1',
          helper: ctx.t('editor.scale_help', '1 world unit = 1 metre'),
          onChange: (v) => patchModel(ctx, { scale: v }),
        })}
        ${textField({
          label: ctx.t('editor.draco', 'Draco decoder path'),
          value: model.dracoPath ?? '',
          placeholder: 'https://www.gstatic.com/draco/v1/decoders/',
          helper: ctx.t(
            'editor.draco_help',
            'Only needed for Draco-compressed .glb files. A trailing slash is required.',
          ),
          onChange: (v) => patchModel(ctx, { dracoPath: v || undefined }),
        })}
      </div>

      ${vec3Field({
        label: ctx.t('editor.rotation', 'Rotation'),
        suffix: '°',
        step: 1,
        value: model.rotation ?? ZERO,
        helper: ctx.t(
          'editor.rotation_help',
          'Applied XYZ in degrees. Z-up exports from Blender usually need X = -90.',
        ),
        onChange: (v) => patchModel(ctx, { rotation: isZero(v) ? undefined : v }),
      })}
      ${vec3Field({
        label: ctx.t('editor.offset', 'Offset'),
        suffix: 'm',
        step: 0.01,
        value: model.offset ?? ZERO,
        helper: ctx.t('editor.offset_help', 'Shifts the model so the ground floor sits at y = 0.'),
        onChange: (v) => patchModel(ctx, { offset: isZero(v) ? undefined : v }),
      })}
      ${textField({
        label: ctx.t('editor.glass_nodes', 'Glass nodes'),
        value: joinList(model.glassNodes),
        placeholder: 'window, glass, *_pane',
        helper: ctx.t(
          'editor.glass_nodes_help',
          'Comma separated node-name patterns whose materials become see-through.',
        ),
        onChange: (v) => patchModel(ctx, { glassNodes: parseList(v) }),
      })}

      ${sectionTitle(
        ctx.t('editor.levels', 'Levels'),
        ctx.t(
          'editor.levels_desc',
          'Storeys drive the level selector and the isolate-level cross-section. ' +
            'Leave the list empty and the engine derives them from the geometry.',
        ),
      )}
      ${levels.length === 0
        ? html`<div class="empty">
            ${ctx.t('editor.levels_auto', 'Levels are auto-detected from the model.')}
          </div>`
        : levels.map((level, i) => renderLevelRow(ctx, level, i, levels.length))}
      <div class="actions">
        ${textButton({
          label: ctx.t('editor.add_level', 'Add level'),
          path: MDI.add,
          onClick: () => addLevel(ctx),
        })}
        ${textButton({
          label: ctx.t('editor.autodetect_levels', 'Auto-detect levels'),
          path: MDI.magic,
          disabled: levels.length === 0,
          onClick: () => patchLevels(ctx, undefined),
        })}
      </div>
    </div>
  `;
}

function isZero(v: Vec3): boolean {
  return v[0] === 0 && v[1] === 0 && v[2] === 0;
}
