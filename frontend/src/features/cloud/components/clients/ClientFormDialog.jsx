import { useEffect, useState } from 'react';
import Button from '@/components/ui/Button';
import Dialog from '@/components/ui/Dialog';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Textarea from '@/components/ui/Textarea';
import { Field } from '@/components/ui/Field';
import { useCreateClient, useUpdateClient } from '../../hooks/useClients';
import { CLIENT_CODE_RE, invalidEmails, parseEmailList } from '../../utils/clientModel';

const EMPTY = { name: '', code: '', description: '', contacts: '', notes: '' };

const fromClient = (c) => (c ? {
  name: c.name || '',
  code: c.code || '',
  description: c.description || '',
  contacts: (c.contact_emails || []).join(', '),
  notes: c.notes || '',
} : EMPTY);

/**
 * Create or edit a client. The backend is the authority on every rule (unique
 * name and code, valid e-mails); the checks here only save a round trip for
 * an obvious typo, and a server refusal is shown verbatim.
 */
export default function ClientFormDialog({ open, onClose, client = null, onSaved }) {
  const editing = !!client;
  const [form, setForm] = useState(() => fromClient(client));
  const create = useCreateClient();
  const update = useUpdateClient();
  const mutation = editing ? update : create;

  useEffect(() => {
    if (open) {
      setForm(fromClient(client));
      create.reset();
      update.reset();
    }
    // Reset only when the dialog opens or switches client, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, client?.id]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const emails = parseEmailList(form.contacts);
  const badEmails = invalidEmails(emails);
  const code = form.code.trim();
  const codeInvalid = code && !CLIENT_CODE_RE.test(code);
  const canSave = form.name.trim() && !codeInvalid && !badEmails.length && !mutation.isPending;

  const save = async () => {
    const payload = {
      name: form.name.trim(),
      code: code || null,
      description: form.description.trim() || null,
      contact_emails: emails,
      notes: form.notes.trim() || null,
    };
    try {
      const saved = editing
        ? await update.mutateAsync({ clientId: client.id, payload })
        : await create.mutateAsync(payload);
      onSaved?.(saved);
      onClose?.();
    } catch {
      /* shown from mutation.error below */
    }
  };

  const serverError = mutation.error?.response?.data?.detail || mutation.error?.message;

  return (
    <Dialog
      open={open}
      onClose={mutation.isPending ? undefined : onClose}
      title={editing ? `Edit ${client.name}` : 'New client'}
      subtitle="A client groups the cloud accounts you run for one customer."
      icon="building"
      width={560}
      footer={(
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" disabled={mutation.isPending} onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={mutation.isPending} disabled={!canSave} onClick={save}>
            {editing ? 'Save changes' : 'Create client'}
          </Button>
        </div>
      )}
    >
      {serverError && <Notice tone="danger">{String(serverError)}</Notice>}
      <div className="space-y-4">
        <Field label="Name" hint="Unique, ignoring case — “KOEL” and “koel” are the same client.">
          <Input value={form.name} onChange={set('name')} placeholder="e.g. Kirloskar Oil Engines" autoFocus />
        </Field>
        <Field label="Code (optional)" hint="Short label for lists and report file names. 1–32 letters, digits, “.”, “-” or “_”.">
          <Input value={form.code} onChange={set('code')} placeholder="e.g. KOEL" />
          {codeInvalid && <p className="mt-1 text-meta text-danger-fg">That code has characters a code cannot contain.</p>}
        </Field>
        <Field label="Description (optional)">
          <Textarea rows={2} value={form.description} onChange={set('description')} />
        </Field>
        <Field
          label="Contacts (optional)"
          hint="Informational only. Report recipients are set on the report schedule, so adding a contact here never adds anyone to an e-mail."
        >
          <Textarea rows={2} value={form.contacts} onChange={set('contacts')} placeholder="name@example.com, other@example.com" />
          {badEmails.length > 0 && (
            <p className="mt-1 text-meta text-danger-fg">Not e-mail addresses: {badEmails.join(', ')}</p>
          )}
        </Field>
        <Field label="Notes (optional)">
          <Textarea rows={3} value={form.notes} onChange={set('notes')} />
        </Field>
      </div>
    </Dialog>
  );
}
