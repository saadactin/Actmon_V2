import { useState } from 'react';
import Icon from '@/components/ui/Icon';
import Button from '@/components/ui/Button';
import PasswordPrompt from '@/components/ui/PasswordPrompt';
import { useChatStore } from '@/store/chatStore';

/**
 * Inline chat card for an action ActMon AI has proposed (restart a service, kill a
 * process, reboot a host, acknowledge alerts, …) but is never allowed to run on its
 * own initiative. Confirm re-uses the app's one password re-auth modal — the same
 * component the Infra page's own action buttons already use — so a chat-triggered
 * action gets exactly the same re-auth UX and, server-side, the same RBAC check and
 * service function as clicking the button on the page itself would.
 */
export default function ActionProposalCard({ messageId, proposal }) {
  const confirmAction = useChatStore((s) => s.confirmAction);
  const cancelAction = useChatStore((s) => s.cancelAction);
  const [showPrompt, setShowPrompt] = useState(false);

  return (
    <div className="mt-2 rounded-control border border-border bg-surface p-2.5">
      <div className="flex items-start gap-2">
        <Icon name="alert" size={15} className="mt-0.5 shrink-0 text-warning-fg" />
        <p className="text-[12px] leading-relaxed text-fg">{proposal.summary}</p>
      </div>
      <div className="mt-2 flex justify-end gap-1.5">
        <Button variant="secondary" size="sm" onClick={() => cancelAction(messageId)}>Cancel</Button>
        <Button variant="danger" size="sm" icon="check" onClick={() => setShowPrompt(true)}>Confirm</Button>
      </div>
      {showPrompt && (
        <PasswordPrompt
          title={proposal.summary}
          confirmLabel="Run it"
          danger
          onConfirm={(password) => confirmAction(messageId, password)}
          onClose={() => setShowPrompt(false)}
        />
      )}
    </div>
  );
}
