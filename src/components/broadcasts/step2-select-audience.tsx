'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { CustomField, Tag } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Users,
  Tags,
  Filter,
  Upload,
  Loader2,
  ArrowRight,
  ArrowLeft,
  X,
  FileText,
  CheckCircle2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

type AudienceType = 'all' | 'tags' | 'custom_field' | 'csv';
type CustomFieldOperator = 'is' | 'is_not' | 'contains';

interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

interface CsvContact {
  phone: string;
  name?: string;
}

interface AudienceConfig {
  type: AudienceType;
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: CsvContact[];
  excludeTagIds?: string[];
}

interface Step2Props {
  audience: AudienceConfig;
  onUpdate: (audience: AudienceConfig) => void;
  onNext: () => void;
  onBack: () => void;
}

function normalizePhone(value: string): string {
  return value.replace(/\D/g, '');
}

function parseCsvLine(line: string, separator: string): string[] {
  const result: string[] = [];
  let current = '';
  let insideQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (insideQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        insideQuotes = !insideQuotes;
      }
      continue;
    }

    if (char === separator && !insideQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  result.push(current.trim());

  return result;
}

function parseCsv(text: string): CsvContact[] {
  const cleaned = text.replace(/^\uFEFF/, '').trim();

  if (!cleaned) {
    return [];
  }

  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return [];
  }

  // Detecta automaticamente ; ou ,
  const firstLine = lines[0];
  const semicolonCount = (firstLine.match(/;/g) || []).length;
  const commaCount = (firstLine.match(/,/g) || []).length;

  const separator = semicolonCount > commaCount ? ';' : ',';

  const firstRow = parseCsvLine(firstLine, separator).map((value) =>
    value.toLowerCase().trim()
  );

  const phoneHeaderIndex = firstRow.findIndex((header) =>
    [
      'phone',
      'telefone',
      'whatsapp',
      'celular',
      'numero',
      'número',
      'phone_number',
      'phone number',
    ].includes(header)
  );

  const nameHeaderIndex = firstRow.findIndex((header) =>
    ['name', 'nome', 'contact', 'contato'].includes(header)
  );

  // Se houver cabeçalho reconhecível, usa-o.
  // Caso contrário, considera:
  // coluna 1 = telefone
  // coluna 2 = nome
  const hasHeader = phoneHeaderIndex !== -1 || nameHeaderIndex !== -1;

  const startIndex = hasHeader ? 1 : 0;

  const contacts: CsvContact[] = [];

  for (let i = startIndex; i < lines.length; i++) {
    const row = parseCsvLine(lines[i], separator);

    if (row.length === 0) continue;

    const phoneRaw =
      hasHeader && phoneHeaderIndex !== -1
        ? row[phoneHeaderIndex] ?? ''
        : row[0] ?? '';

    const nameRaw =
      hasHeader && nameHeaderIndex !== -1
        ? row[nameHeaderIndex] ?? ''
        : row[1] ?? '';

    const phone = normalizePhone(phoneRaw);
    const name = nameRaw.trim();

    // Ignora linhas sem telefone.
    if (!phone) continue;

    contacts.push({
      phone,
      ...(name ? { name } : {}),
    });
  }

  // Remove telefones duplicados dentro do próprio CSV.
  const unique = new Map<string, CsvContact>();

  for (const contact of contacts) {
    if (!unique.has(contact.phone)) {
      unique.set(contact.phone, contact);
    }
  }

  return Array.from(unique.values());
}

