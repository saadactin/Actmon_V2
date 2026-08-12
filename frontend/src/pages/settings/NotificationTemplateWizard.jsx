import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import cn from '@/lib/cn';
import Dialog from '@/components/ui/Dialog';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Textarea from '@/components/ui/Textarea';
import Stepper from '@/components/ui/Stepper';
import { saveTemplate, resetTemplate, previewTemplate } from '@/api/notifications';
import { CHANNEL_DEFS } from '@/config/notificationChannels';
import { SUBJECT_PRESETS, TEMPLATE_VARIABLES, bodyPresetsFor } from '@/config/notificationTemplates';

const STEPS = [
  { n: 1, label: 'Start' },
  { n: 2, label: 'Compose' },
  { n: 3, label: 'Preview & save' },
];

function insertAtCursor(ref, value, setValue, snippet) {
  const el = ref.current;
  if (!el || el.selectionStart == null) {
    setValue(`${value || ''}${snippet}`);
    return;
  }
  const start = el.selectionStart;
  const end = el.selectionEnd;
  const next = `${value.slice(0, start)}${snippet}${value.slice(end)}`;
  setValue(next);
  requestAnimationFrame(() => {
    el.focus();
    el.selectionStart = el.selectionEnd = start + snippet.length;
  });
}

/**
 * 3-step template editor — one channel per open. Step 1 picks a standard
 * starting point (or an uploaded file); step 2 composes subject + body with
 * a {{Variable}} insert toolbar; step 3 renders a live server-side preview
 * against sample alert data before saving. Backed by notification_templates
 * (one override row per org+channel — absent means "use the built-in
 * default", which template_service.py already falls back to at send time).
 */
