/**
 * A tiny YAML writer plus the read-only preview pane shown in the editor.
 *
 * We serialise ourselves rather than pulling in `js-yaml`: the card ships as a
 * single inlined ES module and the config is a closed, well-known shape. The
 * only non-obvious rule is that short all-number arrays are written in flow
 * style (`[1.2, 0, -3.4]`) so coordinates stay readable in the dashboard YAML.
 */

import { html } from 'lit';
import type { TemplateResult } from 'lit';
import { MDI, iconButton, alertBox } from '@/editor/editor-styles';

/* ------------------------------------------------------------- serialiser */

const INDENT = '  ';

/** Plain, unquoted YAML key when it is a simple identifier. */
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Tokens that YAML 1.1 would read as something other than a string. */
const RESERVED_SCALARS = new Set([
  'y',
  'Y',
  'yes',
  'Yes',
  'YES',
  'n',
  'N',
  'no',
  'No',
  'NO',
  'true',
  'True',
  'TRUE',
  'false',
  'False',
  'FALSE',
  'on',
  'On',
  'ON',
  'off',
  'Off',
  'OFF',
  'null',
  'Null',
  'NULL',
  '~',
  '',
]);

function pad(level: number): string {
  return INDENT.repeat(level);
}

function needsQuotes(value: string): boolean {
  if (RESERVED_SCALARS.has(value)) return true;
  if (value !== value.trim()) return true;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value)) return true;
  if (/: |:$| #/.test(value)) return true;
  if (/[\n\r\t]/.test(value)) return true;
  // Anything that would round-trip as a number/date must be quoted to stay text.
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(value)) return true;
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return true;
  return false;
}

