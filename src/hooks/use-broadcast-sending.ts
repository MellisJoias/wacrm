'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
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

type CustomValueIndex = Map<
  string,
  Map<string, string>
>;

/**
 * ============================================================
 * NORMALIZAÇÃO DE TELEFONE
 * ============================================================
 */
function normalizePhone(
  value: string | null | undefined,
): string {
  if (!value) {
    return '';
  }

  let phone = value
    .replace(/\D/g, '')
    .trim();

  if (!phone) {
    return '';
  }

  // Remove prefixo internacional 00.
  if (phone.startsWith('00')) {
    phone = phone.slice(2);
  }

  // Brasil com +55 / 55.
  if (phone.startsWith('55')) {
    const national = phone.slice(2);

    // Celular brasileiro com 10 dígitos:
    // DDD + 8 dígitos.
    if (
      national.length === 10 &&
      national.charAt(2) !== '9'
    ) {
      return `55${national.slice(
        0,
        2,
      )}9${national.slice(2)}`;
    }

    return phone;
  }

  // Número nacional com 11 dígitos.
  if (phone.length === 11) {
    return `55${phone}`;
  }

  // Número nacional com 10 dígitos.
  if (phone.length === 10) {
    return `55${phone.slice(
      0,
      2,
    )}9${phone.slice(2)}`;
  }

  // Números internacionais já completos.
  return phone;
}

/**
 * ============================================================
 * RESOLVE VARIÁVEIS
 * ============================================================
 *
 * Resolve:
 *
 * {{1}} -> static
 * {{1}} -> field
 * {{1}} -> custom_field
 * {{1}} -> CSV
 *
 * A ordem é numérica:
 *
 * {{1}}, {{2}}, {{3}}
 */
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

    if (!variable) {
      return '';
    }

    if (variable.type === 'static') {
      return variable.value ?? '';
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

    /**
     * --------------------------------------------------------
     * CSV
     * --------------------------------------------------------
     *
     * IMPORTANTE:
     *
     * Se a configuração for:
     *
     * {{1}} -> CSV -> name
     *
     * o valor vem EXCLUSIVAMENTE da linha correspondente
     * do CSV.
     */
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

    if (variable.type === 'custom_field') {
      return (
        customValues?.get(
          variable.value,
        ) ?? ''
      );
    }

    return '';
  });
}

/**
 * ============================================================
 * CARREGA CAMPOS PERSONALIZADOS
 * ============================================================
 */
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

    const {
      data,
      error,
    } = await supabase
      .from('contact_custom_values')
      .select(
        'contact_id, custom_field_id, value',
      )
      .in(
        'contact_id',
        slice,
      );

    if (error) {
      throw new Error(
        `Failed to fetch custom values: ${error.message}`,
      );
    }

    for (const row of data ?? []) {
      const bucket =
        index.get(
          row.contact_id,
        ) ??
        new Map<string, string>();

      bucket.set(
        row.custom_field_id,
        row.value ?? '',
      );

      index.set(
        row.contact_id,
        bucket,
      );
    }
  }

  return index;
}

/**
 * ============================================================
 * RESOLVE AUDIÊNCIA POR CAMPO PERSONALIZADO
 * ============================================================
 */
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
        (match) =>
          match.contact_id,
      ),
    ),
  ];

  if (contactIds.length === 0) {
    return [];
  }

  const {
    data,
    error,
  } = await supabase
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

/**
 * ============================================================
 * CSV -> CONTACTS
 * ============================================================
 */
