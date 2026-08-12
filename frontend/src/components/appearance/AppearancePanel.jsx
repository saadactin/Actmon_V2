import { useEffect, useState } from 'react';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Button from '@/components/ui/Button';
import { ColorPicker, Field, Section, Segmented, Select, Slider, Switch } from '@/components/ui/Field';
import { PAGE_SIZES } from '@/components/ui/Pagination';
import { useThemeStore, DEFAULT_APPEARANCE, normalizeFontScale } from '@/theme/themeStore';
import { CHART_PREFERENCES, useChartKindStore } from '@/components/charts/chartKinds';
import DashboardChartsSection from './DashboardChartsSection';
import { Tile, TileGrid, WIDE } from './Tile';
import {
  ACCENTS, CHART_PALETTES, CONTENT_WIDTHS, CONTRAST_LEVELS, DISPLAY_FONTS, DENSITIES,
  FONTS, FONT_SCALE_PRESETS, FONT_SCALE_MIN, FONT_SCALE_MAX, FONT_WEIGHTS, MONO_FONTS,
  MOTION_LEVELS, NAV_STYLES, RADII,
  SIDEBAR_POSITIONS, SIDEBAR_VARIANTS, SURFACE_STYLES, THEMES, TOPBAR_VARIANTS,
  HEADER_ANGLES, HEADER_GRADIENTS, HEADER_STYLES, HEADER_TEXTURES, HEADER_TEXTURE_LEVELS,
} from '@/theme/presets';

/**
 * "Scale" — a percentage of the 16px baseline, the same shape as an OS
 * display-scale setting (standard presets + a custom value). Shared by
 * Typography → Scale and Top Bar & Layout → Scale — one field, two entry
 * points, matching every other duplicated control in this file.
 */
