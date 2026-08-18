import { useEffect, useState } from 'react';
import PageHeader from '@/components/layout/PageHeader';
import Icon from '@/components/ui/Icon';
import Button from '@/components/ui/Button';
import Tabs from '@/components/ui/Tabs';
import Dialog from '@/components/ui/Dialog';
import { Field, Section, Segmented, Slider, ColorPicker, Switch, Select } from '@/components/ui/Field';
import { Tile, TileGrid, WIDE } from '@/components/appearance/Tile';
import Input from '@/components/ui/Input';
import { useHelpAppearance } from '@/pages/help/appearance/HelpAppearanceContext';
import { DEFAULT_CONFIG, PRESETS, PRESET_LABELS } from '@/pages/help/appearance/helpAppearanceConfig';
import { buildHelpAppearanceVars } from '@/pages/help/appearance/applyHelpAppearance';
import DocumentationCard from '@/pages/help/appearance/DocumentationCard';
import '@/pages/help/appearance/helpCards.css';

function setNested(obj, path, value) {
  const [head, ...rest] = path;
  if (rest.length === 0) return { ...obj, [head]: value };
  return { ...obj, [head]: setNested(obj[head] || {}, rest, value) };
}

const CATEGORY_LABELS = {
  'gs': 'Getting Started', 'mod-dashboard': 'Dashboard', 'mod-agents': 'Agents',
  'mod-databases': 'Database', 'mod-cloud': 'Cloud', 'mod-infrastructure': 'Infrastructure',
  'mod-alerts': 'Alerts', 'mod-ai': 'AI Assistant', 'mod-administration': 'Administration',
  'mod-settings': 'Settings', 'mod-sales': 'Sales',
};
const ENGINE_LABELS = {
  postgresql: 'PostgreSQL', mysql: 'MySQL / MariaDB', oracle: 'Oracle', mssql: 'SQL Server',
  mongodb: 'MongoDB', clickhouse: 'ClickHouse', cosmosdb: 'Cosmos DB', fundamentals: 'Database Fundamentals',
};

const TABS = [
  { id: 'appearance', label: 'Appearance', icon: 'sun' },
  { id: 'cards', label: 'Cards', icon: 'layers' },
  { id: 'colors', label: 'Colors', icon: 'palette' },
  { id: 'layout', label: 'Layout', icon: 'table' },
  { id: 'typography', label: 'Typography', icon: 'type' },
  { id: 'sidebar', label: 'Sidebar', icon: 'rows' },
  { id: 'images', label: 'Images', icon: 'folder' },
  { id: 'advanced', label: 'Advanced', icon: 'settings' },
];

/**
 * Admin-only "Help Center Appearance" configuration — a dedicated
 * Administration hub page (not a SettingsPage tab: that page's own
 * "Appearance" tab is per-browser/localStorage/zero-permission, the
 * opposite of this feature on every axis). Edits a local DRAFT seeded from
 * the live singleton config; Save/Cancel/Reset are the only things that
 * touch the backend (via useHelpAppearance()). The live preview renders
 * real card components under an ISOLATED set of `--hc-*` variables scoped
 * to its own container only — never the app's real root — so unsaved edits
 * never leak into any other open tab/page (see LivePreviewPanel below).
 */
