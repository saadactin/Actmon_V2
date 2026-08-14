import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import { fieldsForEngine } from '@/config/connectionFieldCatalog';

/**
 * Renders one engine's connection fields from `connectionFieldCatalog.js` — the
 * same "one config array drives the form" shape as Cosmos DB's edit-connection
 * page (`CosmosDBEditConnectionPage.jsx`'s `FormField`), reused rather than
 * re-invented so a field added to the catalogue needs no changes here.
 */
export default function ConnectionFieldsForm({ engine, value, onChange, errors = {} }) {
  const fields = fieldsForEngine(engine);
  const set = (name, v) => onChange({ ...value, [name]: v });

  return (
    <div className="grid grid-cols-1 gap-gutter-sm sm:grid-cols-2">
      {fields.map((field) => (
        <Field
          key={field.name}
          field={field}
          value={value[field.name]}
          error={errors[field.name]}
          onChange={(v) => set(field.name, v)}
          className={field.kind === 'textarea' ? 'sm:col-span-2' : undefined}
        />
      ))}
    </div>
  );
}

function Field({ field, value, error, onChange, className }) {
  const control = (() => {
    if (field.kind === 'select') {
      return <Select value={value ?? ''} onChange={onChange} options={field.options} size="sm" />;
    }
    if (field.kind === 'textarea') {
      return (
        <textarea
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          rows={2}
          placeholder={field.placeholder}
          spellCheck={false}
          className={`w-full rounded-control border bg-surface px-2.5 py-2 text-[13px] text-fg
            transition-colors placeholder:text-subtle hover:border-strong
            ${field.mono ? 'font-mono text-[12px]' : ''}
            ${error ? 'border-danger' : 'border-border'}`}
        />
      );
    }
    return (
      <Input
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        type={field.kind === 'password' ? 'password' : field.kind === 'number' ? 'number' : 'text'}
        placeholder={field.placeholder}
        size="sm"
        className={error ? 'border-danger' : undefined}
        autoComplete={field.kind === 'password' ? 'new-password' : 'off'}
      />
    );
  })();

  return (
    <div className={className}>
      <label className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold text-fg">
        {field.label}
        {field.required && (
          <span className="h-1 w-1 rounded-full bg-danger" aria-label="required" title="Required" />
        )}
      </label>
      {control}
      {error
        ? <p className="mt-0.5 text-[11px] text-danger-fg">{error}</p>
        : field.hint && <p className="mt-0.5 text-[11px] leading-snug text-subtle">{field.hint}</p>}
    </div>
  );
}