function ScaleField() {
  const a = useThemeStore();
  const current = normalizeFontScale(a.fontSize);
  const isPreset = FONT_SCALE_PRESETS.includes(current);
  const [customOpen, setCustomOpen] = useState(!isPreset);
  const [customVal, setCustomVal] = useState(String(current));

  useEffect(() => {
    if (!customOpen) setCustomVal(String(current));
  }, [current, customOpen]);

  const applyCustom = () => {
    a.update({ fontSize: normalizeFontScale(customVal) });
  };

  return (
    <Field label="Scale" hint="Change the size of text, controls and layout across the entire application">
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
        {FONT_SCALE_PRESETS.map((p) => {
          const active = !customOpen && current === p;
          return (
            <button
              key={p}
              type="button"
              onClick={() => { setCustomOpen(false); a.update({ fontSize: p }); }}
              aria-pressed={active}
              className={cn(
                'rounded-control border bg-surface px-2 py-1.5 text-center text-[12px] font-semibold transition-colors',
                active ? 'border-accent-border bg-accent-soft text-accent-text' : 'border-border text-muted hover:border-strong hover:text-fg',
              )}
            >
              {p}%
              {p === 100 && <span className="block text-[9px] font-normal opacity-70">Recommended</span>}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setCustomOpen(true)}
          aria-pressed={customOpen}
          className={cn(
            'rounded-control border bg-surface px-2 py-1.5 text-center text-[12px] font-semibold transition-colors',
            customOpen ? 'border-accent-border bg-accent-soft text-accent-text' : 'border-border text-muted hover:border-strong hover:text-fg',
          )}
        >
          Custom…
        </button>
      </div>

      {customOpen && (
        <div className="mt-2.5 flex items-center gap-2">
          <Input
            type="number"
            min={FONT_SCALE_MIN}
            max={FONT_SCALE_MAX}
            value={customVal}
            onChange={(e) => setCustomVal(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applyCustom()}
            className="w-24"
          />
          <span className="text-[12px] text-subtle">% ({FONT_SCALE_MIN}–{FONT_SCALE_MAX})</span>
          <Button variant="secondary" size="sm" onClick={applyCustom}>Apply</Button>
        </div>
      )}
    </Field>
  );
}

/**
 * Every appearance control, one named export per section below.
 *
 * The default export (all 11, one long scroll) is what the quick drawer
 * (topbar palette icon) renders — unchanged. The Settings page instead picks
 * one named section at a time behind a tab strip (AppearanceSettingsSection.jsx),
 * the same sub-tab shape Notifications uses. Either way it's the same
 * components, so there is exactly ONE definition of what each control does —
 * adding one here surfaces it in both places.
 */
export default function AppearancePanel() {
  return (
    <div className="space-y-6">
      <ThemeSection />
      <ColourSection />
      <ChartsSection />
      <TypographySection />
      <ShapeSpacingSection />
      <DashboardChartsSection />
      <PageHeaderSection />
      <SidebarSection />
      <TopBarLayoutSection />
      <AccessibilitySection />
      <ConfigSection />
    </div>
  );
}

export function ThemeSection() {
  const a = useThemeStore();
  const set = a.update;
  return (
    <Section title="Theme" icon="sun">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {THEMES.map((t) => {
          const active = a.theme === t.id;
          const [bg, chrome, fg] = t.swatch;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => set({ theme: t.id })}
              aria-pressed={active}
              className={cn(
                'group relative overflow-hidden rounded-lg border text-left transition-all duration-150',
                active
                  ? 'border-accent shadow-[0_4px_16px_-4px_var(--accent)]'
                  : 'border-border hover:-translate-y-0.5 hover:border-strong hover:shadow-md',
              )}
            >
              {active && (
                <span className="absolute top-1.5 right-1.5 z-10 grid h-4 w-4 place-items-center rounded-full bg-accent text-accent-fg">
                  <Icon name="check" size={9} strokeWidth={3.5} />
                </span>
              )}
              {/* miniature mock-up of the theme's own colours — a chrome rail
                  plus fading "text" bars, not the live tokens — so each
                  option reads as a page, not just a flat colour chip. */}
              <div className="flex h-16" style={{ background: bg }}>
                <div className="flex w-6 shrink-0 flex-col items-center gap-1 pt-2" style={{ background: chrome }}>
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: fg, opacity: 0.55 }} />
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: fg, opacity: 0.3 }} />
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: fg, opacity: 0.3 }} />
                </div>
                <div className="flex flex-1 flex-col justify-center gap-1.5 px-2.5">
                  <span className="h-1.5 w-3/4 rounded-full" style={{ background: fg, opacity: 0.8 }} />
                  <span className="h-1.5 w-1/2 rounded-full" style={{ background: fg, opacity: 0.45 }} />
                  <span className="h-1.5 w-2/3 rounded-full" style={{ background: fg, opacity: 0.25 }} />
                </div>
              </div>
              <div className="truncate border-t border-border px-2.5 py-1.5 text-[11.5px] font-semibold text-fg">
                {t.label}
              </div>
            </button>
          );
        })}
      </div>
    </Section>
  );
}

export function ColourSection() {
  const a = useThemeStore();
  const set = a.update;
  return (
    <Section title="Colour" icon="palette">
      <TileGrid>
        <Tile>
          <Field label="Accent" hint="Drives buttons, links, highlights and chart series 1">
            <ColorPicker value={a.accent} onChange={(accent) => set({ accent })} presets={ACCENTS} />
          </Field>
        </Tile>

        <Tile className="sm:col-span-2">
          <Field label="Chart palette" hint="Series colours for every graph">
            <div className="grid gap-2.5 sm:grid-cols-2">
              {CHART_PALETTES.map((p) => {
                const active = a.chartPalette === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => set({ chartPalette: p.id })}
                    aria-pressed={active}
                    className={cn(
                      'relative flex flex-col gap-2.5 rounded-lg border bg-surface p-3 text-left transition-all duration-150',
                      active
                        ? 'border-accent bg-accent-soft shadow-[0_4px_16px_-4px_var(--accent)]'
                        : 'border-border hover:-translate-y-0.5 hover:border-strong hover:shadow-md',
                    )}
                  >
                    {active && (
                      <span className="absolute top-2.5 right-2.5 grid h-4 w-4 place-items-center rounded-full bg-accent text-accent-fg">
                        <Icon name="check" size={9} strokeWidth={3.5} />
                      </span>
                    )}
                    <span className="pr-6">
                      <span className="block text-[12.5px] font-bold text-fg">{p.label}</span>
                      <span className="mt-0.5 block text-[11px] text-subtle">{p.hint}</span>
                    </span>
                    <span className="flex gap-1">
                      {(p.light || []).map((c, i) => (
                        <span key={i} className="h-2.5 flex-1 rounded-full" style={{ background: c }} />
                      ))}
                    </span>
                  </button>
                );
              })}
            </div>
          </Field>
        </Tile>
      </TileGrid>
    </Section>
  );
}

