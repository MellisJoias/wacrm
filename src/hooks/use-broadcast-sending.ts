'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import {
  BATCH_SEND_ATTEMPTS,
  batchRetryDelayMs,
} from '@/lib/broadcast-retry';
import { Contact, MessageTemplate } from '@/types';

export type CustomFieldOperator =
  | 'is'
  | 'is_not'
  | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export interface AudienceConfig {
  type: 'all' | 'tags' | 'custom_field' | 'csv';
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: {
    phone: string;
    name?: string;
  }[];
  excludeTagIds?: string[];
}

export type VariableMapping = {
  type: 'static' | 'field' | 'custom_field' | 'csv';
  value: string;
};

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  headerMediaUrl?: string;
}

interface UseBroadcastSendingReturn {
  createAndSendBroadcast: (
    payload: BroadcastPayload,
  ) => Promise<string>;
  isProcessing: boolean;
  progress: number;
}

const SEND_BATCH_SIZE = 10;
const SEND_BATCH_DELAY_MS = 1000;
const INSERT_BATCH_SIZE = 200;

function sleep(ms: number) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms),
  );
}

interface BroadcastApiResult {
  phone: string;
  status: 'sent' | 'failed';
  whatsapp_message_id?: string;
  error?: string;
}

type CustomValueIndex = Map<
  string,
  Map<string, string>
>;

export function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>,
  csvContact?: {
    phone: string;
    name?: string;
  },
): string[] {
  const keys = Object.keys(variables).sort(
    (a, b) => {
      const an = Number(a);
      const bn = Number(b);

      if (
        Number.isFinite(an) &&
        Number.isFinite(bn)
      ) {
        return an - bn;
      }

      return a.localeCompare(b);
    },
  );

  return keys.map((key) => {
    const variable = variables[key];

    if (variable.type === 'static') {
      return variable.value;
    }

    if (variable.type === 'field') {
      const fieldMap: Record<
        string,
        string | undefined
      > = {
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        company: contact.company,
      };

      return fieldMap[variable.value] ?? '';
    }

    if (variable.type === 'csv') {
      switch (variable.value) {
        case 'name':
          return csvContact?.name ?? '';

        case 'phone':
          return csvContact?.phone ?? '';

        default:
          return '';
      }
    }

    return (
      customValues?.get(variable.value) ?? ''
    );
  });
}

async function fetchCustomValueIndex(
  supabase: ReturnType<typeof createClient>,
  contactIds: string[],
): Promise<CustomValueIndex> {
  const index: CustomValueIndex = new Map();

  if (contactIds.length === 0) {
    return index;
  }

  const PAGE = 500;

  for (
    let i = 0;
    i < contactIds.length;
    i += PAGE
  ) {
    const slice = contactIds.slice(
      i,
      i + PAGE,
    );

    const { data } = await supabase
      .from('contact_custom_values')
      .select(
        'contact_id, custom_field_id, value',
      )
      .in('contact_id', slice);

    for (const row of data ?? []) {
      const bucket =
        index.get(row.contact_id) ??
        new Map<string, string>();

      bucket.set(
        row.custom_field_id,
        row.value ?? '',
      );

      index.set(row.contact_id, bucket);
    }
  }

  return index;
}