function quote(value: string): string {
  if (/[\n\r\t\\"]/.test(value)) {
    const escaped = value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
    return `"${escaped}"`;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return 'null';
  if (Number.isInteger(value)) return String(value);
  // Kill float noise like 0.30000000000000004 without losing real precision.
  return String(Number(value.toFixed(6)));
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return formatNumber(value);
  const str = String(value);
  return needsQuotes(str) ? quote(str) : str;
}

function yamlKey(key: string): string {
  return SAFE_KEY.test(key) ? key : quote(key);
}

/** `[x, y, z]`-style triples (and pairs/quads) stay on one line. */
function isFlowArray(value: unknown[]): boolean {
  return (
    value.length > 0 &&
    value.length <= 4 &&
    value.every((v) => typeof v === 'number' && Number.isFinite(v))
  );
}

function flowArray(value: unknown[]): string {
  return `[${value.map((v) => scalar(v)).join(', ')}]`;
}

function definedEntries(value: object): Array<[string, unknown]> {
  return Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== undefined,
  );
}

function emitMap(value: object, level: number, out: string[]): void {
  for (const [key, item] of definedEntries(value)) {
    const prefix = `${pad(level)}${yamlKey(key)}`;
    if (item === null) {
      out.push(`${prefix}: null`);
    } else if (Array.isArray(item)) {
      if (item.length === 0) out.push(`${prefix}: []`);
      else if (isFlowArray(item)) out.push(`${prefix}: ${flowArray(item)}`);
      else {
        out.push(`${prefix}:`);
        emitSeq(item, level + 1, out);
      }
    } else if (typeof item === 'object') {
      if (definedEntries(item).length === 0) out.push(`${prefix}: {}`);
      else {
        out.push(`${prefix}:`);
        emitMap(item, level + 1, out);
      }
    } else {
      out.push(`${prefix}: ${scalar(item)}`);
    }
  }
}

function emitSeq(value: unknown[], level: number, out: string[]): void {
  const dash = `${pad(level)}- `;
  for (const item of value) {
    if (item === null || item === undefined) {
      out.push(`${dash}null`);
    } else if (Array.isArray(item)) {
      if (item.length === 0) out.push(`${dash}[]`);
      else if (isFlowArray(item)) out.push(`${dash}${flowArray(item)}`);
      else {
        out.push(`${pad(level)}-`);
        emitSeq(item, level + 1, out);
      }
    } else if (typeof item === 'object') {
      const nested: string[] = [];
      emitMap(item, level + 1, nested);
      if (nested.length === 0) {
        out.push(`${dash}{}`);
      } else {
        // Hoist the first line onto the dash: `- key: value`.
        nested[0] = `${dash}${nested[0].slice(pad(level + 1).length)}`;
        out.push(...nested);
      }
    } else {
      out.push(`${dash}${scalar(item)}`);
    }
  }
}

/** Serialise any JSON-compatible value to YAML with 2-space indentation. */
export function toYaml(value: unknown): string {
  if (value === null || value === undefined) return 'null\n';
  const out: string[] = [];
  if (Array.isArray(value)) emitSeq(value, 0, out);
  else if (typeof value === 'object') emitMap(value, 0, out);
  else return `${scalar(value)}\n`;
  return out.length ? `${out.join('\n')}\n` : '{}\n';
}

/** UTF-8 byte length — what actually ends up in the Lovelace storage entry. */
export function byteSize(text: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
  return text.length;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** Above this the dashboard config starts to feel it; warn the user. */
export const YAML_SIZE_WARN_BYTES = 64 * 1024;

/* -------------------------------------------------------------- highlight */

type TokenKind = 'key' | 'string' | 'number' | 'boolean' | 'punct' | 'plain';

interface Token {
  kind: TokenKind;
  text: string;
}

function tokenizeValue(raw: string): Token[] {
  const text = raw.trim();
  if (text === '') return [];
  if (text.startsWith('[') || text.startsWith('{')) {
    const tokens: Token[] = [];
    // Flow sequences only ever hold numbers here, so a cheap split is enough.
    for (const part of text.split(/([[\]{},])/)) {
      if (part === '') continue;
      if (/^[[\]{},]$/.test(part)) tokens.push({ kind: 'punct', text: part });
      else if (/^\s*[-+]?[\d.]/.test(part)) tokens.push({ kind: 'number', text: part });
      else tokens.push({ kind: 'plain', text: part });
    }
    return tokens;
  }
  if (/^['"]/.test(text)) return [{ kind: 'string', text }];
  if (/^(true|false|null)$/.test(text)) return [{ kind: 'boolean', text }];
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) {
    return [{ kind: 'number', text }];
  }
  return [{ kind: 'plain', text }];
}

/** Splits one YAML line into indent / dash / key / value tokens. */
function tokenizeLine(line: string): Token[] {
  const indentMatch = /^(\s*)/.exec(line);
  const indent = indentMatch ? indentMatch[1] : '';
  let rest = line.slice(indent.length);
  const tokens: Token[] = [];
  if (indent) tokens.push({ kind: 'plain', text: indent });
  if (rest.startsWith('- ') || rest === '-') {
    tokens.push({ kind: 'punct', text: '- ' });
    rest = rest.slice(2);
  }
  const keyMatch = /^([^:]+):(\s|$)/.exec(rest);
  if (keyMatch) {
    tokens.push({ kind: 'key', text: keyMatch[1] });
    tokens.push({ kind: 'punct', text: ':' });
    const value = rest.slice(keyMatch[1].length + 1);
    if (value.trim() !== '') {
      tokens.push({ kind: 'plain', text: ' ' });
      tokens.push(...tokenizeValue(value));
    }
    return tokens;
  }
  tokens.push(...tokenizeValue(rest));
  return tokens;
}

function renderLine(line: string): TemplateResult {
  if (line === '') return html`<span class="yaml-line"> </span>`;
  return html`<span class="yaml-line"
    >${tokenizeLine(line).map(
      (tok) => html`<span class="yaml-${tok.kind}">${tok.text}</span>`,
    )}</span
  >`;
}

/* ---------------------------------------------------------------- preview */

export interface YamlPreviewSpec {
  yaml: string;
  onCopy: (yaml: string) => void;
  /** Optional label for the copy button. */
  copyLabel?: string;
}

export function renderYamlPreview(spec: YamlPreviewSpec): TemplateResult {
  const size = byteSize(spec.yaml);
  const oversized = size > YAML_SIZE_WARN_BYTES;
  const lines = spec.yaml.replace(/\n$/, '').split('\n');
  return html`
    <div class="yaml-preview">
      <div class="yaml-head">
        <span class="yaml-size ${oversized ? 'warn' : ''}"
          >${lines.length} lines · ${formatBytes(size)}</span
        >
        ${iconButton({
          path: MDI.copy,
          label: spec.copyLabel ?? 'Copy YAML to clipboard',
          onClick: () => spec.onCopy(spec.yaml),
        })}
      </div>
      ${oversized
        ? alertBox(
            'warning',
            `This configuration is ${formatBytes(size)}. Dashboards get sluggish above ` +
              `${formatBytes(YAML_SIZE_WARN_BYTES)} — check for base64 thumbnails or a long ` +
              `entity list before saving.`,
          )
        : ''}
      <pre class="yaml" tabindex="0" aria-label="Configuration YAML preview"><code
        >${lines.map((line, i) => html`${i > 0 ? '\n' : ''}${renderLine(line)}`)}</code
      ></pre>
    </div>
  `;
}

/** Styles for the preview; concatenated into the editor's `static styles`. */
export const yamlPreviewCss = `
  .yaml-preview {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 12px;
  }

  .yaml-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .yaml-size {
    color: var(--secondary-text-color, #727272);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .yaml-size.warn {
    color: var(--warning-color, #ffa600);
    font-weight: 600;
  }

  pre.yaml {
    margin: 0;
    max-height: 420px;
    overflow: auto;
    padding: 12px;
    border: 1px solid var(--divider-color, #e0e0e0);
    border-radius: 10px;
    background: var(--code-editor-background-color, var(--secondary-background-color, #f5f5f5));
    font-family: var(--code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 12px;
    line-height: 1.5;
    tab-size: 2;
    white-space: pre;
  }

  .yaml-key {
    color: var(--accent-color, #7e57c2);
  }

  .yaml-string {
    color: var(--success-color, #43a047);
  }

  .yaml-number {
    color: var(--info-color, #039be5);
  }

  .yaml-boolean {
    color: var(--warning-color, #ef6c00);
  }

  .yaml-punct {
    color: var(--secondary-text-color, #727272);
  }
`;
