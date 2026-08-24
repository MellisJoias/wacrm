'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Contact, CustomField, MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ArrowLeft, ArrowRight, Eye, ImageIcon, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

type VariableType =
  | 'static'
  | 'field'
  | 'custom_field'
  | 'csv';

interface VariableMapping {
  type: VariableType;
  value: string;
}

interface CsvContact {
  phone: string;
  name?: string;
}

interface AudienceConfig {
  type: 'all' | 'tags' | 'custom_field' | 'csv';
  tagIds?: string[];
  customField?: {
    fieldId: string;
    operator: 'is' | 'is_not' | 'contains';
    value: string;
  };
  csvContacts?: CsvContact[];
  excludeTagIds?: string[];
}

interface Step3Props {
  template: MessageTemplate;
  variables: Record<string, VariableMapping>;
  audience: AudienceConfig;
  onUpdate: (variables: Record<string, VariableMapping>) => void;
  /** Media URL for an IMAGE/VIDEO/DOCUMENT header, when the template has one. */
  headerMediaUrl: string;
  onHeaderMediaUrlChange: (url: string) => void;
  onNext: () => void;
  onBack: () => void;
}

const MEDIA_HEADER_TYPES = ['image', 'video', 'document'] as const;
type MediaHeaderType = (typeof MEDIA_HEADER_TYPES)[number];

