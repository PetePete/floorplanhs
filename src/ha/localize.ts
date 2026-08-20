/**
 * Localisation for the card's *own* UI strings.
 *
 * Home Assistant's `hass.localize` only knows core/integration keys, so a
 * custom card has to ship its own table. This is deliberately a plain object
 * rather than a loader: the bundle is a single ES module and a few kilobytes of
 * strings are cheaper than an async fetch on a wall tablet.
 */

import type { HomeAssistant } from '@/types/hass';

export type LocalizeKey = keyof typeof EN;

/** Values that may be interpolated into `{placeholder}` slots. */
export type LocalizeParams = Record<string, string | number>;

const EN = {
  /* ------------------------------------------------------------- toolbar */
  'ui.toolbar.presets': 'Views',
  'ui.toolbar.levels': 'Levels',
  'ui.toolbar.section': 'Section',
  'ui.toolbar.reset_view': 'Reset view',
  'ui.toolbar.fit_view': 'Fit to screen',
  'ui.toolbar.explode': 'Separate storeys',
  'ui.toolbar.orthographic': 'Floorplan view',
  'ui.toolbar.perspective': 'Perspective view',
  'ui.toolbar.auto_rotate': 'Auto rotate',
  'ui.toolbar.edit': 'Edit layout',
  'ui.toolbar.done': 'Done',
  'ui.toolbar.settings': 'Settings',
  'ui.toolbar.fullscreen': 'Fullscreen',
  'ui.toolbar.exit_fullscreen': 'Exit fullscreen',
  'ui.toolbar.markers': 'Markers',

  /* -------------------------------------------------------- section modes */
  'ui.section.none': 'Off',
  'ui.section.level': 'Isolate level',
  'ui.section.plane': 'Cut plane',
  'ui.section.box': 'Cut box',
  'ui.section.axis_x': 'X axis',
  'ui.section.axis_y': 'Y axis',
  'ui.section.axis_z': 'Z axis',
  'ui.section.invert': 'Flip side',
  'ui.section.caps': 'Solid cuts',
  'ui.section.handles': 'Show handles',

  /* -------------------------------------------------------- preset dialog */
  'ui.preset.overview': 'Overview',
  'ui.preset.whole_house': 'Building',
  'ui.preset.saved_group': 'Saved views',
  'ui.dock.title': 'Actions',
  'ui.dock.collapse': 'Hide actions',
  'ui.dock.expand': 'Show actions',
  'ui.dock.empty':
    'Drop a script or scene here — things that happen, rather than things that sit somewhere.',
  'ui.preset.title': 'Camera views',
  'ui.preset.collapse': 'Hide views',
  'ui.preset.expand': 'Show views',
  'ui.preset.save_current': 'Save current view',
  'ui.preset.name': 'Name',
  'ui.preset.name_placeholder': 'Living room',
  'ui.preset.icon': 'Icon',
  'ui.preset.make_default': 'Open with this view',
  'ui.preset.include_in_tour': 'Include in tour',
  'ui.preset.store_section': 'Remember section state',
  'ui.preset.update': 'Update to current view',
  'ui.preset.delete': 'Delete view',
  'ui.preset.delete_confirm': 'Delete the view "{name}"?',
  'ui.preset.empty': 'No saved views yet. Move the camera and save one.',
  'ui.preset.saved': 'View "{name}" saved',

  /* ------------------------------------------------------------ placement */
  'ui.placement.collapse': 'Hide entities',
  'ui.placement.expand': 'Show entities',
  'ui.placement.hint_drag': 'Drag an entity onto the model to place it.',
  'ui.placement.hint_volatile':
    'Not saved. Placements are written to the dashboard while it is in edit mode — a YAML dashboard has to be edited by hand.',
  'ui.placement.save_failed': 'Could not save to the dashboard: {error}',
  'ui.placement.hint_drop': 'Release to place {name} here.',
  'ui.placement.hint_invalid': 'Drop on a surface of the house.',
  'ui.placement.hint_move': 'Drag the marker to move it, Esc to cancel.',
  'ui.placement.hint_touch': 'Touch and hold a marker to move it.',
  'ui.placement.placed': '{name} placed on {level}',
  'ui.placement.moved': '{name} moved',
  'ui.placement.removed': '{name} removed',
  'ui.placement.cancelled': 'Placement cancelled',
  'ui.placement.search': 'Search entities',
  'ui.placement.no_results': 'No entities match "{query}"',
  'ui.placement.level_unknown': 'no level',

  /* ---------------------------------------------------------------- state */
  'ui.state.on': 'On',
  'ui.state.off': 'Off',
  'ui.state.unavailable': 'Unavailable',
  'ui.state.unknown': 'Unknown',
  'ui.state.brightness': 'Brightness',

  /* --------------------------------------------------------------- errors */
  'ui.error.config': 'Configuration error',
  'ui.error.model_load': 'Could not load the model: {message}',
  'ui.error.webgl': 'This browser or device has no WebGL support, so the 3D view cannot be shown.',
  'ui.error.context_lost': 'The 3D context was lost. Reloading the view…',
  'ui.error.entity_missing': 'Entity {entity} does not exist',
  'ui.error.action_failed': 'Action failed: {message}',
  'ui.error.generic': 'Something went wrong',

  /* ---------------------------------------------------------- empty states */
  'ui.empty.no_entities': 'No entities placed yet. Switch to edit mode to add some.',
  'ui.empty.no_levels': 'No levels detected in this model.',
  'ui.empty.loading_model': 'Loading model…',
  'ui.empty.preparing': 'Preparing scene…',
  'ui.empty.demo_hint': 'Showing the demo house. Point `model.url` at your own glTF file.',
} as const;