const CHART_STYLE_ICONS = {
  recommended: 'sparkles', bar: 'chart-bar', column: 'chart-column', donut: 'chart-donut', pie: 'chart-pie',
};

export function ChartsSection() {
  const a = useThemeStore();
  const set = a.update;
  const resetChartKinds = useChartKindStore((s) => s.reset);
  return (
    <Section title="Charts" icon="chart-bar">
      <TileGrid>
        <Tile className={WIDE}>
          <Field
            label="Default chart style"
            hint="Applies wherever the form is valid — meters stay meters, since a percentage can't be a pie"
          >
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {CHART_PREFERENCES.map((c) => {
                const active = a.chartStyle === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => set({ chartStyle: c.id })}
                    aria-pressed={active}
                    title={c.hint}
                    className={cn(
                      'flex flex-col items-center gap-1.5 rounded-lg border bg-surface py-3 text-center transition-all duration-150',
                      active
                        ? 'border-accent bg-accent-soft text-accent-text shadow-[0_4px_16px_-4px_var(--accent)]'
                        : 'border-border text-muted hover:-translate-y-0.5 hover:border-strong hover:text-fg hover:shadow-md',
                    )}
                  >
                    <Icon name={CHART_STYLE_ICONS[c.id] || 'chart-bar'} size={17} />
                    <span className="text-[11px] font-semibold">{c.label}</span>
                  </button>
                );
              })}
            </div>
          </Field>
        </Tile>

        <Tile>
          <Field label="Per-chart choices" hint="Each chart card also has its own type picker in its header" inline>
            <button
              type="button"
              onClick={() => resetChartKinds()}
              className="inline-flex h-8 items-center gap-1.5 rounded-control border border-border px-2.5 text-[12px] font-semibold text-fg transition-colors hover:bg-surface"
            >
              <Icon name="refresh" size={13} />
              Clear all
            </button>
          </Field>
        </Tile>
      </TileGrid>
    </Section>
  );
}

export function TypographySection() {
  const a = useThemeStore();
  const set = a.update;
  return (
    <Section title="Typography" icon="type">
      <TileGrid>
        <Tile className={WIDE}>
          <Field label="Body font">
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
              {FONTS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => set({ font: f.id })}
                  title={f.hint}
                  aria-pressed={a.font === f.id}
                  className={cn(
                    'rounded-md border bg-surface px-2 py-1.5 text-left transition-colors',
                    a.font === f.id
                      ? 'border-accent-border bg-accent-soft'
                      : 'border-border hover:border-strong',
                  )}
                >
                  {/* preview in the actual stack so the choice is visible */}
                  <span
                    className="block truncate text-[13px] font-semibold text-fg"
                    style={{ fontFamily: f.sans }}
                  >
                    Aa
                  </span>
                  <span className="block truncate text-[10px] text-subtle">{f.label}</span>
                </button>
              ))}
            </div>
          </Field>
        </Tile>

        <Tile>
          <Field label="Heading font">
            <Select
              value={a.displayFont}
              onChange={(displayFont) => set({ displayFont })}
              options={DISPLAY_FONTS}
            />
          </Field>
        </Tile>

        <Tile>
          <Field label="Monospace font" hint="Used by logs, queries and the terminal">
            <Select value={a.monoFont} onChange={(monoFont) => set({ monoFont })} options={MONO_FONTS} />
          </Field>
        </Tile>

        <Tile className={WIDE}>
          <ScaleField />
        </Tile>

        <Tile>
          <Field label="Font weight">
            <Segmented
              columns={3}
              size="sm"
              value={a.fontWeight}
              onChange={(fontWeight) => set({ fontWeight })}
              options={FONT_WEIGHTS}
            />
          </Field>
        </Tile>
      </TileGrid>
    </Section>
  );
}