function isMediaHeaderType(value: unknown): value is MediaHeaderType {
  return MEDIA_HEADER_TYPES.includes(value as MediaHeaderType);
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const contactFields = [
  { value: 'name', labelKey: 'name' },
  { value: 'phone', labelKey: 'phone' },
  { value: 'email', labelKey: 'email' },
];

const SAMPLE_CONTACT: Contact = {
  id: 'sample',
  user_id: '',
  account_id: '',
  name: 'John Doe',
  phone: '+1234567890',
  email: 'john@example.com',
  company: 'Acme Corp',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

export function Step3Personalize({
  template,
  variables,
  audience,
  onUpdate,
  headerMediaUrl,
  onHeaderMediaUrlChange,
  onNext,
  onBack,
}: Step3Props) {
  const t = useTranslations('Broadcasts.wizard');

  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingFields, setLoadingFields] = useState(true);
  const [firstContact, setFirstContact] = useState<Contact | null>(null);
  const [firstContactCustomValues, setFirstContactCustomValues] = useState<
    Map<string, string>
  >(new Map());
  const [loadingPreview, setLoadingPreview] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const supabase = createClient();

      const [fieldsRes, contactRes] = await Promise.all([
        supabase
          .from('custom_fields')
          .select('*')
          .order('field_name'),

        supabase
          .from('contacts')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      if (cancelled) return;

      setCustomFields(fieldsRes.data ?? []);
      setLoadingFields(false);

      const contact = contactRes.data ?? null;
      setFirstContact(contact);

      if (contact) {
        const { data: customVals } = await supabase
          .from('contact_custom_values')
          .select('custom_field_id, value')
          .eq('contact_id', contact.id);

        if (!cancelled) {
          const map = new Map<string, string>();

          for (const row of customVals ?? []) {
            map.set(row.custom_field_id, row.value ?? '');
          }

          setFirstContactCustomValues(map);
        }
      }

      setLoadingPreview(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const placeholders = useMemo(() => {
    const matches = template.body_text.match(/\{\{(\d+)\}\}/g);

    if (!matches) return [];

    return [...new Set(matches)].sort();
  }, [template.body_text]);

  const mediaHeaderType = isMediaHeaderType(template.header_type)
    ? template.header_type
    : null;

  useEffect(() => {
    if (
      mediaHeaderType &&
      !headerMediaUrl &&
      template.header_media_url
    ) {
      onHeaderMediaUrlChange(template.header_media_url);
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaHeaderType, template.header_media_url]);

  const headerMediaError = useMemo<'missing' | 'invalid' | null>(() => {
    if (!mediaHeaderType) return null;

    const value = headerMediaUrl.trim();

    if (!value) return 'missing';

    if (!isValidHttpUrl(value)) return 'invalid';

    return null;
  }, [mediaHeaderType, headerMediaUrl]);

  const unmappedKeys = useMemo(() => {
    const missing: string[] = [];

    for (const placeholder of placeholders) {
      const key = placeholder.replace(/^\{\{|\}\}$/g, '');
      const mapping = variables[key];

      if (!mapping || !mapping.value?.trim()) {
        missing.push(placeholder);
      }
    }

    return missing;
  }, [placeholders, variables]);

  function updateVariable(
    key: string,
    patch: Partial<VariableMapping>,
  ) {
    const current =
      variables[key] ?? {
        type: 'static' as VariableType,
        value: '',
      };

    onUpdate({
      ...variables,
      [key]: {
        ...current,
        ...patch,
      },
    });
  }

  const previewText = useMemo(() => {
    const contact = firstContact ?? SAMPLE_CONTACT;

    const customValues = firstContact
      ? firstContactCustomValues
      : new Map<string, string>();

    const csvContact = audience.csvContacts?.[0];

    let text = template.body_text;

    for (const placeholder of placeholders) {
      const key = placeholder.replace(/^\{\{|\}\}$/g, '');
      const mapping = variables[key];

      let replacement = placeholder;

      if (mapping) {
        if (
          mapping.type === 'static' &&
          mapping.value
        ) {
          replacement = mapping.value;
        } else if (
          mapping.type === 'field' &&
          mapping.value
        ) {
          const fieldMap: Record<
            string,
            string | undefined
          > = {
            name: contact.name,
            phone: contact.phone,
            email: contact.email,
            company: contact.company,
          };

          replacement =
            fieldMap[mapping.value] ?? placeholder;
        } else if (
          mapping.type === 'custom_field' &&
          mapping.value
        ) {
          replacement =
            customValues.get(mapping.value) ||
            placeholder;
        } else if (
          mapping.type === 'csv' &&
          mapping.value === 'name'
        ) {
          replacement =
            csvContact?.name || placeholder;
        }
      }

      text = text.replaceAll(
        placeholder,
        replacement,
      );
    }

    return text;
  }, [
    template.body_text,
    variables,
    placeholders,
    firstContact,
    firstContactCustomValues,
    audience.csvContacts,
  ]);

  const previewLabel = firstContact
    ? firstContact.name || firstContact.phone
    : audience.csvContacts?.[0]?.name ||
      audience.csvContacts?.[0]?.phone ||
      t('personalize.previewSample');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          {t('personalize.title')}
        </h2>

        <p className="mt-1 text-sm text-muted-foreground">
          {t('personalize.subtitle')}
        </p>
      </div>

      {mediaHeaderType && (
        <div className="rounded-xl border border-border bg-card/50 p-4">
          <div className="mb-3 flex items-center gap-2">
            <ImageIcon className="h-4 w-4 text-primary" />

            <p className="text-sm font-medium text-foreground">
              {t('personalize.headerImage')}
            </p>

            <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium uppercase text-primary">
              {mediaHeaderType}
            </span>
          </div>

          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            {t('personalize.imageUrl')}
          </label>

          <Input
            type="url"
            value={headerMediaUrl}
            onChange={(e) =>
              onHeaderMediaUrlChange(e.target.value)
            }
            placeholder={t(
              'personalize.imageUrlPlaceholder',
            )}
            className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
          />

          <p className="mt-1.5 text-xs text-muted-foreground">
            {t('personalize.headerImageDesc')}
          </p>

          {mediaHeaderType === 'image' &&
            headerMediaError === null &&
            headerMediaUrl.trim() && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={headerMediaUrl.trim()}
                alt="Header preview"
                className="mt-3 max-h-40 rounded-lg border border-border object-contain"
              />
            )}

          {headerMediaError && (
            <p className="mt-1.5 text-xs text-amber-300">
              {headerMediaError === 'missing'
                ? 'A media URL is required to send this template.'
                : 'Enter a valid http(s) URL.'}
            </p>
          )}
        </div>
      )}

      {placeholders.length === 0 &&
      !mediaHeaderType ? (
        <div className="rounded-xl border border-border bg-card/50 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            {t('personalize.noPreview')}
          </p>
        </div>
      ) : placeholders.length === 0 ? null : (
        <div className="space-y-4">
          {placeholders.map((placeholder) => {
            const key = placeholder.replace(
              /^\{\{|\}\}$/g,
              '',
            );

            const mapping =
              variables[key] ?? {
                type: 'static',
                value: '',
              };

            return (
              <div
                key={placeholder}
                className="rounded-xl border border-border bg-card/50 p-4"
              >
                <div className="mb-3 flex items-center gap-2">
                  <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-xs font-mono font-medium text-primary">
                    {placeholder}
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                      {t('personalize.type')}
                    </label>

                    <Select
                      value={mapping.type}
                      onValueChange={(val) =>
                        updateVariable(key, {
                          type: val as VariableType,
                          value: '',
                        })
                      }
                    >
                      <SelectTrigger className="w-full border-border bg-muted text-foreground">
                        <SelectValue />
                      </SelectTrigger>

                      <SelectContent className="border-border bg-popover">
                        <SelectItem value="static">
                          {t(
                            'personalize.typeStatic',
                          )}
                        </SelectItem>

                        <SelectItem value="field">
                          {t(
                            'personalize.typeContact',
                          )}
                        </SelectItem>

                        <SelectItem value="custom_field">
                          {t(
                            'personalize.typeCustom',
                          )}
                        </SelectItem>

                        <SelectItem value="csv">
                          CSV
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                      {mapping.type === 'static'
                        ? t(
                            'personalize.staticValue',
                          )
                        : mapping.type === 'csv'
                          ? 'Campo do CSV'
                          : t(
                              'personalize.contactField',
                            )}
                    </label>

                    {mapping.type === 'static' ? (
                      <Input
                        value={mapping.value}
                        onChange={(e) =>
                          updateVariable(key, {
                            value: e.target.value,
                          })
                        }
                        placeholder="Enter value..."
                        className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                      />
                    ) : mapping.type === 'field' ? (
                      <Select
                        value={
                          mapping.value || undefined
                        }
                        onValueChange={(val) =>
                          updateVariable(key, {
                            value: val || '',
                          })
                        }
                      >
                        <SelectTrigger className="w-full border-border bg-muted text-foreground">
                          <SelectValue
                            placeholder={t(
                              'personalize.selectContactField',
                            )}
                          />
                        </SelectTrigger>

                        <SelectContent className="border-border bg-popover">
                          {contactFields.map(
                            (field) => (
                              <SelectItem
                                key={field.value}
                                value={field.value}
                              >
                                {t(
                                  `personalize.fieldMap.${field.labelKey}`,
                                )}
                              </SelectItem>
                            ),
                          )}
                        </SelectContent>
                      </Select>
                    ) : mapping.type === 'custom_field' ? (
                      <Select
                        value={
                          mapping.value || undefined
                        }
                        onValueChange={(val) =>
                          updateVariable(key, {
                            value: val || '',
                          })
                        }
                      >
                        <SelectTrigger className="w-full border-border bg-muted text-foreground">
                          <SelectValue placeholder="Select custom field" />
                        </SelectTrigger>

                        <SelectContent className="border-border bg-popover">
                          {loadingFields ? (
                            <SelectItem
                              value="loading"
                              disabled
                            >
                              Loading...
                            </SelectItem>
                          ) : customFields.length ===
                            0 ? (
                            <SelectItem
                              value="empty"
                              disabled
                            >
                              No custom fields
                            </SelectItem>
                          ) : (
                            customFields.map((field) => (
                              <SelectItem
                                key={field.id}
                                value={field.id}
                              >
                                {field.field_name}
                              </SelectItem>
                            ))
                          )}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Select
                        value={
                          mapping.value || undefined
                        }
                        onValueChange={(val) =>
                          updateVariable(key, {
                            value: val || '',
                          })
                        }
                      >
                        <SelectTrigger className="w-full border-border bg-muted text-foreground">
                          <SelectValue placeholder="Selecionar campo do CSV" />
                        </SelectTrigger>

                        <SelectContent className="border-border bg-popover">
                          <SelectItem value="name">
                            Nome
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="rounded-xl border border-border bg-card/50 p-4">
        <div className="mb-3 flex items-center gap-2">
          <Eye className="h-4 w-4 text-primary" />

          <p className="text-sm font-medium text-foreground">
            {t('personalize.preview')}
          </p>
        </div>

        <div className="mb-2 text-xs text-muted-foreground">
          ({previewLabel})

          {loadingPreview && (
            <Loader2 className="ml-2 inline h-3 w-3 animate-spin" />
          )}
        </div>

        <div className="rounded-2xl rounded-tl-md bg-muted px-4 py-3 text-sm text-foreground">
          {previewText}
        </div>
      </div>

      {unmappedKeys.length > 0 && (
        <p className="text-sm text-amber-300">
          Map every placeholder before continuing —
          still missing{' '}
          {unmappedKeys.join(', ')}. Otherwise those
          placeholders will ship to Meta as empty
          strings.
        </p>
      )}

      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-border"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('back')}
        </Button>

        <Button
          onClick={onNext}
          disabled={
            unmappedKeys.length > 0 ||
            (placeholders.length === 0 &&
              headerMediaError !== null)
          }
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}