export function Step2SelectAudience({
  audience,
  onUpdate,
  onNext,
  onBack,
}: Step2Props) {
  const t = useTranslations('Broadcasts.wizard');

  const [tags, setTags] = useState<Tag[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingTags, setLoadingTags] = useState(false);
  const [loadingFields, setLoadingFields] = useState(false);
  const [estimatedCount, setEstimatedCount] = useState<number | null>(null);
  const [loadingCount, setLoadingCount] = useState(false);

  const [csvLoading, setCsvLoading] = useState(false);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [csvFileName, setCsvFileName] = useState<string | null>(null);

  const OPERATOR_OPTIONS = useMemo<
    { value: CustomFieldOperator; label: string }[]
  >(
    () => [
      { value: 'is', label: t('selectAudience.operatorIs') },
      { value: 'is_not', label: t('selectAudience.operatorIsNot') },
      { value: 'contains', label: t('selectAudience.operatorContains') },
    ],
    [t]
  );

  const audienceOptions = useMemo<
    {
      type: AudienceType;
      label: string;
      description: string;
      icon: typeof Users;
    }[]
  >(
    () => [
      {
        type: 'all',
        label: t('selectAudience.method.all'),
        description: t('selectAudience.allDescLoading'),
        icon: Users,
      },
      {
        type: 'tags',
        label: t('selectAudience.method.tags'),
        description: t('selectAudience.tagDesc'),
        icon: Tags,
      },
      {
        type: 'custom_field',
        label: t('selectAudience.method.customField'),
        description: t('selectAudience.customFieldDesc'),
        icon: Filter,
      },
      {
        type: 'csv',
        label: t('selectAudience.method.csv'),
        description: t('selectAudience.csvDesc'),
        icon: Upload,
      },
    ],
    [t]
  );

  useEffect(() => {
    async function fetchTags() {
      setLoadingTags(true);

      try {
        const supabase = createClient();

        const { data } = await supabase
          .from('tags')
          .select('*')
          .order('name');

        setTags(data ?? []);
      } finally {
        setLoadingTags(false);
      }
    }

    fetchTags();
  }, []);

  useEffect(() => {
    if (audience.type !== 'custom_field') return;

    async function fetchFields() {
      setLoadingFields(true);

      try {
        const supabase = createClient();

        const { data } = await supabase
          .from('custom_fields')
          .select('*')
          .order('field_name');

        setCustomFields(data ?? []);
      } finally {
        setLoadingFields(false);
      }
    }

    fetchFields();
  }, [audience.type]);

  const fetchEstimatedCount = useCallback(async () => {
    setLoadingCount(true);

    try {
      const supabase = createClient();

      let baseIds: Set<string> | null = null;

      if (audience.type === 'all') {
        // Tratado abaixo.
      } else if (
        audience.type === 'tags' &&
        audience.tagIds &&
        audience.tagIds.length > 0
      ) {
        const { data } = await supabase
          .from('contact_tags')
          .select('contact_id')
          .in('tag_id', audience.tagIds);

        baseIds = new Set((data ?? []).map((r) => r.contact_id));
      } else if (
        audience.type === 'custom_field' &&
        audience.customField?.fieldId &&
        audience.customField.value
      ) {
        const { fieldId, operator, value } = audience.customField;

        let q = supabase
          .from('contact_custom_values')
          .select('contact_id')
          .eq('custom_field_id', fieldId);

        if (operator === 'is') {
          q = q.eq('value', value);
        } else if (operator === 'is_not') {
          q = q.neq('value', value);
        } else {
          q = q.ilike('value', `%${value}%`);
        }

        const { data } = await q;

        baseIds = new Set((data ?? []).map((r) => r.contact_id));
      } else if (
        audience.type === 'csv' &&
        audience.csvContacts &&
        audience.csvContacts.length > 0
      ) {
        setEstimatedCount(audience.csvContacts.length);
        return;
      } else {
        setEstimatedCount(null);
        return;
      }

      let excludeSet: Set<string> | null = null;

      if (
        audience.excludeTagIds &&
        audience.excludeTagIds.length > 0
      ) {
        const { data: excludeRows } = await supabase
          .from('contact_tags')
          .select('contact_id')
          .in('tag_id', audience.excludeTagIds);

        excludeSet = new Set(
          (excludeRows ?? []).map((r) => r.contact_id)
        );
      }

      if (baseIds) {
        const effective = [...baseIds].filter(
          (id) => !excludeSet?.has(id)
        );

        setEstimatedCount(effective.length);
      } else {
        const { count } = await supabase
          .from('contacts')
          .select('*', {
            count: 'exact',
            head: true,
          });

        const total = count ?? 0;

        setEstimatedCount(
          excludeSet
            ? Math.max(0, total - excludeSet.size)
            : total
        );
      }
    } finally {
      setLoadingCount(false);
    }
  }, [
    audience.type,
    audience.tagIds,
    audience.customField,
    audience.csvContacts,
    audience.excludeTagIds,
  ]);

  useEffect(() => {
    fetchEstimatedCount();
  }, [fetchEstimatedCount]);

  function toggleTag(tagId: string) {
    const current = audience.tagIds ?? [];

    const updated = current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId];

    onUpdate({
      ...audience,
      tagIds: updated,
    });
  }

  function toggleExcludeTag(tagId: string) {
    const current = audience.excludeTagIds ?? [];

    const updated = current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId];

    onUpdate({
      ...audience,
      excludeTagIds: updated,
    });
  }

  function updateCustomField(
    patch: Partial<CustomFieldFilter>
  ) {
    const prev = audience.customField ?? {
      fieldId: '',
      operator: 'is' as CustomFieldOperator,
      value: '',
    };

    onUpdate({
      ...audience,
      customField: {
        ...prev,
        ...patch,
      },
    });
  }

  async function handleCsvUpload(
    event: React.ChangeEvent<HTMLInputElement>
  ) {
    const file = event.target.files?.[0];

    if (!file) return;

    setCsvError(null);
    setCsvLoading(true);
    setCsvFileName(file.name);

    try {
      if (!file.name.toLowerCase().endsWith('.csv')) {
        throw new Error('Selecione um arquivo CSV.');
      }

      const text = await file.text();
      const contacts = parseCsv(text);

      if (contacts.length === 0) {
        throw new Error(
          'Nenhum telefone válido foi encontrado no CSV.'
        );
      }

      onUpdate({
        ...audience,
        type: 'csv',
        csvContacts: contacts,
      });

      setEstimatedCount(contacts.length);
    } catch (error) {
      setCsvFileName(null);

      setCsvError(
        error instanceof Error
          ? error.message
          : 'Não foi possível ler o arquivo CSV.'
      );

      onUpdate({
        ...audience,
        type: 'csv',
        csvContacts: undefined,
      });

      setEstimatedCount(null);
    } finally {
      setCsvLoading(false);

      // Permite selecionar o mesmo arquivo novamente.
      event.target.value = '';
    }
  }

  function removeCsv() {
    setCsvFileName(null);
    setCsvError(null);

    onUpdate({
      ...audience,
      type: 'csv',
      csvContacts: undefined,
    });

    setEstimatedCount(null);
  }

  const isValid =
    audience.type === 'all' ||
    (audience.type === 'tags' &&
      !!audience.tagIds &&
      audience.tagIds.length > 0) ||
    (audience.type === 'custom_field' &&
      !!audience.customField?.fieldId &&
      audience.customField.value.length > 0) ||
    (audience.type === 'csv' &&
      !!audience.csvContacts &&
      audience.csvContacts.length > 0);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          {t('selectAudience.title')}
        </h2>

        <p className="mt-1 text-sm text-muted-foreground">
          {t('selectAudience.subtitle')}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {audienceOptions.map((option) => {
          const isSelected =
            audience.type === option.type;

          const Icon = option.icon;

          return (
            <button
              key={option.type}
              type="button"
              onClick={() => {
                setCsvError(null);

                onUpdate({
                  ...audience,
                  type: option.type,
                  tagIds:
                    option.type === 'tags'
                      ? audience.tagIds
                      : undefined,
                  customField:
                    option.type === 'custom_field'
                      ? audience.customField
                      : undefined,
                  csvContacts:
                    option.type === 'csv'
                      ? audience.csvContacts
                      : undefined,
                });
              }}
              className={`flex items-start gap-3 rounded-xl border p-4 text-left transition-all ${
                isSelected
                  ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                  : 'border-border bg-card/50 hover:border-border'
              }`}
            >
              <div
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                  isSelected
                    ? 'bg-primary/10 text-primary'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                <Icon className="h-4 w-4" />
              </div>

              <div>
                <p className="text-sm font-medium text-foreground">
                  {option.label}
                </p>

                <p className="mt-0.5 text-xs text-muted-foreground">
                  {option.description}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {audience.type === 'csv' && (
        <div className="rounded-xl border border-border bg-card/50 p-4">
          <div className="mb-3">
            <p className="text-sm font-medium text-foreground">
              Upload CSV
            </p>

            <p className="mt-1 text-xs text-muted-foreground">
              Envie um CSV contendo pelo menos uma coluna com telefone.
              Para enviar para apenas 1 contato, o arquivo pode ter
              somente uma linha.
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <label
              htmlFor="broadcast-csv-upload"
              className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/50 px-4 py-4 text-sm text-muted-foreground transition-colors hover:border-primary hover:text-primary"
            >
              {csvLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Lendo CSV...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4" />
                  Selecionar arquivo CSV
                </>
              )}

              <input
                id="broadcast-csv-upload"
                type="file"
                accept=".csv,text/csv"
                onChange={handleCsvUpload}
                disabled={csvLoading}
                className="hidden"
              />
            </label>

            {csvFileName && audience.csvContacts?.length ? (
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <FileText className="h-4 w-4 shrink-0 text-primary" />

                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {csvFileName}
                      </p>

                      <p className="text-xs text-muted-foreground">
                        {audience.csvContacts.length}{' '}
                        {audience.csvContacts.length === 1
                          ? 'contato'
                          : 'contatos'}{' '}
                        válido
                        {audience.csvContacts.length === 1
                          ? ''
                          : 's'}
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={removeCsv}
                    className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label="Remover CSV"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                {audience.csvContacts.length <= 5 && (
                  <div className="mt-3 space-y-1 border-t border-border/50 pt-3">
                    {audience.csvContacts.map(
                      (contact, index) => (
                        <div
                          key={`${contact.phone}-${index}`}
                          className="flex items-center gap-2 text-xs"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary" />

                          <span className="font-medium text-foreground">
                            {contact.name || 'Sem nome'}
                          </span>

                          <span className="text-muted-foreground">
                            {contact.phone}
                          </span>
                        </div>
                      )
                    )}
                  </div>
                )}
              </div>
            ) : null}

            {csvError && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2">
                <p className="text-xs text-red-400">
                  {csvError}
                </p>
              </div>
            )}

            <div className="rounded-lg bg-muted/50 p-3">
              <p className="text-xs font-medium text-foreground">
                Formato aceito
              </p>

              <p className="mt-1 text-xs text-muted-foreground">
                Você pode usar:
              </p>

              <pre className="mt-2 overflow-x-auto rounded bg-background p-2 text-xs text-muted-foreground">
{`phone,name
5511999999999,João`}
              </pre>

              <p className="mt-2 text-xs text-muted-foreground">
                Também são aceitos os nomes de coluna
                <strong> telefone </strong>
                ou
                <strong> whatsapp </strong>
                e
                <strong> nome</strong>.
              </p>

              <p className="mt-2 text-xs text-muted-foreground">
                Se o CSV tiver apenas uma coluna, ela será
                considerada como telefone.
              </p>
            </div>
          </div>
        </div>
      )}

      {audience.type === 'tags' && (
        <div className="rounded-xl border border-border bg-card/50 p-4">
          <p className="mb-3 text-sm font-medium text-foreground">
            {t('selectAudience.selectTags')}
          </p>

          {loadingTags ? (
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          ) : tags.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('selectAudience.noTagsFound')}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => {
                const isSelected =
                  audience.tagIds?.includes(tag.id);

                return (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => toggleTag(tag.id)}
                    className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-all ${
                      isSelected
                        ? 'border-primary/30 bg-primary/10 text-primary'
                        : 'border-border bg-muted text-muted-foreground hover:border-border'
                    }`}
                  >
                    <span
                      className="mr-1.5 h-2 w-2 rounded-full"
                      style={{
                        backgroundColor: tag.color,
                      }}
                    />

                    {tag.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {audience.type === 'custom_field' && (
        <div className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
          <p className="text-sm font-medium text-foreground">
            {t('selectAudience.method.customField')}
          </p>

          {loadingFields ? (
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          ) : customFields.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('selectAudience.errorLoadFields')}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_140px_minmax(0,1fr)]">
              <select
                value={
                  audience.customField?.fieldId ?? ''
                }
                onChange={(e) =>
                  updateCustomField({
                    fieldId: e.target.value,
                  })
                }
                className="h-9 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              >
                <option value="">
                  {t('selectAudience.selectField')}
                </option>

                {customFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.field_name}
                  </option>
                ))}
              </select>

              <select
                value={
                  audience.customField?.operator ?? 'is'
                }
                onChange={(e) =>
                  updateCustomField({
                    operator:
                      e.target.value as CustomFieldOperator,
                  })
                }
                className="h-9 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              >
                {OPERATOR_OPTIONS.map((op) => (
                  <option
                    key={op.value}
                    value={op.value}
                  >
                    {op.label}
                  </option>
                ))}
              </select>

              <input
                type="text"
                value={
                  audience.customField?.value ?? ''
                }
                onChange={(e) =>
                  updateCustomField({
                    value: e.target.value,
                  })
                }
                placeholder={t(
                  'selectAudience.valuePlaceholder'
                )}
                className="h-9 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary"
              />
            </div>
          )}
        </div>
      )}

      <div className="rounded-xl border border-border bg-card/50 p-4">
        <div className="mb-3 flex items-center gap-2">
          <X className="h-4 w-4 text-red-400" />

          <p className="text-sm font-medium text-foreground">
            {t('selectAudience.excludeTags')}
          </p>
        </div>

        {tags.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t('selectAudience.noTagsFound')}
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => {
              const isExcluded =
                audience.excludeTagIds?.includes(
                  tag.id
                );

              return (
                <button
                  key={tag.id}
                  type="button"
                  onClick={() =>
                    toggleExcludeTag(tag.id)
                  }
                  className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-all ${
                    isExcluded
                      ? 'border-red-500/30 bg-red-500/10 text-red-300'
                      : 'border-border bg-muted text-muted-foreground hover:border-border'
                  }`}
                >
                  <span
                    className="mr-1.5 h-2 w-2 rounded-full"
                    style={{
                      backgroundColor: tag.color,
                    }}
                  />

                  {tag.name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card/50 p-4">
        <p className="mb-2 text-sm font-medium text-foreground">
          Audience Summary
        </p>

        {loadingCount ? (
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />

            <span className="text-xs text-muted-foreground">
              Calculating…
            </span>
          </div>
        ) : estimatedCount !== null ? (
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" />

            <span className="text-sm text-foreground">
              {estimatedCount.toLocaleString()}
            </span>

            <span className="text-xs text-muted-foreground">
              estimated recipients
            </span>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Select an audience type to see the estimate.
          </p>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />

          {t('back')}
        </Button>

        <Button
          onClick={onNext}
          disabled={!isValid}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}

          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}