export function ShapeSpacingSection() {
  const a = useThemeStore();
  const set = a.update;
  return (
    <Section title="Shape & spacing" icon="layers">
      <TileGrid>
        <Tile className={WIDE}>
          <Field label="Corner roundness">
            <Segmented
              columns={5}
              size="sm"
              value={a.radius}
              onChange={(radius) => set({ radius })}
              options={RADII}
            />
          </Field>
        </Tile>

        <Tile>
          <Field label="Density" hint="Row heights, control sizes and padding">
            <Segmented
              columns={3}
              size="sm"
              value={a.density}
              onChange={(density) => set({ density })}
              options={DENSITIES}
            />
          </Field>
        </Tile>

        <Tile>
          <Field label="Card style">
            <Segmented
              columns={3}
              size="sm"
              value={a.surfaceStyle}
              onChange={(surfaceStyle) => set({ surfaceStyle })}
              options={SURFACE_STYLES}
            />
          </Field>
        </Tile>
      </TileGrid>
    </Section>
  );
}

export function PageHeaderSection() {
  const a = useThemeStore();
  const set = a.update;
  return (
    <Section title="Page header" icon="table">
      <TileGrid>
        <Tile>
          <Field label="Style" hint="The band at the top of every page">
            <Segmented
              columns={3}
              size="sm"
              value={a.headerStyle}
              onChange={(headerStyle) => set({ headerStyle })}
              options={HEADER_STYLES}
            />
          </Field>
        </Tile>

        {/* Off by default: the header — and the tab strip on the engine
            dashboards — stays put while a long page scrolls. */}
        <Tile>
          <Field
            label="Scroll with the page"
            hint={a.headerScroll
              ? 'The header scrolls away with the content'
              : 'The header stays pinned to the top while the page scrolls'}
            inline
          >
            <Switch
              checked={a.headerScroll}
              onChange={(headerScroll) => set({ headerScroll })}
              label="Header scrolls with the page"
            />
          </Field>
        </Tile>

        {a.headerStyle === 'solid' && (
          <Tile>
            <Field label="Header colour" hint="Text and controls inside flip automatically for contrast">
              <ColorPicker
                value={a.headerColor}
                onChange={(headerColor) => set({ headerColor })}
                presets={[
                  { id: 'ink', label: 'Ink', value: '#12182a' },
                  { id: 'slate', label: 'Slate', value: '#1e293b' },
                  { id: 'ocean', label: 'Ocean', value: '#0f2438' },
                  { id: 'teal', label: 'Teal', value: '#0f766e' },
                  { id: 'violet', label: 'Violet', value: '#4c1d95' },
                  { id: 'ember', label: 'Ember', value: '#7c2d12' },
                  { id: 'paper', label: 'Paper', value: '#f1f5f9' },
                  { id: 'white', label: 'White', value: '#ffffff' },
                ]}
              />
            </Field>
          </Tile>
        )}

        {a.headerStyle === 'gradient' && (
          <>
            <Tile>
              <Field label="Gradient">
                <div className="grid grid-cols-2 gap-1.5">
                  {HEADER_GRADIENTS.map((g) => {
                    const active = a.headerGradient === g.id;
                    // `pair: null` follows the accent, so preview it live.
                    const preview = g.pair
                      ? `linear-gradient(${a.headerAngle}, ${g.pair[0]}, ${g.pair[1]})`
                      : 'var(--gradient-accent)';
                    return (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => set({ headerGradient: g.id })}
                        aria-pressed={active}
                        className={cn(
                          'overflow-hidden rounded-md border bg-surface text-left transition-colors',
                          active ? 'border-accent-border ring-1 ring-[var(--accent-border)]' : 'border-border hover:border-strong',
                        )}
                      >
                        <span className="block h-6" style={{ background: preview }} />
                        <span className="block truncate px-2 py-1 text-[11px] font-semibold text-fg">{g.label}</span>
                      </button>
                    );
                  })}
                </div>
              </Field>
            </Tile>

            <Tile>
              <Field label="Direction">
                <Segmented
                  columns={4}
                  size="sm"
                  value={a.headerAngle}
                  onChange={(headerAngle) => set({ headerAngle })}
                  options={HEADER_ANGLES}
                />
              </Field>
            </Tile>
          </>
        )}

        {a.headerStyle !== 'plain' && (
          <>
            <Tile>
              <Field label="Texture" hint="A pattern laid over the header colour">
                <Segmented
                  columns={5}
                  size="sm"
                  value={a.headerTexture}
                  onChange={(headerTexture) => set({ headerTexture })}
                  options={HEADER_TEXTURES}
                />
              </Field>
            </Tile>

            {a.headerTexture !== 'none' && (
              <Tile>
                <Field label="Texture strength">
                  <Segmented
                    columns={3}
                    size="sm"
                    value={a.headerTextureLevel}
                    onChange={(headerTextureLevel) => set({ headerTextureLevel })}
                    options={HEADER_TEXTURE_LEVELS}
                  />
                </Field>
              </Tile>
            )}

            {/* live preview, drawn with the very tokens the header uses */}
            <Tile className={WIDE}>
              <p className="mb-2 text-[12px] font-semibold text-fg">Preview</p>
              <div
                className="relative overflow-hidden rounded-card px-3 py-2.5"
                style={{
                  background: 'var(--header-bg)',
                  backgroundImage: 'var(--header-bg-image)',
                  color: 'var(--header-fg)',
                }}
              >
                <span
                  className="pointer-events-none absolute inset-0"
                  style={{
                    backgroundImage: 'var(--header-texture)',
                    backgroundSize: 'var(--header-texture-size)',
                    opacity: 'var(--header-texture-opacity)',
                    color: 'var(--header-fg)',
                  }}
                />
                <span className="relative block text-[13px] font-bold">Page title</span>
                <span className="relative block text-[11px]" style={{ color: 'var(--header-fg-muted)' }}>
                  Preview of the header surface
                </span>
              </div>
            </Tile>
          </>
        )}
      </TileGrid>
    </Section>
  );
}

