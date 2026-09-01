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
 *
 * Mantém somente números.
 *
 * Para números brasileiros:
 *
 * 11999999999
 * -> 5511999999999
 *
 * 5511999999999
 * -> 5511999999999
 *
 * 1199999999
 * -> 5511999999999
 *
 * Também aceita números internacionais já completos.
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

  // Para números internacionais que já chegaram completos,
  // preservamos o valor.
  return phone;
}

/**
 * Resolve as variáveis do template para um contato específico.
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

    if (variable.type === 'custom_field') {
      return (
        customValues?.get(variable.value) ?? ''
      );
    }

    return '';
  });
}

/**
 * Carrega os valores dos campos personalizados em memória.
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

    const { data, error } = await supabase
      .from('contact_custom_values')
      .select(
        'contact_id, custom_field_id, value',
      )
      .in('contact_id', slice);

    if (error) {
      throw new Error(
        `Failed to fetch custom values: ${error.message}`,
      );
    }

    for (const row of data ?? []) {
      const bucket =
        index.get(row.contact_id) ??
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
 * Resolve audiência por campo personalizado.
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
        (match) => match.contact_id,
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
 *
 * IMPORTANTE:
 *
 * O CSV é a audiência.
 *
 * Não dependemos de a consulta do Supabase encontrar todos os
 * telefones antes de considerar a audiência válida.
 *
 * Para cada telefone:
 *
 * 1. normaliza;
 * 2. tenta reutilizar contato existente;
 * 3. se não existir, cria;
 * 4. se não conseguir obter o contato por RLS/consulta,
 *    mantém um contato temporário para o disparo.
 *
 * Isso evita que um CSV válido seja transformado em:
 *
 * No contacts found for this audience.
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
    const phone = normalizePhone(
      row.phone,
    );

    if (!phone) {
      continue;
    }

    if (!uniqueByPhone.has(phone)) {
      uniqueByPhone.set(phone, {
        phone,
        name: row.name,
      });
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
   *
   * Primeiro tentamos buscar somente os telefones necessários.
   *
   * Depois fazemos fallback para todos os contatos da conta.
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
    .eq('account_id', accountId)
    .in(
      'phone_normalized',
      phones,
    );

  if (
    !normalizedLookupError &&
    existingByNormalized
  ) {
    for (const contact of existingByNormalized as Contact[]) {
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
   *
   * Se phone_normalized não estiver preenchido corretamente
   * em algum contato antigo, buscamos os contatos da conta e
   * normalizamos o campo phone em memória.
   */
  const missingPhones = phones.filter(
    (phone) => !byPhone.has(phone),
  );

  if (missingPhones.length > 0) {
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
      for (const contact of (
        existing ?? []
      ) as Contact[]) {
        const normalized =
          normalizePhone(
            contact.phone_normalized ||
              contact.phone,
          );

        if (
          normalized &&
          !byPhone.has(normalized)
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
      (phone) => !byPhone.has(phone),
    )
    .map((phone) => ({
      user_id: userId,
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

    if (!insertErr) {
      for (const contact of (
        inserted ?? []
      ) as Contact[]) {
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
     *
     * outro processo pode ter criado o contato entre a
     * consulta e o INSERT.
     */
    if (
      insertErr.code === '23505' ||
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

      for (const contact of (
        refreshed ?? []
      ) as Contact[]) {
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
     * Não interrompemos aqui.
     *
     * O contato ainda pode ser usado pela campanha através
     * do telefone do CSV.
     */
    console.warn(
      '[broadcast] Could not create some CSV contacts:',
      insertErr.message,
    );
  }

  /**
   * ----------------------------------------------------------
   * 5. RETORNAR OS CONTATOS
   * ----------------------------------------------------------
   */
  const result: Contact[] = [];

  for (const phone of phones) {
    const existing = byPhone.get(phone);

    if (existing) {
      result.push(existing);
      continue;
    }

    /**
     * Fallback importante:
     *
     * Mesmo que o Supabase não tenha retornado o contato criado,
     * o telefone do CSV continua sendo uma audiência válida.
     *
     * Criamos um objeto local apenas para que o restante do
     * fluxo consiga montar os recipients.
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
          csvContact?.name ?? null,
      } as Contact;

    result.push(
      fallbackContact,
    );
  }

  return result;
}

/**
 * ============================================================
 * HOOK
 * ============================================================
 */
export function useBroadcastSending(): UseBroadcastSendingReturn {
  const { accountId } = useAuth();

  const [isProcessing, setIsProcessing] =
    useState(false);

  const [progress, setProgress] =
    useState(0);

  /**
   * ==========================================================
   * RESOLVE AUDIENCE
   * ==========================================================
   */
  async function resolveAudience(
    audience: AudienceConfig,
  ): Promise<Contact[]> {
    const supabase = createClient();

    let contacts: Contact[] = [];

    /**
     * --------------------------------------------------------
     * TODOS
     * --------------------------------------------------------
     */
    if (audience.type === 'all') {
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
        const uniqueContactIds = [
          ...new Set(
            contactTags.map(
              (ct) => ct.contact_id,
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
      audience.type === 'csv'
    ) {
      const {
        data: { session },
      } =
        await supabase.auth.getSession();

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

      /**
       * CSV vazio = audiência vazia.
       */
      if (
        !audience.csvContacts ||
        audience.csvContacts.length === 0
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
      audience.excludeTagIds.length > 0
    ) {
      const {
        data: excludeRows,
        error: excludeError,
      } = await supabase
        .from('contact_tags')
        .select('contact_id')
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
          (excludeRows ?? []).map(
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

    const supabase = createClient();

    try {
      /**
       * --------------------------------------------------------
       * 1. AUTENTICAÇÃO
       * --------------------------------------------------------
       */
      const {
        data: { session },
      } =
        await supabase.auth.getSession();

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

      /**
       * --------------------------------------------------------
       * 2. RESOLVE AUDIÊNCIA
       * --------------------------------------------------------
       */
      const contacts =
        await resolveAudience(
          payload.audience,
        );

      if (contacts.length === 0) {
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
            payload.audience.csvContacts
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
       *
       * Contatos temporários criados pelo fallback CSV não
       * possuem custom fields. Eles simplesmente retornam
       * valores vazios para essas variáveis.
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
       */
      const csvByPhone = new Map<
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
      const recipients = contacts
        .map((contact) => {
          const phone =
            normalizePhone(
              contact.phone,
            );

          if (!phone) {
            return null;
          }

          const csvContact =
            csvByPhone.get(phone);

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
        })
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

      console.log(
        '[broadcast] Recipients prepared:',
        {
          count:
            recipients.length,
          recipients:
            recipients.map(
              (recipient) =>
                recipient.to,
            ),
        },
      );

      setProgress(25);

      /**
       * --------------------------------------------------------
       * 7. CRIAR CAMPANHA NO SERVIDOR
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
       * 8. ERRO DO SERVIDOR
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
       * 9. ID DA CAMPANHA
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