type Table = Partial<Record<LocalizeKey, string>>;

const DE: Table = {
  'ui.toolbar.presets': 'Ansichten',
  'ui.toolbar.levels': 'Etagen',
  'ui.toolbar.section': 'Schnitt',
  'ui.toolbar.reset_view': 'Ansicht zurücksetzen',
  'ui.toolbar.fit_view': 'Modell einpassen',
  'ui.toolbar.orthographic': 'Grundrissansicht',
  'ui.toolbar.perspective': 'Perspektivische Ansicht',
  'ui.toolbar.auto_rotate': 'Automatisch drehen',
  'ui.toolbar.edit': 'Layout bearbeiten',
  'ui.toolbar.done': 'Fertig',
  'ui.toolbar.settings': 'Einstellungen',
  'ui.toolbar.fullscreen': 'Vollbild',
  'ui.toolbar.exit_fullscreen': 'Vollbild beenden',
  'ui.toolbar.markers': 'Marker',

  'ui.section.none': 'Aus',
  'ui.section.level': 'Etage isolieren',
  'ui.section.plane': 'Schnittebene',
  'ui.section.box': 'Schnittbox',
  'ui.section.axis_x': 'X-Achse',
  'ui.section.axis_y': 'Y-Achse',
  'ui.section.axis_z': 'Z-Achse',
  'ui.section.invert': 'Seite wechseln',
  'ui.section.caps': 'Massive Schnittflächen',
  'ui.section.handles': 'Griffe anzeigen',

  'ui.dock.title': 'Aktionen',
  'ui.dock.collapse': 'Aktionen ausblenden',
  'ui.dock.expand': 'Aktionen einblenden',
  'ui.dock.empty':
    'Skript oder Szene hierher ziehen — Dinge, die passieren, statt Dinge, die irgendwo stehen.',
  'ui.preset.title': 'Kameraansichten',
  'ui.preset.collapse': 'Ansichten ausblenden',
  'ui.preset.expand': 'Ansichten einblenden',
  'ui.preset.save_current': 'Aktuelle Ansicht speichern',
  'ui.preset.name': 'Name',
  'ui.preset.name_placeholder': 'Wohnzimmer',
  'ui.preset.icon': 'Symbol',
  'ui.preset.make_default': 'Mit dieser Ansicht öffnen',
  'ui.preset.include_in_tour': 'In Tour aufnehmen',
  'ui.preset.store_section': 'Schnittzustand merken',
  'ui.preset.update': 'Auf aktuelle Ansicht aktualisieren',
  'ui.preset.delete': 'Ansicht löschen',
  'ui.preset.delete_confirm': 'Ansicht "{name}" löschen?',
  'ui.preset.empty': 'Noch keine Ansichten gespeichert. Kamera bewegen und speichern.',
  'ui.preset.saved': 'Ansicht "{name}" gespeichert',

  'ui.placement.collapse': 'Entitäten ausblenden',
  'ui.placement.expand': 'Entitäten einblenden',
  'ui.placement.hint_drag': 'Entität auf das Modell ziehen, um sie zu platzieren.',
  'ui.placement.hint_volatile':
    'Nicht gespeichert. Platzierungen werden geschrieben, solange das Dashboard im Bearbeitungsmodus ist — ein YAML-Dashboard muss von Hand bearbeitet werden.',
  'ui.placement.save_failed': 'Konnte nicht im Dashboard gespeichert werden: {error}',
  'ui.placement.hint_drop': 'Loslassen, um {name} hier zu platzieren.',
  'ui.placement.hint_invalid': 'Auf einer Fläche des Hauses ablegen.',
  'ui.placement.hint_move': 'Marker ziehen zum Verschieben, Esc zum Abbrechen.',
  'ui.placement.hint_touch': 'Marker gedrückt halten, um ihn zu verschieben.',
  'ui.placement.placed': '{name} auf {level} platziert',
  'ui.placement.moved': '{name} verschoben',
  'ui.placement.removed': '{name} entfernt',
  'ui.placement.cancelled': 'Platzierung abgebrochen',
  'ui.placement.search': 'Entitäten suchen',
  'ui.placement.no_results': 'Keine Entität passt zu "{query}"',
  'ui.placement.level_unknown': 'keine Etage',

  'ui.state.on': 'An',
  'ui.state.off': 'Aus',
  'ui.state.unavailable': 'Nicht verfügbar',
  'ui.state.unknown': 'Unbekannt',
  'ui.state.brightness': 'Helligkeit',

  'ui.error.config': 'Konfigurationsfehler',
  'ui.error.model_load': 'Modell konnte nicht geladen werden: {message}',
  'ui.error.webgl':
    'Dieser Browser oder dieses Gerät unterstützt kein WebGL, die 3D-Ansicht kann nicht angezeigt werden.',
  'ui.error.context_lost': 'Der 3D-Kontext ging verloren. Ansicht wird neu geladen…',
  'ui.error.entity_missing': 'Entität {entity} existiert nicht',
  'ui.error.action_failed': 'Aktion fehlgeschlagen: {message}',
  'ui.error.generic': 'Etwas ist schiefgelaufen',

  'ui.empty.no_entities': 'Noch keine Entitäten platziert. Im Bearbeitungsmodus hinzufügen.',
  'ui.empty.no_levels': 'In diesem Modell wurden keine Etagen erkannt.',
  'ui.empty.loading_model': 'Modell wird geladen…',
  'ui.empty.preparing': 'Szene wird vorbereitet…',
  'ui.empty.demo_hint': 'Es wird das Demo-Haus gezeigt. `model.url` auf eine eigene glTF-Datei setzen.',
};