async function upsertCsvContacts(
  supabase: ReturnType<typeof createClient>,
  accountId: string,
  userId: string,
  csvRows: {
    phone: string;
    name?: string;
  }[],
): Promise<Contact[]> {
  if (csvRows.length === 0) {
    return [];
  }

  /**
   * ----------------------------------------------------------
   * 1. NORMALIZAR CSV
   * ----------------------------------------------------------
   */
  const uniqueByPhone = new Map<
    string,
    {
      phone: string;
      name?: string;
    }
  >();

  for (const row of csvRows) {
    const phone =
      normalizePhone(
        row.phone,
      );

    if (!phone) {
      continue;
    }

    if (!uniqueByPhone.has(phone)) {
      uniqueByPhone.set(
        phone,
        {
          phone,
          name: row.name,
        },
      );
    }
  }

  const phones = [
    ...uniqueByPhone.keys(),
  ];

  if (phones.length === 0) {
    return [];
  }

  /**
   * ----------------------------------------------------------
   * 2. BUSCAR CONTATOS EXISTENTES
   * ----------------------------------------------------------
   */
  const byPhone = new Map<
    string,
    Contact
  >();

  const {
    data: existingByNormalized,
    error: normalizedLookupError,
  } = await supabase
    .from('contacts')
    .select('*')
    .eq(
      'account_id',
      accountId,
    )
    .in(
      'phone_normalized',
      phones,
    );

  if (
    !normalizedLookupError &&
    existingByNormalized
  ) {
    for (const contact of
      existingByNormalized as Contact[]) {
      const normalized =
        normalizePhone(
          contact.phone_normalized ||
            contact.phone,
        );

      if (normalized) {
        byPhone.set(
          normalized,
          contact,
        );
      }
    }
  }

  /**
   * ----------------------------------------------------------
   * 3. FALLBACK
   * ----------------------------------------------------------
   */
  const missingPhones =
    phones.filter(
      (phone) =>
        !byPhone.has(phone),
    );

  if (
    missingPhones.length > 0
  ) {
    const {
      data: existing,
      error: lookupErr,
    } = await supabase
      .from('contacts')
      .select('*')
      .eq(
        'account_id',
        accountId,
      );

    if (!lookupErr) {
      for (const contact of
        (existing ?? []) as Contact[]) {
        const normalized =
          normalizePhone(
            contact.phone_normalized ||
              contact.phone,
          );

        if (
          normalized &&
          !byPhone.has(
            normalized,
          )
        ) {
          byPhone.set(
            normalized,
            contact,
          );
        }
      }
    }
  }

  /**
   * ----------------------------------------------------------
   * 4. CRIAR CONTATOS AUSENTES
   * ----------------------------------------------------------
   */
  const missing = phones
    .filter(
      (phone) =>
        !byPhone.has(phone),
    )
    .map((phone) => ({
      user_id: userId,
      account_id: accountId,
      phone,
      name:
        uniqueByPhone.get(
          phone,
        )?.name ?? null,
    }));

  const INSERT_CHUNK = 200;

  for (
    let i = 0;
    i < missing.length;
    i += INSERT_CHUNK
  ) {
    const chunk =
      missing.slice(
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

    if (!insertErr) {
      for (const contact of
        (inserted ?? []) as Contact[]) {
        const normalized =
          normalizePhone(
            contact.phone_normalized ||
              contact.phone,
          );

        if (normalized) {
          byPhone.set(
            normalized,
            contact,
          );
        }
      }

      continue;
    }

    /**
     * Condição de corrida:
     * outro processo pode ter criado o contato.
     */
    if (
      insertErr.code ===
        '23505' ||
      insertErr.message.includes(
        'idx_contacts_account_phone_normalized',
      )
    ) {
      const {
        data: refreshed,
      } = await supabase
        .from('contacts')
        .select('*')
        .eq(
          'account_id',
          accountId,
        );

      for (const contact of
        (refreshed ?? []) as Contact[]) {
        const normalized =
          normalizePhone(
            contact.phone_normalized ||
              contact.phone,
          );

        if (normalized) {
          byPhone.set(
            normalized,
            contact,
          );
        }
      }

      continue;
    }

    console.warn(
      '[broadcast] Could not create some CSV contacts:',
      insertErr.message,
    );
  }

  /**
   * ----------------------------------------------------------
   * 5. RETORNAR CONTATOS
   * ----------------------------------------------------------
   */
  const result: Contact[] = [];

  for (const phone of phones) {
    const existing =
      byPhone.get(phone);

    if (existing) {
      result.push(existing);
      continue;
    }

    /**
     * Fallback:
     * o telefone do CSV continua sendo uma audiência válida.
     */
    const csvContact =
      uniqueByPhone.get(phone);

    const fallbackContact =
      {
        id: `csv-${phone}`,
        user_id: userId,
        account_id: accountId,
        phone,
        phone_normalized: phone,
        name:
          csvContact?.name ??
          null,
      } as Contact;

    result.push(
      fallbackContact,
    );
  }

  return result;
}

/**
 * ============================================================
 * EXTRAI A QUANTIDADE DE VARIÁVEIS DO BODY DO TEMPLATE
 * ============================================================
 */
function getBodyVariableCount(
  template: MessageTemplate,
): number {
  const bodyText =
    typeof template.body_text ===
    'string'
      ? template.body_text
      : '';

  if (!bodyText) {
    return 0;
  }

  const matches =
    bodyText.match(
      /\{\{\s*(\d+)\s*\}\}/g,
    );

  if (!matches) {
    return 0;
  }

  const indices =
    matches
      .map((match) => {
        const found =
          match.match(
            /\{\{\s*(\d+)\s*\}\}/,
          );

        return found
          ? Number(found[1])
          : 0;
      })
      .filter(
        (value) =>
          Number.isFinite(value) &&
          value > 0,
      );

  if (indices.length === 0) {
    return 0;
  }

  return Math.max(
    ...indices,
  );
}

/**
 * ============================================================
 * HOOK
 * ============================================================
 */
export function useBroadcastSending(): UseBroadcastSendingReturn {
  const { accountId } =
    useAuth();

  const [
    isProcessing,
    setIsProcessing,
  ] = useState(false);

  const [
    progress,
    setProgress,
  ] = useState(0);

  /**
   * ==========================================================
   * RESOLVE AUDIENCE
   * ==========================================================
   */
  async function resolveAudience(
    audience: AudienceConfig,
  ): Promise<Contact[]> {
    const supabase =
      createClient();

    let contacts: Contact[] = [];

    /**
     * --------------------------------------------------------
     * TODOS
     * --------------------------------------------------------
     */
    if (
      audience.type === 'all'
    ) {
      const {
        data,
        error,
      } = await supabase
        .from('contacts')
        .select('*');

      if (error) {
        throw new Error(
          `Failed to fetch contacts: ${error.message}`,
        );
      }

      contacts = data ?? [];
    }

    /**
     * --------------------------------------------------------
     * TAGS
     * --------------------------------------------------------
     */
    else if (
      audience.type ===
        'tags' &&
      audience.tagIds &&
      audience.tagIds.length > 0
    ) {
      const {
        data: contactTags,
        error: tagError,
      } = await supabase
        .from('contact_tags')
        .select(
          'contact_id',
        )
        .in(
          'tag_id',
          audience.tagIds,
        );

      if (tagError) {
        throw new Error(
          `Failed to fetch contact tags: ${tagError.message}`,
        );
      }

      if (
        contactTags &&
        contactTags.length > 0
      ) {
        const uniqueContactIds =
          [
            ...new Set(
              contactTags.map(
                (ct) =>
                  ct.contact_id,
              ),
            ),
          ];

        const {
          data,
          error,
        } = await supabase
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
    }

    /**
     * --------------------------------------------------------
     * CAMPO PERSONALIZADO
     * --------------------------------------------------------
     */
    else if (
      audience.type ===
        'custom_field' &&
      audience.customField
    ) {
      contacts =
        await resolveCustomFieldAudience(
          supabase,
          audience.customField,
        );
    }

    /**
     * --------------------------------------------------------
     * CSV
     * --------------------------------------------------------
     */
    else if (
      audience.type ===
      'csv'
    ) {
      const {
        data: {
          session,
        },
      } =
        await supabase.auth.getSession();

      const user =
        session?.user;

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

      if (
        !audience.csvContacts ||
        audience.csvContacts
          .length === 0
      ) {
        return [];
      }

      contacts =
        await upsertCsvContacts(
          supabase,
          accountId,
          user.id,
          audience.csvContacts,
        );
    }

    /**
     * --------------------------------------------------------
     * EXCLUSÕES
     * --------------------------------------------------------
     */
    if (
      audience.excludeTagIds &&
      audience.excludeTagIds
        .length > 0
    ) {
      const {
        data: excludeRows,
        error: excludeError,
      } = await supabase
        .from('contact_tags')
        .select(
          'contact_id',
        )
        .in(
          'tag_id',
          audience.excludeTagIds,
        );

      if (excludeError) {
        throw new Error(
          `Failed to fetch excluded contacts: ${excludeError.message}`,
        );
      }

      const excludedIds =
        new Set(
          (
            excludeRows ??
            []
          ).map(
            (row) =>
              row.contact_id,
          ),
        );

      contacts =
        contacts.filter(
          (contact) =>
            !excludedIds.has(
              contact.id,
            ),
        );
    }

    return contacts;
  }

  /**
   * ==========================================================
   * CREATE AND SEND BROADCAST
   * ==========================================================
   */
  async function createAndSendBroadcast(
    payload: BroadcastPayload,
  ): Promise<string> {
    setIsProcessing(true);
    setProgress(0);

    const supabase =
      createClient();

    try {
      /**
       * --------------------------------------------------------
       * 1. AUTENTICAÇÃO
       * --------------------------------------------------------
       */
      const {
        data: {
          session,
        },
      } =
        await supabase.auth.getSession();

      const user =
        session?.user;

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

      /**
       * --------------------------------------------------------
       * 2. RESOLVE AUDIÊNCIA
       * --------------------------------------------------------
       */
      const contacts =
        await resolveAudience(
          payload.audience,
        );

      if (
        contacts.length === 0
      ) {
        throw new Error(
          'No contacts found for this audience.',
        );
      }

      console.log(
        '[broadcast] Audience resolved:',
        {
          type:
            payload.audience.type,
          csvCount:
            payload.audience
              .csvContacts
              ?.length ?? 0,
          resolvedCount:
            contacts.length,
        },
      );

      setProgress(15);

      /**
       * --------------------------------------------------------
       * 3. CUSTOM VALUES
       * --------------------------------------------------------
       */
      const realContactIds =
        contacts
          .map(
            (contact) =>
              contact.id,
          )
          .filter(
            (id) =>
              !id.startsWith(
                'csv-',
              ),
          );

      const customValueIndex =
        await fetchCustomValueIndex(
          supabase,
          realContactIds,
        );

      /**
       * --------------------------------------------------------
       * 4. INDEX CSV
       * --------------------------------------------------------
       *
       * A linha original do CSV é preservada.
       *
       * O telefone normalizado é usado somente como chave.
       *
       * Isso garante:
       *
       * CSV:
       * 5511999999999 | Maria
       *
       * ->
       *
       * {{1}} = Maria
       */
      const csvByPhone =
        new Map<
          string,
          {
            phone: string;
            name?: string;
          }
        >();

      for (const csvContact of
        payload.audience
          .csvContacts ?? []) {
        const phone =
          normalizePhone(
            csvContact.phone,
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

      /**
       * --------------------------------------------------------
       * 5. MONTAR RECIPIENTS
       * --------------------------------------------------------
       */
      let recipients:
        {
          to: string;
          params: string[];
        }[] = [];

      /**
       * ========================================================
       * CSV
       * ========================================================
       *
       * Para CSV, usamos a própria lista CSV como origem dos
       * recipients.
       *
       * Isso evita depender de qualquer diferença entre:
       *
       * CSV name
       *
       * e
       *
       * contacts.name
       *
       * no Supabase.
       */
      if (
        payload.audience.type ===
          'csv' &&
        payload.audience
          .csvContacts &&
        payload.audience
          .csvContacts.length > 0
      ) {
        recipients =
          payload.audience
            .csvContacts
            .map(
              (
                csvRow,
              ) => {
                const phone =
                  normalizePhone(
                    csvRow.phone,
                  );

                if (!phone) {
                  return null;
                }

                /**
                 * Encontra o contato correspondente apenas
                 * para campos que não são CSV.
                 */
                const contact =
                  contacts.find(
                    (
                      item,
                    ) =>
                      normalizePhone(
                        item.phone,
                      ) ===
                      phone,
                  ) ??
                  ({
                    id: `csv-${phone}`,
                    user_id:
                      user.id,
                    account_id:
                      accountId,
                    phone,
                    phone_normalized:
                      phone,
                    name:
                      csvRow.name ??
                      null,
                  } as Contact);

                const csvContact =
                  csvByPhone.get(
                    phone,
                  ) ?? {
                    phone,
                    name:
                      csvRow.name,
                  };

                const params =
                  resolveVariables(
                    payload.variables,
                    contact,
                    customValueIndex.get(
                      contact.id,
                    ),
                    csvContact,
                  );

                return {
                  to: phone,
                  params,
                };
              },
            )
            .filter(
              (
                recipient,
              ): recipient is {
                to: string;
                params: string[];
              } =>
                Boolean(
                  recipient,
                ),
            );
      } else {
        /**
         * ======================================================
         * CONTATOS NORMAIS
         * ======================================================
         */
        recipients =
          contacts
            .map(
              (
                contact,
              ) => {
                const phone =
                  normalizePhone(
                    contact.phone,
                  );

                if (!phone) {
                  return null;
                }

                const params =
                  resolveVariables(
                    payload.variables,
                    contact,
                    customValueIndex.get(
                      contact.id,
                    ),
                    undefined,
                  );

                return {
                  to: phone,
                  params,
                };
              },
            )
            .filter(
              (
                recipient,
              ): recipient is {
                to: string;
                params: string[];
              } =>
                Boolean(
                  recipient,
                ),
            );
      }

      /**
       * --------------------------------------------------------
       * 6. VALIDAR RECIPIENTS
       * --------------------------------------------------------
       */
      if (
        recipients.length === 0
      ) {
        throw new Error(
          'No contacts with valid phone numbers were found.',
        );
      }

      /**
       * --------------------------------------------------------
       * 7. VALIDAR VARIÁVEIS DO TEMPLATE
       * --------------------------------------------------------
       *
       * Exemplo:
       *
       * Template:
       *
       * Olá {{1}}
       *
       * exige pelo menos:
       *
       * params: ['Maria']
       *
       * Nunca permitimos:
       *
       * params: []
       *
       * porque isso causaria:
       *
       * Body has 1 variable(s) but only 0 value(s)
       */
      const bodyVariableCount =
        getBodyVariableCount(
          payload.template,
        );

      if (
        bodyVariableCount > 0
      ) {
        const invalidRecipients =
          recipients.filter(
            (recipient) =>
              recipient.params
                .length <
              bodyVariableCount,
          );

        if (
          invalidRecipients.length >
          0
        ) {
          console.error(
            '[broadcast] Recipients with missing template parameters:',
            invalidRecipients.map(
              (recipient) => ({
                to:
                  recipient.to,
                params:
                  recipient.params,
              }),
            ),
          );

          throw new Error(
            `The template requires ${bodyVariableCount} body variable(s), but ${invalidRecipients.length} recipient(s) do not have enough values. Check the CSV variable mapping.`,
          );
        }
      }

      /**
       * --------------------------------------------------------
       * LOG DETALHADO
       * --------------------------------------------------------
       *
       * Mantido para facilitar diagnóstico de campanhas.
       *
       * NÃO imprime o conteúdo completo de todos os recipients
       * quando a campanha é grande.
       */
      console.log(
        '[broadcast] Recipients prepared:',
        {
          count:
            recipients.length,
          bodyVariableCount,
          variableMappings:
            payload.variables,
          sample:
            recipients
              .slice(0, 10)
              .map(
                (
                  recipient,
                ) => ({
                  to:
                    recipient.to,
                  params:
                    recipient.params,
                }),
              ),
        },
      );

      setProgress(25);

      /**
       * --------------------------------------------------------
       * 8. CRIAR CAMPANHA NO SERVIDOR
       * --------------------------------------------------------
       *
       * O navegador NÃO envia WhatsApp.
       *
       * Ele somente entrega a campanha ao endpoint:
       *
       * POST /api/v1/broadcasts
       *
       * O broadcast-core fica responsável por:
       *
       * broadcasts
       * broadcast_recipients
       * template_params
       * entrega
       * retry
       * status
       */
      const response =
        await fetch(
          '/api/v1/broadcasts',
          {
            method: 'POST',
            headers: {
              'Content-Type':
                'application/json',
              Accept:
                'application/json',
            },
            credentials:
              'include',
            body: JSON.stringify({
              name:
                payload.name,
              template_name:
                payload.template
                  .name,
              template_language:
                payload.template
                  .language ??
                'pt_BR',
              recipients,
            }),
          },
        );

      let result:
        | {
            data?: {
              broadcast_id?: string;
              status?: string;
              total_recipients?: number;
              accepted?: number;
              rejected?: number;
            };
            error?: string;
            message?: string;
          }
        | null = null;

      try {
        result =
          await response.json();
      } catch {
        result = null;
      }

      console.log(
        '[broadcast] API response:',
        {
          status:
            response.status,
          ok:
            response.ok,
          result,
        },
      );

      /**
       * --------------------------------------------------------
       * 9. ERRO DO SERVIDOR
       * --------------------------------------------------------
       */
      if (!response.ok) {
        throw new Error(
          result?.error ??
            result?.message ??
            `Broadcast request failed (${response.status})`,
        );
      }

      /**
       * --------------------------------------------------------
       * 10. ID DA CAMPANHA
       * --------------------------------------------------------
       */
      const broadcastId =
        result?.data
          ?.broadcast_id;

      if (!broadcastId) {
        throw new Error(
          'Broadcast was accepted but no broadcast_id was returned.',
        );
      }

      /**
       * A campanha já foi persistida.
       *
       * O servidor continua a entrega.
       */
      setProgress(100);

      return broadcastId;
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