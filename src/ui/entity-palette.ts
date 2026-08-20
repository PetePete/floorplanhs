/**
 * The drag & drop source for placing entities, visible only in edit mode.
 *
 * Two things drive the design:
 *
 *  1. **Two input paths, one protocol.** HTML5 drag & drop does not exist on
 *     touch, so a long press starts a pointer-driven drag instead. Both paths
 *     emit the same `fp3d-placement-*` events and the card translates them into
 *     `PlacementController` calls — the palette never touches the engine.
 *  2. **A real install has thousands of entities.** The list is windowed:
 *     only the rows inside the scrollport (plus a little overscan) are in the
 *     DOM, which keeps typing in the search box instant.
 */

import { css, html, type TemplateResult } from "lit";
import { property, query, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import { defineFp, FpBaseElement } from "@/ui/base-element";
import { icon, iconForDomain } from "@/ui/icons";
import { domainOf, searchEntities, type EntityOption } from "@/ha/registry";
import type { HomeAssistant } from "@/types/hass";
import type { PlacedEntity } from "@/types/config";
import { debounce } from "@/util/events";

/** Kept in sync with the card; re-declared to avoid a card -> ui import cycle. */
const ENTITY_DRAG_MIME = "application/x-ha-entity";

const HEADER_HEIGHT = 26;
const ROW_HEIGHT = 48;
const OVERSCAN = 6;
const LONG_PRESS_MS = 420;
const LONG_PRESS_SLOP_PX = 10;

/** Lights first: putting a lamp in a room is what this card is for. */
/**
 * The chips above the list. Not every domain — the search box reaches all of
 * them — but the ones a floorplan is usually filled with, in the order you
 * reach for them while furnishing one.
 */
const DOMAIN_FILTERS = [
  "light",
  "switch",
  "sensor",
  "binary_sensor",
  "cover",
  "media_player",
  "script",
  "scene",
];

type Row =
  | { kind: "header"; key: string; label: string; height: number }
  | { kind: "entity"; key: string; option: EntityOption; height: number };

/**
 * The filter and search the palette was last used with.
 *
 * Home Assistant rebuilds a card whenever the dashboard config changes, and in
 * edit mode this card changes it on every placement — so the palette was torn
 * down and rebuilt after each drop, throwing you back to `light` and an empty
 * search box while you were half way through placing switches. Module scope
 * outlives the element, which is exactly the lifetime this needs.
 */
const LAST_FILTER: { domain: string | null; query: string } = { domain: "light", query: "" };

@defineFp("fp3d-entity-palette")
export class Fp3dEntityPalette extends FpBaseElement {
  static override styles = [
    FpBaseElement.styles,
    css`
      :host {
        display: flex;
        pointer-events: none;
        /* Down the whole side: picking one entity out of a houseful is a
           scrolling job, and a panel that stops half way makes it a longer one. */
        height: 100%;
        max-height: 100%;
        min-height: 0;
      }

      .panel {
        container: palette / size;
        display: flex;
        flex-direction: column;
        width: 300px;
        max-width: 100%;
        height: 100%;
        max-height: 100%;
        min-height: 0;
      }

      /*
       * Title, search and filters stay put; only the list moves. Switching the
       * filter from lights to switches changes the length of the list, and a
       * header that scrolls away with it takes the filter you were using out of
       * sight — you are then looking for the control you just pressed. Sticky
       * rather than a fixed-height header, so this holds whichever box ends up
       * being the one that scrolls.
       */
      .panel-head {
        position: sticky;
        top: 0;
        z-index: 1;
        flex: none;
        background: var(--fp3d-surface-strong);
      }

      .search {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 8px 12px 6px;
        padding: 0 10px;
        border-radius: var(--fp3d-chrome-radius);
        background: var(--fp3d-hover);
      }

      .search .fp-icon {
        width: 18px;
        height: 18px;
        opacity: 0.6;
        flex: none;
      }

      .search input {
        background: transparent;
        border: none;
        min-height: 38px;
        padding: 0;
      }

      /*
       * Wrapped, not scrolled sideways. A row that scrolls horizontally with no
       * scrollbar can be dragged with a finger and not with a mouse — the wheel
       * scrolls the page, and the filters past the right edge were simply out of
       * reach. Two short lines of chips cost less than a control you cannot use.
       */
      .filters {
        display: flex;
        flex: none;
        flex-wrap: wrap;
        gap: 5px;
        padding: 2px 12px 8px;
      }

      .filters .chip {
        flex: none;
      }

      .filters .chip {
        height: 28px;
        padding: 0 10px;
        font-size: 11.5px;
      }

      /*
       * Queried against the panel, not the window: a card can be short on a tall
       * screen (a masonry view) or tall on a short one, and it is the panel's own
       * height that decides whether the header is affordable.
       */
      @container palette (max-height: 560px) {
        .search {
          margin: 6px 10px 4px;
        }

        .search input {
          min-height: 32px;
        }

        .filters {
          padding: 0 10px 6px;
        }

        .filters .chip {
          height: 26px;
        }
      }

      /* Shorter still: the title is the first thing to go. The icon and the
         close button carry it, and what the panel is for is not in doubt while
         you are dragging things out of it. */
      @container palette (max-height: 420px) {
        .sheet-title span:not(.spacer) {
          display: none;
        }

        .search {
          margin: 4px 10px 4px;
        }

        .filters {
          padding: 0 10px 4px;
        }
      }

      /* Folded: the same chip the navigator and the shelf fold into. */
      .peek {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 0 8px;
        min-height: 34px;
        max-width: 190px;
        border: none;
        border-radius: var(--fp3d-chrome-radius);
        color: var(--fp3d-text);
        font: inherit;
        font-size: 12.5px;
        font-weight: 500;
        cursor: pointer;
        pointer-events: auto;
        align-self: flex-start;
      }

      .peek:hover {
        background: var(--fp3d-hover);
      }

      .peek .fp-icon {
        width: 16px;
        height: 16px;
        flex: none;
        opacity: 0.8;
      }

      .peek-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .list {
        position: relative;
        flex: 1 1 auto;
        min-height: 120px;
        /* The panel is as tall as the card, so the overflow belongs here: the
           list takes what is left under the search box and scrolls inside it. */
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: 0 6px 8px;
        /* The list must scroll with a finger even though the canvas behind it
           sets touch-action: none for orbiting. */
        touch-action: pan-y;
      }

      .spacer {
        position: relative;
        width: 100%;
      }

      .row {
        position: absolute;
        left: 0;
        right: 0;
        box-sizing: border-box;
      }

      .head {
        display: flex;
        align-items: flex-end;
        padding: 4px 8px 2px;
        font-size: 10.5px;
        font-weight: 700;
        letter-spacing: 0.07em;
        text-transform: uppercase;
        color: var(--fp3d-text-dim);
      }

      .item {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        height: 44px;
        padding: 0 8px;
        border-radius: 10px;
        text-align: left;
        color: var(--fp3d-text);
        cursor: grab;
        box-sizing: border-box;
        transition: background-color var(--fp3d-fast) var(--fp3d-ease);
      }

      .item:hover {
        background: var(--fp3d-hover);
      }

      .item.pressing {
        background: var(--fp3d-accent-soft);
        transform: scale(0.98);
      }

      .item .glyph {
        display: flex;
        align-items: center;
        justify-content: center;
        flex: none;
        width: 30px;
        height: 30px;
        border-radius: 8px;
        background: var(--fp3d-hover);
        color: var(--fp3d-text-dim);
      }

      .item.on .glyph {
        color: var(--fp3d-active);
      }

      .item .glyph .fp-icon {
        width: 18px;
        height: 18px;
      }

      .texts {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        line-height: 1.25;
      }

      .texts .name {
        font-size: 13px;
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .texts .id {
        font-size: 11px;
        color: var(--fp3d-text-dim);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .placed-dot {
        flex: none;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--fp3d-success);
      }

      .row-actions {
        display: flex;
        gap: 2px;
        flex: none;
      }

      .row-actions .icon-btn {
        width: 30px;
        height: 30px;
      }

      .row-actions .icon-btn .fp-icon {
        width: 17px;
        height: 17px;
      }

      .empty {
        padding: 24px 16px;
        text-align: center;
      }

      .foot {
        padding: 8px 12px 10px;
        border-top: 1px solid var(--fp3d-divider);
      }
    `,
  ];

  @property({ attribute: false }) placed: PlacedEntity[] = [];
  /** False on a live dashboard, where Lovelace ignores a card's config change. */
  @property({ type: Boolean }) canPersist = false;
  /** Folded to a chip, like the panels beside it. Held by the card. */
  @property({ type: Boolean }) collapsed = false;

  @state() private query = LAST_FILTER.query;
  @state() private domain: string | null = LAST_FILTER.domain;
  @state() private scrollOffset = 0;
  @state() private viewportHeight = 320;
  @state() private pressingId: string | null = null;

  @query(".list") private listEl?: HTMLDivElement;

  private listObserver: ResizeObserver | null = null;
  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private pressOrigin: {
    x: number;
    y: number;
    id: string;
    pointerId: number;
  } | null = null;
  private dragging = false;
  private cachedRows: Row[] | null = null;

  /** Entity states change constantly; a repaint per push would fight scrolling. */
  private readonly refresh = debounce(() => {
    this.cachedRows = null;
    this.requestUpdate();
  }, 400);

  protected override hassChanged(previous: HomeAssistant | undefined): void {
    if (!previous) {
      this.cachedRows = null;
      this.requestUpdate();
      return;
    }
    this.refresh();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    LAST_FILTER.domain = this.domain;
    LAST_FILTER.query = this.query;
    this.refresh.cancel();
    this.listObserver?.disconnect();
    this.listObserver = null;
    this.clearPress();
    this.endTouchDrag(null);
  }

  protected override firstUpdated(): void {
    const list = this.listEl;
    if (!list || typeof ResizeObserver === "undefined") return;
    this.listObserver = new ResizeObserver((entries) => {
      this.viewportHeight =
        entries[0]?.contentRect.height ?? this.viewportHeight;
    });
    this.listObserver.observe(list);
  }

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (
      changed.has("query") ||
      changed.has("domain") ||
      changed.has("placed")
    ) {
      this.cachedRows = null;
    }
  }

  /* ---------------------------------------------------------------- data */

  private placedIds(): Set<string> {
    return new Set(this.placed.map((entry) => entry.entity));
  }

  private rows(): Row[] {
    if (this.cachedRows) return this.cachedRows;

    const options = searchEntities(
      this.hass,
      this.query,
      this.domain ? [this.domain] : undefined,
      400,
    );

    const rows: Row[] = [];
    let currentArea: string | null = null;
    let first = true;
    for (const option of options) {
      const area = option.area ?? this.t("ui.placement.no_area", "Unassigned");
      if (first || area !== currentArea) {
        currentArea = area;
        first = false;
        rows.push({
          kind: "header",
          key: `head:${area}`,
          label: area,
          height: HEADER_HEIGHT,
        });
      }
      rows.push({
        kind: "entity",
        key: option.entity_id,
        option,
        height: ROW_HEIGHT,
      });
    }

    this.cachedRows = rows;
    return rows;
  }

  /** Prefix-sum offsets: rows are two different heights, so no flat multiply. */
  private windowed(rows: Row[]): {
    items: Array<{ row: Row; top: number }>;
    total: number;
  } {
    const items: Array<{ row: Row; top: number }> = [];
    const start = this.scrollOffset - OVERSCAN * ROW_HEIGHT;
    const end = this.scrollOffset + this.viewportHeight + OVERSCAN * ROW_HEIGHT;
    let top = 0;
    for (const row of rows) {
      if (top + row.height >= start && top <= end) items.push({ row, top });
      top += row.height;
    }
    return { items, total: top };
  }

  /* ------------------------------------------------- mouse drag & drop */

  private onDragStart(event: DragEvent, option: EntityOption): void {
    const transfer = event.dataTransfer;
    if (!transfer) return;
    transfer.setData(ENTITY_DRAG_MIME, option.entity_id);
    // Plain text is the fallback for anything that cannot read a custom type.
    transfer.setData("text/plain", option.entity_id);
    transfer.effectAllowed = "copy";
    transfer.setDragImage(this.buildDragImage(option), 20, 20);
    this.emit("fp3d-placement-begin", { entityId: option.entity_id });
  }

  private onDragEnd(): void {
    this.emit("fp3d-placement-cancel", {});
  }

  /**
   * The default drag image is a washed-out screenshot of the row, which looks
   * broken over a 3D scene. A compact chip reads as "carrying something".
   */
  private buildDragImage(option: EntityOption): HTMLElement {
    const chip = document.createElement("div");
    chip.textContent = option.name;
    chip.style.cssText = [
      "position:fixed",
      "top:-1000px",
      "left:-1000px",
      "padding:8px 14px",
      "border-radius:999px",
      "font:500 13px/1 system-ui,sans-serif",
      "color:#fff",
      "background:#03a9f4",
      "box-shadow:0 6px 18px rgba(0,0,0,.35)",
      "white-space:nowrap",
    ].join(";");
    document.body.appendChild(chip);
    setTimeout(() => chip.remove(), 0);
    return chip;
  }

  /* --------------------------------------------------- touch drag & drop */

  private onPointerDown(event: PointerEvent, option: EntityOption): void {
    if (event.pointerType === "mouse") return;
    this.pressOrigin = {
      x: event.clientX,
      y: event.clientY,
      id: option.entity_id,
      pointerId: event.pointerId,
    };
    this.pressTimer = setTimeout(() => {
      this.pressTimer = null;
      this.startTouchDrag(event, option);
    }, LONG_PRESS_MS);
  }

  private startTouchDrag(event: PointerEvent, option: EntityOption): void {
    this.dragging = true;
    this.pressingId = option.entity_id;
    const target = event.target as HTMLElement | null;
    try {
      target?.setPointerCapture(event.pointerId);
    } catch {
      /* capture is best-effort */
    }
    // A short buzz is the only feedback a finger gets that the drag started.
    if (
      typeof navigator !== "undefined" &&
      typeof navigator.vibrate === "function"
    ) {
      navigator.vibrate(12);
    }
    this.emit("fp3d-placement-begin", { entityId: option.entity_id });
    this.emit("fp3d-placement-move", { x: event.clientX, y: event.clientY });
  }

  private onPointerMove(event: PointerEvent): void {
    if (this.dragging) {
      event.preventDefault();
      this.emit("fp3d-placement-move", { x: event.clientX, y: event.clientY });
      return;
    }
    const origin = this.pressOrigin;
    if (!origin || origin.pointerId !== event.pointerId) return;
    // Moving before the timer fires means the user is scrolling the list.
    if (
      Math.hypot(event.clientX - origin.x, event.clientY - origin.y) >
      LONG_PRESS_SLOP_PX
    ) {
      this.clearPress();
    }
  }

  private onPointerUp(event: PointerEvent): void {
    if (this.dragging) {
      this.emit("fp3d-placement-commit", {
        x: event.clientX,
        y: event.clientY,
      });
      this.endTouchDrag(event);
      return;
    }
    this.clearPress();
  }

  private onPointerCancel(event: PointerEvent): void {
    if (this.dragging) {
      this.emit("fp3d-placement-cancel", {});
      this.endTouchDrag(event);
    }
    this.clearPress();
  }

  private clearPress(): void {
    if (this.pressTimer) clearTimeout(this.pressTimer);
    this.pressTimer = null;
    this.pressOrigin = null;
  }

  private endTouchDrag(event: PointerEvent | null): void {
    if (event) {
      try {
        (event.target as HTMLElement | null)?.releasePointerCapture(
          event.pointerId,
        );
      } catch {
        /* already released */
      }
    }
    this.dragging = false;
    this.pressingId = null;
    this.clearPress();
  }

  /* -------------------------------------------------------------- render */

  private renderRow(row: Row, top: number): TemplateResult {
    if (row.kind === "header") {
      return html`<div
        class="row head"
        style="top:${top}px;height:${row.height}px"
        role="presentation"
      >
        ${row.label}
      </div>`;
    }

    const option = row.option;
    const isPlaced = this.placedIds().has(option.entity_id);
    const state = this.hass?.states[option.entity_id]?.state;
    const on = state === "on" || state === "open" || state === "playing";

    return html`
      <div class="row" style="top:${top}px;height:${row.height}px">
        <div
          class=${classMap({ item: true, on, pressing: this.pressingId === option.entity_id })}
          role="button"
          tabindex="0"
          draggable="true"
          aria-label=${`${option.name} (${option.entity_id})`}
          aria-grabbed=${this.pressingId === option.entity_id ? "true" : "false"}
          @dragstart=${(event: DragEvent) => this.onDragStart(event, option)}
          @dragend=${() => this.onDragEnd()}
          @pointerdown=${(event: PointerEvent) => this.onPointerDown(event, option)}
          @pointermove=${(event: PointerEvent) => this.onPointerMove(event)}
          @pointerup=${(event: PointerEvent) => this.onPointerUp(event)}
          @pointercancel=${(event: PointerEvent) => this.onPointerCancel(event)}
          @keydown=${(event: KeyboardEvent) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            if (isPlaced)
              this.emit("fp3d-entity-focus", { entityId: option.entity_id });
            else this.emit("fp3d-quick-add", { entityId: option.entity_id });
          }}
        >
          <span class="glyph"
            >${icon(iconForDomain(domainOf(option.entity_id)))}</span
          >
          <span class="texts">
            <span class="name">${option.name}</span>
            <span class="id">${option.entity_id}</span>
          </span>
          ${
            isPlaced
              ? html`
                  <span
                    class="placed-dot"
                    title=${this.t("ui.placement.already_placed", "Already placed")}
                  ></span>
                  <span class="row-actions">
                    <button
                      class="icon-btn"
                      aria-label=${this.t("ui.placement.highlight", "Show in the model")}
                      @click=${() => this.emit("fp3d-entity-focus", { entityId: option.entity_id })}
                    >
                      ${icon("target")}
                    </button>
                    <button
                      class="icon-btn"
                      aria-label=${this.t("ui.placement.remove", "Remove from the model")}
                      @click=${() => this.emit("fp3d-entity-remove", { entityId: option.entity_id })}
                    >
                      ${icon("trash")}
                    </button>
                  </span>
                `
              : html`
                  <span class="row-actions">
                    <button
                      class="icon-btn"
                      aria-label=${this.t("ui.placement.quick_add", "Place in the centre of the view")}
                      title=${this.t("ui.placement.quick_add", "Place in the centre of the view")}
                      @pointerdown=${(event: PointerEvent) => event.stopPropagation()}
                      @click=${(event: Event) => {
                      event.stopPropagation();
                      this.emit("fp3d-quick-add", {
                        entityId: option.entity_id,
                      });
                    }}
                    >
                      ${icon("plus")}
                    </button>
                  </span>
                `
          }
        </div>
      </div>
    `;
  }

  protected override render(): TemplateResult {
    const rows = this.rows();
    const { items, total } = this.windowed(rows);

    if (this.collapsed) {
      return html`
        <button
          class="surface peek"
          title=${this.t("ui.placement.expand", "Show entities")}
          aria-expanded="false"
          @click=${() => this.emit("fp3d-palette-collapse", { collapsed: false })}
        >
          ${icon("list")}
          <span class="peek-name">${this.t("ui.placement.title", "Place entities")}</span>
          ${icon("chevronRight")}
        </button>
      `;
    }

    return html`
      <div
        class="panel surface solid"
        role="region"
        aria-label=${this.t("ui.placement.title", "Place entities")}
      >
        <div class="panel-head">
          <div class="sheet-title">
            ${icon("list")}
            <span>${this.t("ui.placement.title", "Place entities")}</span>
            <span class="spacer"></span>
            <button
              class="icon-btn"
              aria-label=${this.t("ui.placement.collapse", "Hide entities")}
              aria-expanded="true"
              @click=${() => this.emit("fp3d-palette-collapse", { collapsed: true })}
            >
              ${icon("chevronLeft")}
            </button>
          </div>

          <div class="search">
            ${icon("search")}
            <input
              type="text"
              .value=${this.query}
              placeholder=${this.t("ui.placement.search", "Search entities")}
              aria-label=${this.t("ui.placement.search", "Search entities")}
              @input=${(event: Event) => {
              this.query = (event.target as HTMLInputElement).value;
              LAST_FILTER.query = this.query;
              this.scrollOffset = 0;
              if (this.listEl) this.listEl.scrollTop = 0;
            }}
            />
          </div>

          <div
            class="filters"
            role="group"
            aria-label=${this.t("ui.placement.filter", "Filter")}
          >
            ${DOMAIN_FILTERS.map(
            (domain) => html`
              <button
                class="chip"
                aria-pressed=${this.domain === domain ? "true" : "false"}
                @click=${() => {
                  this.domain = this.domain === domain ? null : domain;
                  // Written now, not on teardown: a rebuild can arrive before
                  // this element is told it is going away.
                  LAST_FILTER.domain = this.domain;
                }}
              >
                ${domain}
              </button>
            `,
          )}
          </div>
        </div>

        <div
          class="list scroll-y"
          @scroll=${(event: Event) => {
            this.scrollOffset = (event.target as HTMLElement).scrollTop;
          }}
        >
          ${
            rows.length === 0
              ? html`<p class="empty hint">
                  ${this.t(
                  "ui.placement.no_results",
                  'No entities match "{query}"',
                  {
                    query: this.query,
                  },
                )}
                </p>`
              : html`<div class="spacer" style="height:${total}px">
                  ${repeat(
                  items,
                  (entry) => entry.row.key,
                  (entry) => this.renderRow(entry.row, entry.top),
                )}
                </div>`
          }
        </div>

        <div class="foot">
          <p class="hint">
            ${this.canPersist
              ? this.t("ui.placement.hint_drag", "Drag an entity onto the model to place it.")
              : this.t(
                  "ui.placement.hint_volatile",
                  "Not saved. Placements are written to the dashboard while it is in edit mode — a YAML dashboard has to be edited by hand.",
                )}
          </p>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "fp3d-entity-palette": Fp3dEntityPalette;
  }
}