const TABLES: Record<string, Table> = { en: EN, de: DE };

/** `de-CH`, `de_DE` and `DE` all resolve to the `de` table. */
function baseLanguage(language: string | undefined): string {
  if (!language) return 'en';
  return language.toLowerCase().split(/[-_]/)[0] || 'en';
}

export function resolveLanguage(hass: Pick<HomeAssistant, 'language' | 'locale'> | undefined): string {
  const lang = baseLanguage(hass?.locale?.language ?? hass?.language);
  return lang in TABLES ? lang : 'en';
}

function interpolate(template: string, params?: LocalizeParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? match : String(value);
  });
}

/**
 * Look a card string up in the user's language.
 *
 * Unknown keys return `fallback` when given, otherwise the key itself — never
 * `undefined`, so a missing translation degrades to something visible instead
 * of an empty button.
 */
export function localize(
  hass: Pick<HomeAssistant, 'language' | 'locale'> | undefined,
  key: LocalizeKey | string,
  fallback?: string,
  params?: LocalizeParams,
): string {
  const lang = resolveLanguage(hass);
  const table = TABLES[lang];
  const localised = table?.[key as LocalizeKey] ?? EN[key as LocalizeKey];
  if (typeof localised === 'string') return interpolate(localised, params);
  return interpolate(fallback ?? key, params);
}

/** Bind `hass` once — handy inside a lit render method. */
export function localizer(
  hass: Pick<HomeAssistant, 'language' | 'locale'> | undefined,
): (key: LocalizeKey | string, fallback?: string, params?: LocalizeParams) => string {
  return (key, fallback, params) => localize(hass, key, fallback, params);
}

export const SUPPORTED_LANGUAGES = Object.keys(TABLES);