export default function NotificationTemplateWizard({ channelType, initial, onClose }) {
  const qc = useQueryClient();
  const def = CHANNEL_DEFS[channelType];
  const isHtml = channelType === 'email';
  const presets = bodyPresetsFor(channelType);

  const [step, setStep] = useState(1);
  const [subject, setSubject] = useState(initial?.subject_template || '');
  const [body, setBody] = useState(initial?.body_template || '');
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [fileError, setFileError] = useState('');

  const subjectRef = useRef(null);
  const bodyRef = useRef(null);
  const fileInputRef = useRef(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['notification-templates'] });
    qc.invalidateQueries({ queryKey: ['notification-template', channelType] });
  };

  const saveMut = useMutation({
    mutationFn: () => saveTemplate(channelType, { subject_template: subject, body_template: body }),
    onSuccess: () => { invalidate(); onClose(); },
  });

  const resetMut = useMutation({
    mutationFn: () => resetTemplate(channelType),
    onSuccess: (tpl) => { setSubject(tpl.subject_template); setBody(tpl.body_template); invalidate(); },
  });

  const runPreview = async () => {
    setPreviewError('');
    try {
      const res = await previewTemplate(channelType, { subject_template: subject, body_template: body });
      setPreview(res);
    } catch (e) {
      setPreviewError(e?.response?.data?.detail || e?.message || 'Could not render a preview.');
    }
  };

  useEffect(() => {
    if (step === 3) runPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const applyPreset = (preset) => setBody(preset.value);

  const handleUpload = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/\.(html?|txt)$/i.test(file.name)) {
      setFileError('Upload an .html or .txt file.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => { setBody(String(reader.result || '')); setFileError(''); };
    reader.onerror = () => setFileError('Could not read that file.');
    reader.readAsText(file);
  };

  const canNext = step === 2 ? subject.trim() && body.trim() : true;

  return (
    <Dialog
      open
      onClose={onClose}
      icon={def.icon}
      title={`${def.label} template`}
      subtitle={isHtml ? 'HTML email — subject + body' : 'Plain text message'}
      width={720}
      footer={
        <div className="flex items-center justify-between gap-2">
          <div>
            {step === 3 && (
              <Button variant="danger-ghost" icon="refresh" loading={resetMut.isPending} onClick={() => resetMut.mutate()}>
                Reset to default
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {step > 1 && <Button variant="secondary" onClick={() => setStep((s) => s - 1)}>Back</Button>}
            {step < 3 && (
              <Button variant="primary" iconRight="chevron-right" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>
                Next
              </Button>
            )}
            {step === 3 && (
              <Button variant="primary" icon="save" loading={saveMut.isPending} onClick={() => saveMut.mutate()}>
                Save &amp; set as active template
              </Button>
            )}
          </div>
        </div>
      }
    >
      <Stepper steps={STEPS} step={step} />

      {step === 1 && (
        <div className="space-y-5">
          <div>
            <p className="mb-2 text-[12px] font-bold tracking-wide text-subtle uppercase">Standard options</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {presets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPreset(p)}
                  className={cn(
                    'rounded-control border p-3 text-left transition-colors',
                    body === p.value ? 'border-accent-border bg-accent-soft' : 'border-border hover:border-strong hover:bg-raised',
                  )}
                >
                  <p className="text-[12px] font-bold text-fg">{p.label}</p>
                  <p className="mt-1 text-[11px] leading-snug text-muted">{p.desc}</p>
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-[12px] font-bold tracking-wide text-subtle uppercase">Or upload a template</p>
            <div className="flex items-center gap-2">
              <Button variant="secondary" icon="download" onClick={() => fileInputRef.current?.click()}>
                Upload {isHtml ? '.html' : '.txt'} file
              </Button>
              <input ref={fileInputRef} type="file" accept=".html,.htm,.txt" className="hidden" onChange={handleUpload} />
              <span className="text-[11px] text-subtle">Its contents become the body — edit and add {'{{Variables}}'} on the next step.</span>
            </div>
            {fileError && <p className="mt-1.5 text-[11px] font-semibold text-danger-fg">{fileError}</p>}
          </div>

          {initial?.is_override && (
            <p className="flex items-start gap-2 rounded-control bg-info-soft px-3 py-2 text-[11px] leading-relaxed text-info-fg">
              <Icon name="info" size={13} className="mt-px shrink-0" />
              This channel already has a saved custom template — it's loaded below. Pick a standard option or upload a
              file to replace it, or just click Next to keep editing it as-is.
            </p>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div>
            <p className="mb-1.5 text-[12px] font-semibold text-fg">Subject</p>
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {SUBJECT_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSubject(p.value)}
                  className="rounded-control border border-border px-2 py-1 text-[11px] font-semibold text-muted transition-colors hover:border-strong hover:text-fg"
                >
                  {p.label}
                </button>
              ))}
            </div>
            <Input ref={subjectRef} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject template" />
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <p className="text-[12px] font-semibold text-fg">Body {isHtml && <span className="font-normal text-subtle">(HTML)</span>}</p>
            </div>
            <Textarea
              ref={bodyRef}
              rows={10}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="font-mono text-[12px]"
              placeholder="Body template"
            />
          </div>

          <div>
            <p className="mb-1.5 text-[11px] font-bold tracking-wide text-subtle uppercase">Insert a variable</p>
            <div className="flex flex-wrap gap-1.5">
              {TEMPLATE_VARIABLES.map((v) => (
                <button
                  key={v}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    const target = document.activeElement === subjectRef.current ? 'subject' : 'body';
                    if (target === 'subject') insertAtCursor(subjectRef, subject, setSubject, `{{${v}}}`);
                    else insertAtCursor(bodyRef, body, setBody, `{{${v}}}`);
                  }}
                  className="rounded-control border border-border bg-sunken px-2 py-1 font-mono text-[11px] font-semibold text-muted transition-colors hover:border-strong hover:text-fg"
                >
                  {`{{${v}}}`}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-subtle">Click a field above first, then a variable to insert it there.</p>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-[12px] font-bold tracking-wide text-subtle uppercase">Live preview — sample alert data</p>
            <Button variant="ghost" size="sm" icon="refresh" onClick={runPreview}>Refresh</Button>
          </div>

          {previewError && (
            <p className="rounded-control bg-danger-soft px-3 py-2 text-[12px] font-semibold text-danger-fg">{previewError}</p>
          )}

          {preview && (
            <div className="overflow-hidden rounded-control border border-border">
              <div className="border-b border-border bg-sunken px-4 py-2.5">
                <p className="text-[10px] font-bold tracking-wide text-subtle uppercase">Subject</p>
                <p className="mt-0.5 text-[13px] font-semibold text-fg">{preview.subject}</p>
              </div>
              <div className="max-h-80 overflow-auto bg-surface p-4">
                {isHtml ? (
                  // eslint-disable-next-line react/no-danger
                  <div dangerouslySetInnerHTML={{ __html: preview.body }} />
                ) : (
                  <pre className="whitespace-pre-wrap font-mono text-[12px] text-fg">{preview.body}</pre>
                )}
              </div>
            </div>
          )}

          <p className="flex items-start gap-2 rounded-control bg-warning-soft px-3 py-2 text-[11px] leading-relaxed text-warning-fg">
            <Icon name="alert" size={13} className="mt-px shrink-0" />
            This is a simplified preview — real mail/chat clients may render fonts and spacing slightly differently.
          </p>
        </div>
      )}
    </Dialog>
  );
}
