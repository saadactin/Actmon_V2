import PageHeader from '@/components/layout/PageHeader';

/**
 * PageHeader pre-wired with the Cloud module's default icon, so every Cloud
 * page builds its header from the same shared component (title/description/
 * actions vary per page, same shape everywhere) instead of hand-rolling its
 * own hero — mirrors how DatabaseServersPage calls the shared PageHeader
 * with different props per screen rather than drawing its own chrome.
 */
export default function CloudPageHeader({ icon, leading, ...props }) {
  return <PageHeader icon={leading ? undefined : (icon || 'cloud')} leading={leading} {...props} />;
}