export function SidebarSection() {
  const a = useThemeStore();
  const set = a.update;
  return (
    <Section title="Sidebar" icon="rows">
      <TileGrid>
        <Tile>
          <Field label="Style">
            <Segmented
              columns={3}
              size="sm"
              value={a.sidebarVariant}
              onChange={(sidebarVariant) => set({ sidebarVariant })}
              options={SIDEBAR_VARIANTS}
            />
          </Field>
        </Tile>

        {a.sidebarVariant === 'custom' && (
          <Tile>
            <Field label="Sidebar colour">
              <ColorPicker
                value={a.sidebarColor}
                onChange={(sidebarColor) => set({ sidebarColor })}
                presets={[
                  { id: 'ink', label: 'Ink', value: '#12182a' },
                  { id: 'slate', label: 'Slate', value: '#1e293b' },
                  { id: 'ocean', label: 'Ocean', value: '#0f2438' },
                  { id: 'forest', label: 'Forest', value: '#12291f' },
                  { id: 'plum', label: 'Plum', value: '#241a2e' },
                  { id: 'white', label: 'White', value: '#ffffff' },
                  { id: 'paper', label: 'Paper', value: '#f5f2ec' },
                ]}
              />
            </Field>
          </Tile>
        )}

        <Tile>
          <Field label="Nav item style">
            <Segmented
              columns={4}
              size="sm"
              value={a.navStyle}
              onChange={(navStyle) => set({ navStyle })}
              options={NAV_STYLES}
            />
          </Field>
        </Tile>

        <Tile>
          <Field label="Position">
            <Segmented
              columns={2}
              size="sm"
              value={a.sidebarPosition}
              onChange={(sidebarPosition) => set({ sidebarPosition })}
              options={SIDEBAR_POSITIONS}
            />
          </Field>
        </Tile>

        <Tile>
          <Field label="Width">
            <Slider
              value={a.sidebarWidth}
              onChange={(sidebarWidth) => set({ sidebarWidth })}
              min={200}
              max={340}
              step={4}
              suffix="px"
            />
          </Field>
        </Tile>

        <Tile>
          <Field label="Show menu names" hint="Off gives an icon-only rail" inline>
            <Switch
              checked={a.showNavLabels}
              onChange={(showNavLabels) => set({ showNavLabels })}
              label="Show menu names"
            />
          </Field>
        </Tile>
      </TileGrid>
    </Section>
  );
}