export default function HelpCenterAppearancePage() {
  const { config, loading, saving, save, reset } = useHelpAppearance();
  const [tab, setTab] = useState('appearance');
  const [draft, setDraft] = useState(config);
  const [confirmReset, setConfirmReset] = useState(false);
  const [toast, setToast] = useState(null);

  useEffect(() => { if (!loading) setDraft(config); }, [loading, config]);

  const set = (path, value) => setDraft((d) => setNested(d, path, value));

  const handleSave = () => {
    save(draft)
      .then(() => setToast({ tone: 'success', text: 'Help Center appearance saved.' }))
      .catch(() => setToast({ tone: 'danger', text: 'Save failed — check your permissions and try again.' }));
  };
  const handleCancel = () => setDraft(config);
  const handleReset = () => {
    setConfirmReset(false);
    reset().then(() => setToast({ tone: 'success', text: 'Reset to default appearance.' }));
  };

  const Active = { appearance: AppearanceTab, cards: CardsTab, colors: ColorsTab, layout: LayoutTab,
    typography: TypographyTab, sidebar: SidebarTab, images: ImagesTab, advanced: AdvancedTab }[tab];

  return (
    <div className="space-y-gutter">
      <PageHeader
        title="Help Center Appearance"
        description="Card themes, colors, sizing, and layout for the documentation library — changes apply everywhere, no restart needed."
        icon="palette"
        backTo="/administration"
        actions={(
          <div className="flex items-center gap-2">
            {toast && (
              <span className={`text-[12px] font-medium ${toast.tone === 'danger' ? 'text-danger' : 'text-success-fg'}`}>
                {toast.text}
              </span>
            )}
            <Button variant="ghost" icon="refresh" onClick={() => setConfirmReset(true)}>Reset to Default</Button>
            <Button variant="secondary" onClick={handleCancel}>Cancel</Button>
            <Button variant="primary" loading={saving} onClick={handleSave}>Save Changes</Button>
          </div>
        )}
      />

      <div className="grid grid-cols-1 gap-gutter xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-gutter">
          <Tabs tabs={TABS} value={tab} onChange={setTab} />
          <section className="card p-card">
            <Active draft={draft} set={set} />
          </section>
        </div>
        <div className="xl:sticky xl:top-4 xl:self-start">
          <LivePreviewPanel config={draft} />
        </div>
      </div>

      <Dialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Reset to default appearance?"
        subtitle="This removes every saved customization. The Help Center reverts to the Soft Enterprise / Pastel default for everyone."
        footer={(
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmReset(false)}>Cancel</Button>
            <Button variant="danger" onClick={handleReset}>Reset to Default</Button>
          </div>
        )}
      />
    </div>
  );
}

/** Renders the SAME real `DocumentationCard` every Help Center page uses,
 * fed the unsaved DRAFT config as an explicit prop override rather than
 * reading it from context — that's what keeps this preview isolated: the
 * card's own `--hc-*` vars come from `buildHelpAppearanceVars(draft)` set as
 * inline style on THIS container only, never on `document.documentElement`
 * or the real Help Center root, so editing here can't affect any other open
 * Help Center tab. */
function LivePreviewPanel({ config }) {
  const vars = buildHelpAppearanceVars(config);
  const dashboardHue = config.categoryColors['mod-dashboard'] || DEFAULT_CONFIG.categoryColors['mod-dashboard'];
  const pgHue = config.engineColors.postgresql || DEFAULT_CONFIG.engineColors.postgresql;

  return (
    <div className="card p-card space-y-3" style={vars} data-hc-preview="true">
      <div className="flex items-center gap-1.5 text-[11px] font-bold tracking-[0.06em] text-subtle uppercase">
        <Icon name="eye" size={12} /> Live Preview
      </div>
      <div className="hc-grid" style={{ gridTemplateColumns: 'repeat(1, 1fr)' }}>
        <DocumentationCard
          config={config}
          image="/help-images/dashboard-module.jpg"
          hue={dashboardHue}
          icon="dashboard"
          title="Dashboard"
          meta="12 topics"
          description="Real-time metrics, gauges, and health across every connected system."
          footerRight="Explore"
        />
        <DocumentationCard
          config={config}
          hue={dashboardHue}
          icon="report"
          title="Alerting Basics"
          description="How thresholds, streaks, and notification channels work together."
          footerLeft="Article"
          footerRight="Read article"
        />
        <DocumentationCard
          config={config}
          image="/help-images/postgresql-engine.png"
          hue={pgHue}
          title="PostgreSQL"
          description="Performance, queries, locks, and replication monitoring."
          features={['Performance & query analysis', 'Replication & Patroni HA']}
          footerLeft="6 topics"
          footerRight="Explore"
        />
      </div>
    </div>
  );
}

