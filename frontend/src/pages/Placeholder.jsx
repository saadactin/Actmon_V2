import { useLocation } from 'react-router-dom';
import PageHeader from '@/components/layout/PageHeader';
import Icon from '@/components/ui/Icon';
import Badge from '@/components/ui/Badge';
import ActmonAiMark from '@/components/brand/ActmonAiMark';
import { NAV_INDEX } from '@/config/navigation';

/**
 * Full-colour marks a module can claim via `mark` in config/navigation.js.
 * Keyed rather than imported per-route so this page never learns about routes.
 */
const MARKS = {
  'actmon-ai': (size, glow) => <ActmonAiMark size={size} glow={glow} />,
};

/**
 * Stand-in for routes that exist in the nav but haven't been built yet.
 * Keeps navigation honest while pages land one at a time.
 */
export default function Placeholder({ title, icon, description }) {
  const { pathname } = useLocation();
  const hit = NAV_INDEX.find((n) => n.to === pathname);

  const heading = title || hit?.label || 'Page';
  const glyph = icon || hit?.icon || 'boxes';
  const mark = MARKS[hit?.mark];

  return (
    <>
      <PageHeader
        title={heading}
        icon={glyph}
        leading={mark ? mark(40, false) : undefined}
        description={description || 'This module is not built yet in the new frontend.'}
        actions={<Badge tone="warning">Not implemented</Badge>}
      />

      <div className="card grid place-items-center gap-3 p-10 text-center">
        {mark ? mark(80, true) : (
          <div className="grid h-12 w-12 place-items-center rounded-full bg-sunken text-subtle">
            <Icon name={glyph} size={24} />
          </div>
        )}
        <div>
          <p className="text-sm font-semibold text-fg">{heading} coming next</p>
          <p className="mt-1 text-[13px] text-muted">
            The shell, navigation and theming are ready — pages get built on top of them.
          </p>
        </div>
        <code className="rounded-sm bg-sunken px-2 py-1 font-mono text-[11px] text-subtle">{pathname}</code>
      </div>
    </>
  );
}