export function TopBarLayoutSection() {
  const a = useThemeStore();
  const set = a.update;
  return (
    <Section title="Top bar & layout" icon="table">
      <TileGrid>
        <Tile>
          <Field label="Top bar style">
            <Segmented
              columns={3}
              size="sm"
              value={a.topbarVariant}
              onChange={(topbarVariant) => set({ topbarVariant })}
              options={TOPBAR_VARIANTS}
            />
          </Field>
        </Tile>

        {a.topbarVariant === 'custom' && (
          <Tile>
            <Field label="Top bar colour">
              <ColorPicker
                value={a.topbarColor}
                onChange={(topbarColor) => set({ topbarColor })}
                presets={[
                  { id: 'white', label: 'White', value: '#ffffff' },
                  { id: 'ink', label: 'Ink', value: '#12182a' },
                  { id: 'slate', label: 'Slate', value: '#1e293b' },
                  { id: 'sand', label: 'Sand', value: '#f3efe7' },
                ]}
              />
            </Field>
          </Tile>
        )}

        <Tile>
          <Field label="Content width">
            <Segmented
              columns={2}
              size="sm"
              value={a.contentWidth}
              onChange={(contentWidth) => set({ contentWidth })}
              options={CONTENT_WIDTHS}
            />
          </Field>
        </Tile>

        {/* Same setting as Typography → Scale — one value, two entry points,
            since it's as much a layout concern (how much fits on screen) as
            a text one. */}
        <Tile className={WIDE}>
          <ScaleField />
        </Tile>

        <Tile>
          <Field label="Sticky top bar" inline>
            <Switch checked={a.stickyTopbar} onChange={(stickyTopbar) => set({ stickyTopbar })} label="Sticky top bar" />
          </Field>
        </Tile>

        <Tile>
          <Field label="Show breadcrumbs" inline>
            <Switch
              checked={a.showBreadcrumbs}
              onChange={(showBreadcrumbs) => set({ showBreadcrumbs })}
              label="Show breadcrumbs"
            />
          </Field>
        </Tile>

        {/* One default for every paged list. A single list's pager can still be
            set higher for the session without changing this. */}
        <Tile className={WIDE}>
          <Field label="Rows per page" hint="Applies to every list; “All” turns paging off">
            <Segmented
              columns={5}
              size="sm"
              value={String(a.rowsPerPage)}
              onChange={(rowsPerPage) => set({ rowsPerPage })}
              options={PAGE_SIZES}
            />
          </Field>
        </Tile>
      </TileGrid>
    </Section>
  );
}

export function AccessibilitySection() {
  const a = useThemeStore();
  const set = a.update;
  return (
    <Section title="Accessibility" icon="eye">
      <TileGrid>
        <Tile>
          <Field label="Contrast">
            <Segmented
              columns={2}
              size="sm"
              value={a.contrast}
              onChange={(contrast) => set({ contrast })}
              options={CONTRAST_LEVELS}
            />
          </Field>
        </Tile>

        <Tile>
          <Field label="Animation">
            <Segmented
              columns={3}
              size="sm"
              value={a.motion}
              onChange={(motion) => set({ motion })}
              options={MOTION_LEVELS}
            />
          </Field>
        </Tile>
      </TileGrid>
    </Section>
  );
}

export function ConfigSection() {
  const a = useThemeStore();
  return (
    <Section title="Configuration" icon="save">
      <TileGrid>
        <Tile className={WIDE}>
          <p className="text-[12px] leading-relaxed text-muted">
            Appearance is stored per browser under
            {' '}
            <code className="rounded-xs bg-surface px-1 py-px font-mono text-[11px]">actmon.appearance</code>.
            Copy it to share a look, or paste one in to adopt it.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(JSON.stringify(a.export(), null, 2))}
              className="h-8 flex-1 rounded-control border border-border bg-surface text-[12px] font-semibold text-fg transition-colors hover:bg-raised"
            >
              Copy config
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  a.import(JSON.parse(await navigator.clipboard.readText()));
                } catch {
                  /* clipboard blocked or not JSON — leave the current look alone */
                }
              }}
              className="h-8 flex-1 rounded-control border border-border bg-surface text-[12px] font-semibold text-fg transition-colors hover:bg-raised"
            >
              Paste config
            </button>
          </div>
          <p className="mt-3 text-[11px] text-subtle">
            Defaults: {DEFAULT_APPEARANCE.theme} theme, {DEFAULT_APPEARANCE.density} density,
            {' '}{DEFAULT_APPEARANCE.sidebarVariant} sidebar.
          </p>
        </Tile>
      </TileGrid>
    </Section>
  );
}