export function useBroadcastSending(): UseBroadcastSendingReturn {
  const { accountId } = useAuth();

  const [isProcessing, setIsProcessing] =
    useState(false);

  const [progress, setProgress] =
    useState(0);

  async function resolveAudience(
    audience: AudienceConfig,
  ): Promise<Contact[]> {
    const supabase = createClient();

    let contacts: Contact[] = [];

    if (audience.type === 'all') {
      const { data, error } = await supabase
        .from('contacts')
        .select('*');

      if (error) {
        throw new Error(
          `Failed to fetch contacts: ${error.message}`,
        );
      }

      contacts = data ?? [];
    } else if (
      audience.type === 'tags' &&
      audience.tagIds &&
      audience.tagIds.length > 0
    ) {
      const {
        data: contactTags,
        error: tagError,
      } = await supabase
        .from('contact_tags')
        .select('contact_id')
        .in('tag_id', audience.tagIds);

      if (tagError) {
        throw new Error(
          `Failed to fetch contact tags: ${tagError.message}`,
        );
      }

      if (
        contactTags &&
        contactTags.length > 0
      ) {
        const uniqueContactIds = [
          ...new Set(
            contactTags.map(
              (ct) => ct.contact_id,
            ),
          ),
        ];

        const { data, error } =
          await supabase
            .from('contacts')
            .select('*')
            .in(
              'id',
              uniqueContactIds,
            );

        if (error) {
          throw new Error(
            `Failed to fetch contacts: ${error.message}`,
          );
        }

        contacts = data ?? [];
      }
    } else if (
      audience.type === 'custom_field' &&
      audience.customField
    ) {
      contacts =
        await resolveCustomFieldAudience(
          supabase,
          audience.customField,
        );
    } else if (
      audience.type === 'csv' &&
      audience.csvContacts
    ) {
      contacts =
        await upsertCsvContacts(
          supabase,
          audience.csvContacts,
        );
    }

    if (
      audience.excludeTagIds &&
      audience.excludeTagIds.length > 0
    ) {
      const { data: excludeRows } =
        await supabase
          .from('contact_tags')
          .select('contact_id')
          .in(
            'tag_id',
            audience.excludeTagIds,
          );

      const excludedIds = new Set(
        (excludeRows ?? []).map(
          (r) => r.contact_id,
        ),
      );

      contacts = contacts.filter(
        (contact) =>
          !excludedIds.has(contact.id),
      );
    }

    return contacts;
  }

  async function upsertCsvContacts(
    supabase: ReturnType<typeof createClient>,
    csvRows: {
      phone: string;
      name?: string;
    }[],
  ): Promise<Contact[]> {
    if (csvRows.length === 0) {
      return [];
    }

    const {
      data: { session },
    } = await supabase.auth.getSession();

    const user = session?.user;

    if (!user) {
      throw new Error(
        'You are not signed in.',
      );
    }

    if (!accountId) {
      throw new Error(
        'Your profile is not linked to an account.',
      );
    }

    const uniqueByPhone = new Map<
      string,
      {
        phone: string;
        name?: string;
      }
    >();

    for (const row of csvRows) {
      const phone = row.phone.replace(
        /\D/g,
        '',
      );

      if (!phone) {
        continue;
      }

      uniqueByPhone.set(phone, {
        ...row,
        phone,
      });
    }

    const phones = [
      ...uniqueByPhone.keys(),
    ];

    if (phones.length === 0) {
      return [];
    }

    const {
      data: existing,
      error: lookupErr,
    } = await supabase
      .from('contacts')
      .select('*')
      .eq('user_id', user.id)
      .in('phone', phones);

    if (lookupErr) {
      throw new Error(
        `Failed to look up CSV contacts: ${lookupErr.message}`,
      );
    }

    const byPhone = new Map<
      string,
      Contact
    >();

    for (const contact of (existing ??
      []) as Contact[]) {
      if (contact.phone) {
        byPhone.set(
          contact.phone.replace(
            /\D/g,
            '',
          ),
          contact,
        );
      }
    }

    const missing = phones
      .filter(
        (phone) => !byPhone.has(phone),
      )
      .map((phone) => ({
        user_id: user.id,
        account_id: accountId,
        phone,
        name:
          uniqueByPhone.get(phone)
            ?.name ?? null,
      }));

    const INSERT_CHUNK = 200;

    for (
      let i = 0;
      i < missing.length;
      i += INSERT_CHUNK
    ) {
      const chunk = missing.slice(
        i,
        i + INSERT_CHUNK,
      );

      const {
        data: inserted,
        error: insertErr,
      } = await supabase
        .from('contacts')
        .insert(chunk)
        .select();

      if (insertErr) {
        throw new Error(
          `Failed to create CSV contacts: ${insertErr.message}`,
        );
      }

      for (const contact of (inserted ??
        []) as Contact[]) {
        if (contact.phone) {
          byPhone.set(
            contact.phone.replace(
              /\D/g,
              '',
            ),
            contact,
          );
        }
      }
    }

    return phones
      .map((phone) =>
        byPhone.get(phone),
      )
      .filter(
        (contact): contact is Contact =>
          Boolean(contact),
      );
  }

  async function resolveCustomFieldAudience(
    supabase: ReturnType<typeof createClient>,
    filter: CustomFieldFilter,
  ): Promise<Contact[]> {
    const {
      fieldId,
      operator,
      value,
    } = filter;

    let query = supabase
      .from('contact_custom_values')
      .select('contact_id')
      .eq(
        'custom_field_id',
        fieldId,
      );

    if (operator === 'is') {
      query = query.eq(
        'value',
        value,
      );
    } else if (
      operator === 'is_not'
    ) {
      query = query.neq(
        'value',
        value,
      );
    } else if (
      operator === 'contains'
    ) {
      query = query.ilike(
        'value',
        `%${value}%`,
      );
    }

    const {
      data: matches,
      error: matchErr,
    } = await query;

    if (matchErr) {
      throw new Error(
        `Custom-field filter failed: ${matchErr.message}`,
      );
    }

    const contactIds = [
      ...new Set(
        (matches ?? []).map(
          (match) => match.contact_id,
        ),
      ),
    ];

    if (contactIds.length === 0) {
      return [];
    }

    const { data, error } =
      await supabase
        .from('contacts')
        .select('*')
        .in(
          'id',
          contactIds,
        );

    if (error) {
      throw new Error(
        `Failed to fetch contacts: ${error.message}`,
      );
    }

    return data ?? [];
  }

  async function createAndSendBroadcast(
    payload: BroadcastPayload,
  ): Promise<string> {
    setIsProcessing(true);
    setProgress(0);

    const supabase = createClient();

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      const user = session?.user;

      if (!user) {
        throw new Error(
          'You are not signed in.',
        );
      }

      if (!accountId) {
        throw new Error(
          'Your profile is not linked to an account.',
        );
      }

      setProgress(5);

      const contacts =
        await resolveAudience(
          payload.audience,
        );

      if (contacts.length === 0) {
        throw new Error(
          'No contacts found for this audience.',
        );
      }

      setProgress(10);

      const {
        data: broadcast,
        error: broadcastError,
      } = await supabase
        .from('broadcasts')
        .insert({
          user_id: user.id,
          account_id: accountId,
          name: payload.name,
          template_name:
            payload.template.name,
          template_language:
            payload.template.language ??
            'en_US',
          template_variables:
            payload.variables,
          audience_filter: {
            type: payload.audience.type,
            tagIds:
              payload.audience.tagIds,
            customField:
              payload.audience.customField,
            excludeTagIds:
              payload.audience
                .excludeTagIds,
          },
          status: 'sending',
          total_recipients:
            contacts.length,
          sent_count: 0,
          delivered_count: 0,
          read_count: 0,
          replied_count: 0,
          failed_count: 0,
        })
        .select()
        .single();

      if (
        broadcastError ||
        !broadcast
      ) {
        throw new Error(
          `Failed to create broadcast: ${
            broadcastError?.message ??
            'unknown error'
          }`,
        );
      }

      setProgress(20);

      const customValueIndex =
        await fetchCustomValueIndex(
          supabase,
          contacts.map(
            (contact) => contact.id,
          ),
        );

      /*
       * CSV indexado pelo telefone.
       *
       * Exemplo:
       *
       * 5511999999999 -> João
       * 5511988888888888 -> Maria
       *
       * Isso garante que o nome usado na variável
       * {{1}}, {{2}}, etc. pertença ao destinatário
       * correto.
       */
      const csvByPhone = new Map<
        string,
        {
          phone: string;
          name?: string;
        }
      >();

      for (
        const csvContact of
        payload.audience
          .csvContacts ?? []
      ) {
        const phone =
          csvContact.phone.replace(
            /\D/g,
            '',
          );

        if (!phone) {
          continue;
        }

        csvByPhone.set(
          phone,
          {
            ...csvContact,
            phone,
          },
        );
      }

      const paramsByContact =
        new Map(
          contacts.map(
            (contact) => {
              const normalizedPhone =
                contact.phone.replace(
                  /\D/g,
                  '',
                );

              const csvContact =
                csvByPhone.get(
                  normalizedPhone,
                );

              return [
                contact.id,
                resolveVariables(
                  payload.variables,
                  contact,
                  customValueIndex.get(
                    contact.id,
                  ),
                  csvContact,
                ),
              ];
            },
          ),
        );

      const recipientRows =
        contacts.map(
          (contact) => ({
            broadcast_id:
              broadcast.id,
            contact_id:
              contact.id,
            status:
              'pending' as const,
            template_params:
              paramsByContact.get(
                contact.id,
              ) ?? [],
          }),
        );

      for (
        let i = 0;
        i < recipientRows.length;
        i += INSERT_BATCH_SIZE
      ) {
        const batch =
          recipientRows.slice(
            i,
            i +
              INSERT_BATCH_SIZE,
          );

        const {
          error: recipientError,
        } = await supabase
          .from(
            'broadcast_recipients',
          )
          .insert(batch);

        if (recipientError) {
          await supabase
            .from('broadcasts')
            .update({
              status: 'failed',
              failed_count:
                contacts.length,
            })
            .eq(
              'id',
              broadcast.id,
            );

          throw new Error(
            `Failed to insert recipient batch ${
              i /
                INSERT_BATCH_SIZE +
              1
            }: ${recipientError.message}`,
          );
        }
      }

      setProgress(30);

      const {
        data: recipients,
        error:
          recipientsFetchError,
      } = await supabase
        .from('broadcast_recipients')
        .select(
          '*, contact:contacts(*)',
        )
        .eq(
          'broadcast_id',
          broadcast.id,
        );

      if (
        recipientsFetchError ||
        !recipients
      ) {
        throw new Error(
          'Failed to fetch broadcast recipients',
        );
      }

      let failedCount = 0;

      const totalRecipients =
        recipients.length;

      const headerType =
        payload.template.header_type;

      const isMediaHeader =
        headerType === 'image' ||
        headerType === 'video' ||
        headerType ===
          'document';

      const headerMediaUrl =
        payload.headerMediaUrl?.trim();

      const messageParams =
        isMediaHeader &&
        headerMediaUrl
          ? {
              headerMediaUrl,
            }
          : undefined;

      for (
        let i = 0;
        i < recipients.length;
        i += SEND_BATCH_SIZE
      ) {
        const batch =
          recipients.slice(
            i,
            i +
              SEND_BATCH_SIZE,
          );

        const apiRecipients =
          batch
            .filter(
              (recipient) =>
                recipient.contact?.phone,
            )
            .map((recipient) => ({
              phone:
                recipient.contact!
                  .phone as string,

              params:
                Array.isArray(
                  recipient.template_params,
                )
                  ? recipient.template_params
                  : [],

              ...(messageParams
                ? {
                    messageParams,
                  }
                : {}),
            }));

        if (
          apiRecipients.length ===
          0
        ) {
          continue;
        }

        try {
          let data: {
            error?: string;
            results?: BroadcastApiResult[];
          } = {};

          for (
            let attempt = 1;
            ;
            attempt++
          ) {
            const res =
              await fetch(
                '/api/whatsapp/broadcast',
                {
                  method:
                    'POST',
                  headers: {
                    'Content-Type':
                      'application/json',
                  },
                  body: JSON.stringify(
                    {
                      recipients:
                        apiRecipients,
                      template_name:
                        payload
                          .template
                          .name,
                      template_language:
                        payload
                          .template
                          .language ??
                        'en_US',
                    },
                  ),
                },
              );

            data =
              await res.json();

            if (res.ok) {
              break;
            }

            const retryIn =
              attempt <
              BATCH_SEND_ATTEMPTS
                ? batchRetryDelayMs(
                    res.status,
                    res.headers.get(
                      'Retry-After',
                    ),
                  )
                : null;

            if (
              retryIn === null
            ) {
              throw new Error(
                data.error ||
                  'Broadcast API request failed',
              );
            }

            await sleep(
              retryIn,
            );
          }

          const resultsByPhone =
            new Map<
              string,
              BroadcastApiResult
            >();

          for (const result of (data.results ??
            []) as BroadcastApiResult[]) {
            resultsByPhone.set(
              result.phone,
              result,
            );
          }

          for (const recipient of batch) {
            const phone =
              recipient
                .contact?.phone;

            const result = phone
              ? resultsByPhone.get(
                  phone,
                )
              : undefined;

            if (!result) {
              failedCount++;

              await supabase
                .from(
                  'broadcast_recipients',
                )
                .update({
                  status:
                    'failed',
                  error_message:
                    'No phone number on contact',
                })
                .eq(
                  'id',
                  recipient.id,
                );

              continue;
            }

            if (
              result.status ===
              'sent'
            ) {
              await supabase
                .from(
                  'broadcast_recipients',
                )
                .update({
                  status:
                    'sent',
                  sent_at:
                    new Date().toISOString(),
                  whatsapp_message_id:
                    result.whatsapp_message_id ??
                    null,
                  error_message:
                    null,
                })
                .eq(
                  'id',
                  recipient.id,
                );
            } else {
              failedCount++;

              await supabase
                .from(
                  'broadcast_recipients',
                )
                .update({
                  status:
                    'failed',
                  error_message:
                    result.error ??
                    'Unknown error',
                })
                .eq(
                  'id',
                  recipient.id,
                );
            }
          }
        } catch (error) {
          for (const recipient of batch) {
            failedCount++;

            await supabase
              .from(
                'broadcast_recipients',
              )
              .update({
                status:
                  'failed',
                error_message:
                  error instanceof
                  Error
                    ? error.message
                    : 'Unknown error',
              })
              .eq(
                'id',
                recipient.id,
              );
          }
        }

        const progressPct =
          30 +
          Math.round(
            ((i + batch.length) /
              totalRecipients) *
              60,
          );

        setProgress(
          progressPct,
        );

        if (
          i + SEND_BATCH_SIZE <
          recipients.length
        ) {
          await sleep(
            SEND_BATCH_DELAY_MS,
          );
        }
      }

      setProgress(95);

      const finalStatus =
        failedCount ===
        totalRecipients
          ? 'failed'
          : 'sent';

      await supabase
        .from('broadcasts')
        .update({
          status: finalStatus,
        })
        .eq(
          'id',
          broadcast.id,
        );

      setProgress(100);

      return broadcast.id;
    } finally {
      setIsProcessing(false);
    }
  }

  return {
    createAndSendBroadcast,
    isProcessing,
    progress,
  };
}