/* ── Appearance tab — theme presets + light/dark/system ─────────────────── */
function AppearanceTab({ draft, set }) {
  return (
    <div className="space-y-5">
      <Section title="Theme">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Object.keys(PRESETS).map((key) => {
            const active = draft.preset === key;
            const rough = !['softEnterprise', 'enterprise', 'minimal'].includes(key);
            return (
              <button
                key={key}
                type="button"
                onClick={() => set(['preset'], key)}
                aria-pressed={active}
                className={`relative flex flex-col gap-1 rounded-lg border p-3.5 text-left transition-all duration-150 ${
                  active ? 'border-accent bg-accent-soft shadow-[0_4px_16px_-4px_var(--accent)]' : 'border-border bg-surface hover:-translate-y-0.5 hover:border-strong'
                }`}
              >
                {active && (
                  <span className="absolute top-2.5 right-2.5 grid h-4 w-4 place-items-center rounded-full bg-accent text-accent-fg">
                    <Icon name="check" size={9} strokeWidth={3.5} />
                  </span>
                )}
                <span className="text-[12.5px] font-bold text-fg">{PRESET_LABELS[key]}</span>
                {rough && <span className="text-[10.5px] text-subtle italic">Rough — refined in a later pass</span>}
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Mode">
        <Segmented
          options={[{ id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }, { id: 'system', label: 'System' }]}
          value={draft.mode}
          onChange={(v) => set(['mode'], v)}
        />
      </Section>
    </div>
  );
}

/* ── Cards tab — size, radius, shadow, border ────────────────────────────── */
function CardsTab({ draft, set }) {
  return (
    <div className="space-y-5">
      <Section title="Card size">
        <Segmented
          options={[{ id: 'small', label: 'Small' }, { id: 'medium', label: 'Medium' }, { id: 'large', label: 'Large' }, { id: 'xl', label: 'Extra Large' }, { id: 'custom', label: 'Custom' }]}
          value={draft.cardSize.preset}
          onChange={(v) => set(['cardSize', 'preset'], v)}
          columns={5}
          size="sm"
        />
        {draft.cardSize.preset === 'custom' && (
          <TileGrid>
            <Tile><Field label="Card width (px, blank = auto)"><Input type="number" value={draft.cardSize.custom.width || ''} onChange={(e) => set(['cardSize', 'custom', 'width'], e.target.value ? Number(e.target.value) : null)} placeholder="auto" /></Field></Tile>
            <Tile><Field label="Minimum height (px)"><Slider value={draft.cardSize.custom.minHeight} min={140} max={480} onChange={(v) => set(['cardSize', 'custom', 'minHeight'], v)} suffix="px" /></Field></Tile>
            <Tile><Field label="Padding (px)"><Slider value={draft.cardSize.custom.padding} min={8} max={40} onChange={(v) => set(['cardSize', 'custom', 'padding'], v)} suffix="px" /></Field></Tile>
            <Tile><Field label="Gap (px)"><Slider value={draft.cardSize.custom.gap} min={4} max={40} onChange={(v) => set(['cardSize', 'custom', 'gap'], v)} suffix="px" /></Field></Tile>
          </TileGrid>
        )}
      </Section>

      <Section title="Radius">
        <Segmented
          options={[{ id: 'none', label: 'None' }, { id: 'sm', label: 'Small' }, { id: 'md', label: 'Medium' }, { id: 'lg', label: 'Large' }, { id: 'xl', label: 'Extra Large' }, { id: 'custom', label: 'Custom' }]}
          value={draft.radius.preset}
          onChange={(v) => set(['radius', 'preset'], v)}
          columns={6}
          size="sm"
        />
        {draft.radius.preset === 'custom' && (
          <Field label="Custom radius (px)"><Slider value={draft.radius.customPx || 0} min={0} max={32} onChange={(v) => set(['radius', 'customPx'], v)} suffix="px" /></Field>
        )}
      </Section>

      <Section title="Shadow">
        <Segmented
          options={[{ id: 'none', label: 'None' }, { id: 'sm', label: 'Subtle' }, { id: 'md', label: 'Medium' }, { id: 'lg', label: 'Strong' }]}
          value={draft.shadow.preset}
          onChange={(v) => set(['shadow', 'preset'], v)}
          columns={4}
          size="sm"
        />
      </Section>

      <Section title="Border">
        <TileGrid>
          <Tile><Field label="Border" inline><Switch checked={draft.border.enabled} onChange={(v) => set(['border', 'enabled'], v)} /></Field></Tile>
          <Tile><Field label="Width (px)"><Slider value={draft.border.widthPx} min={1} max={4} onChange={(v) => set(['border', 'widthPx'], v)} suffix="px" /></Field></Tile>
          <Tile><Field label="Opacity"><Slider value={Math.round(draft.border.opacity * 100)} min={10} max={100} step={5} onChange={(v) => set(['border', 'opacity'], v / 100)} suffix="%" /></Field></Tile>
          <Tile>
            <Field label="Style">
              <Select
                value={draft.border.style}
                onChange={(v) => set(['border', 'style'], v)}
                options={[{ id: 'solid', label: 'Solid' }, { id: 'dashed', label: 'Dashed' }]}
              />
            </Field>
          </Tile>
        </TileGrid>
      </Section>
    </div>
  );
}

/* ── Colors tab — global accents + per-category + per-engine ────────────── */
function ColorsTab({ draft, set }) {
  return (
    <div className="space-y-5">
      <Section title="Card appearance">
        <TileGrid>
          <Tile><Field label="Primary color"><ColorPicker value={draft.colors.primaryAccent} onChange={(v) => set(['colors', 'primaryAccent'], v)} /></Field></Tile>
          <Tile><Field label="Secondary color"><ColorPicker value={draft.colors.secondaryAccent} onChange={(v) => set(['colors', 'secondaryAccent'], v)} /></Field></Tile>
          <Tile><Field label="Card background" hint="Blank = inherit theme surface"><ColorPicker value={draft.colors.cardBg || ''} onChange={(v) => set(['colors', 'cardBg'], v || null)} /></Field></Tile>
          <Tile><Field label="Card border" hint="Blank = inherit theme border"><ColorPicker value={draft.colors.cardBorder || ''} onChange={(v) => set(['colors', 'cardBorder'], v || null)} /></Field></Tile>
          <Tile><Field label="Icon background" hint="Blank = tint from category color"><ColorPicker value={draft.colors.iconBg || ''} onChange={(v) => set(['colors', 'iconBg'], v || null)} /></Field></Tile>
          <Tile><Field label="Icon color" hint="Blank = category color"><ColorPicker value={draft.colors.iconColor || ''} onChange={(v) => set(['colors', 'iconColor'], v || null)} /></Field></Tile>
          <Tile><Field label="Hover background"><ColorPicker value={draft.colors.hoverBg || ''} onChange={(v) => set(['colors', 'hoverBg'], v || null)} /></Field></Tile>
          <Tile><Field label="Hover border"><ColorPicker value={draft.colors.hoverBorder || ''} onChange={(v) => set(['colors', 'hoverBorder'], v || null)} /></Field></Tile>
        </TileGrid>
      </Section>

      <Section title="Category colors">
        <TileGrid>
          {Object.keys(DEFAULT_CONFIG.categoryColors).map((id) => (
            <Tile key={id}>
              <Field label={CATEGORY_LABELS[id] || id}>
                <ColorPicker value={draft.categoryColors[id] || DEFAULT_CONFIG.categoryColors[id]} onChange={(v) => set(['categoryColors', id], v)} />
              </Field>
            </Tile>
          ))}
        </TileGrid>
      </Section>

      <Section title="Database engine colors">
        <TileGrid>
          {Object.keys(DEFAULT_CONFIG.engineColors).map((slug) => (
            <Tile key={slug}>
              <Field label={ENGINE_LABELS[slug] || slug}>
                <ColorPicker value={draft.engineColors[slug] || DEFAULT_CONFIG.engineColors[slug]} onChange={(v) => set(['engineColors', slug], v)} />
              </Field>
            </Tile>
          ))}
        </TileGrid>
      </Section>
    </div>
  );
}

/* ── Layout tab — grid columns + content width ───────────────────────────── */
function LayoutTab({ draft, set }) {
  return (
    <div className="space-y-5">
      <Section title="Grid columns">
        <TileGrid>
          <Tile><Field label="Desktop"><Slider value={draft.grid.desktopColumns} min={1} max={5} onChange={(v) => set(['grid', 'desktopColumns'], v)} /></Field></Tile>
          <Tile><Field label="Tablet"><Slider value={draft.grid.tabletColumns} min={1} max={4} onChange={(v) => set(['grid', 'tabletColumns'], v)} /></Field></Tile>
          <Tile><Field label="Mobile"><Slider value={draft.grid.mobileColumns} min={1} max={2} onChange={(v) => set(['grid', 'mobileColumns'], v)} /></Field></Tile>
          <Tile>
            <Field label="Auto-fit" hint="Phase 2 — columns auto-determined by width" inline>
              <Switch checked={draft.grid.autoFit} onChange={(v) => set(['grid', 'autoFit'], v)} disabled />
            </Field>
          </Tile>
        </TileGrid>
      </Section>

      <Section title="Page content width">
        <Segmented
          options={[{ id: 'narrow', label: 'Compact' }, { id: 'default', label: 'Standard' }, { id: 'wide', label: 'Wide' }, { id: 'full', label: 'Full Width' }]}
          value={draft.contentWidth}
          onChange={(v) => set(['contentWidth'], v)}
          columns={4}
          size="sm"
        />
      </Section>
    </div>
  );
}

/* ── Remaining tabs — plain, functional forms (Phase 2: grouped-accordion
   polish + inline help text is deferred; every field here already works). */
function TypographyTab({ draft, set }) {
  const t = draft.typography;
  const rows = [
    ['bodySize', 'Body text', 12, 20],
    ['cardTitleSize', 'Card title', 14, 28],
    ['descriptionSize', 'Card description', 12, 20],
    ['footerSize', 'Card footer', 10, 18],
    ['sectionHeadingSize', 'Section heading', 16, 32],
    ['pageHeadingSize', 'Page heading', 22, 48],
  ];
  return (
    <div className="space-y-5">
      <Section title="Typography">
        <TileGrid>
          {rows.map(([key, label, min, max]) => (
            <Tile key={key}><Field label={label}><Slider value={t[key]} min={min} max={max} onChange={(v) => set(['typography', key], v)} suffix="px" /></Field></Tile>
          ))}
          <Tile><Field label="Line height"><Slider value={t.lineHeight} min={1.1} max={2} step={0.05} onChange={(v) => set(['typography', 'lineHeight'], v)} /></Field></Tile>
        </TileGrid>
      </Section>
    </div>
  );
}

function SidebarTab({ draft, set }) {
  const s = draft.sidebar;
  return (
    <div className="space-y-5">
      <Section title="Sidebar">
        <TileGrid>
          <Tile><Field label="Width (px)"><Slider value={s.width} min={220} max={450} onChange={(v) => set(['sidebar', 'width'], v)} suffix="px" /></Field></Tile>
          <Tile><Field label="Collapsed width (px)"><Slider value={s.collapsedWidth} min={40} max={80} onChange={(v) => set(['sidebar', 'collapsedWidth'], v)} suffix="px" /></Field></Tile>
          <Tile><Field label="Background" hint="Blank = inherit theme surface"><ColorPicker value={s.bg || ''} onChange={(v) => set(['sidebar', 'bg'], v || null)} /></Field></Tile>
          <Tile><Field label="Border" hint="Blank = inherit theme border"><ColorPicker value={s.border || ''} onChange={(v) => set(['sidebar', 'border'], v || null)} /></Field></Tile>
          <Tile><Field label="Text size (px)"><Slider value={s.textSize} min={11} max={18} onChange={(v) => set(['sidebar', 'textSize'], v)} suffix="px" /></Field></Tile>
          <Tile><Field label="Heading size (px)"><Slider value={s.headingSize} min={9} max={14} onChange={(v) => set(['sidebar', 'headingSize'], v)} suffix="px" /></Field></Tile>
          <Tile><Field label="Item spacing (px)"><Slider value={s.itemSpacing} min={0} max={8} onChange={(v) => set(['sidebar', 'itemSpacing'], v)} suffix="px" /></Field></Tile>
          <Tile><Field label="Active color" hint="Blank = theme accent"><ColorPicker value={s.activeColor || ''} onChange={(v) => set(['sidebar', 'activeColor'], v || null)} /></Field></Tile>
          <Tile><Field label="Hover color" hint="Blank = theme accent"><ColorPicker value={s.hoverColor || ''} onChange={(v) => set(['sidebar', 'hoverColor'], v || null)} /></Field></Tile>
        </TileGrid>
      </Section>
    </div>
  );
}

function ImagesTab({ draft, set }) {
  const img = draft.image;
  return (
    <div className="space-y-5">
      <Section title="Image / logo" >
        <p className="mb-2 text-[11.5px] text-subtle">
          Every card image is full card width, edge-to-edge, at this one height — this is what keeps the PostgreSQL/MySQL/Oracle/etc. engine logos a consistent size, regardless of each source image's own dimensions.
        </p>
        <TileGrid>
          <Tile><Field label="Header height (px)"><Slider value={img.headerHeight} min={80} max={260} onChange={(v) => set(['image', 'headerHeight'], v)} suffix="px" /></Field></Tile>
          <Tile>
            <Field label="Object fit" hint="Cover fills the space, cropping if needed — no distortion, no empty space">
              <Select
                value={img.objectFit}
                onChange={(v) => set(['image', 'objectFit'], v)}
                options={[{ id: 'cover', label: 'Cover' }, { id: 'contain', label: 'Contain' }]}
              />
            </Field>
          </Tile>
          <Tile><Field label="Image radius (px)"><Slider value={img.radius} min={0} max={24} onChange={(v) => set(['image', 'radius'], v)} suffix="px" /></Field></Tile>
          <Tile><Field label="Container background"><ColorPicker value={img.containerBg} onChange={(v) => set(['image', 'containerBg'], v)} /></Field></Tile>
        </TileGrid>
      </Section>
    </div>
  );
}

function AdvancedTab({ draft, set }) {
  return (
    <div className="space-y-5">
      <Section title="Backgrounds" >
        <TileGrid>
          <Tile><Field label="Page background" hint="Blank = theme default"><ColorPicker value={draft.pageBg || ''} onChange={(v) => set(['pageBg'], v || null)} /></Field></Tile>
          <Tile><Field label="Content background" hint="Blank = theme default"><ColorPicker value={draft.contentBg || ''} onChange={(v) => set(['contentBg'], v || null)} /></Field></Tile>
          <Tile><Field label="Header background" hint="Blank = theme default"><ColorPicker value={draft.headerBg || ''} onChange={(v) => set(['headerBg'], v || null)} /></Field></Tile>
        </TileGrid>
      </Section>

      <Section title="Custom overrides">
        <TileGrid>
          <Tile className={WIDE}>
            <Field label="Custom shadow (raw CSS box-shadow)" hint="Only used when Cards → Shadow is set to a custom value in a future pass">
              <Input type="text" wrapperClassName="w-full" value={draft.shadow.custom || ''} onChange={(e) => set(['shadow', 'custom'], e.target.value || null)} placeholder="0 4px 12px rgba(0,0,0,0.1)" />
            </Field>
          </Tile>
        </TileGrid>
      </Section>
    </div>
  );
}
