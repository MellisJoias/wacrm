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
 * Resolve as variáveis do template para um contato específico.
 *
 * A ordem é numérica para garantir:
 *
 * {{1}}, {{2}}, {{3}}
 *
 * mesmo que o objeto venha como:
 *
 * { "2": ..., "1": ..., "3": ... }
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
 *
 * Estrutura:
 *
 * contact_id
 *   └── custom_field_id -> value
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
 * Resolve a audiência.
 *
 * Esta parte continua no navegador porque é apenas a
 * seleção dos contatos. O ENVIO das mensagens não acontece
 * mais aqui.
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
 * Resolve os contatos vindos de um CSV.
 *
 * Regra:
 *
 * 1. Normaliza os telefones.
 * 2. Procura os contatos existentes na conta usando
 *    phone_normalized.
 * 3. Se o contato já existir, REUTILIZA o contato.
 * 4. Se não existir, cria um novo contato.
 * 5. Nunca cria um segundo contato para o mesmo telefone.
 *
 * Isso é importante porque o banco possui uma restrição
 * UNIQUE baseada em:
 *
 * account_id + phone_normalized
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

  // ============================================================
  // 1. NORMALIZAR E DEDUPLICAR O CSV
  // ============================================================

  const uniqueByPhone = new Map<
    string,
    {
      phone: string;
      name?: string;
    }
  >();

  for (const row of csvRows) {
    const phone = row.phone
      .replace(/\D/g, '')
      .trim();

    if (!phone) {
      continue;
    }

    // Mantém a primeira ocorrência.
    if (!uniqueByPhone.has(phone)) {
      uniqueByPhone.set(phone, {
        ...row,
        phone,
      });
    }
  }

  const phones = [
    ...uniqueByPhone.keys(),
  ];

  if (phones.length === 0) {
    return [];
  }

  // ============================================================
  // 2. BUSCAR CONTATOS EXISTENTES DA CONTA
  //
  // Não usamos mais:
  //
  // .eq('user_id', userId)
  // .in('phone', phones)
  //
  // porque a restrição do banco é baseada em
  // account_id + phone_normalized.
  // ============================================================

  const {
    data: existing,
    error: lookupErr,
  } = await supabase
    .from('contacts')
    .select('*')
    .eq('account_id', accountId);

  if (lookupErr) {
    throw new Error(
      `Failed to look up CSV contacts: ${lookupErr.message}`,
    );
  }

  // ============================================================
  // 3. INDEXAR CONTATOS EXISTENTES PELO TELEFONE NORMALIZADO
  // ============================================================

  const byPhone = new Map<
    string,
    Contact
  >();

  for (const contact of (
    existing ?? []
  ) as Contact[]) {
    const normalized =
      contact.phone_normalized ||
      contact.phone?.replace(/\D/g, '');

    if (normalized) {
      byPhone.set(
        normalized,
        contact,
      );
    }
  }

  // ============================================================
  // 4. SE JÁ EXISTE, NÃO CRIAR
  //
  // O contato existente permanece no byPhone e será retornado
  // no final da função para participar normalmente da campanha.
  // ============================================================

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

  // ============================================================
  // 5. CRIAR SOMENTE OS CONTATOS AUSENTES
  // ============================================================

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
      /*
       * Pode acontecer uma condição de corrida:
       *
       * 1. A consulta acima verifica que o telefone não existe.
       * 2. Outro processo cria o mesmo telefone.
       * 3. Nosso INSERT chega depois.
       *
       * Nesse caso, o banco retorna 23505.
       *
       * Em vez de quebrar a campanha, fazemos uma nova leitura
       * e reutilizamos os contatos existentes.
       */

      if (
        insertErr.code === '23505' ||
        insertErr.message.includes(
          'idx_contacts_account_phone_normalized',
        )
      ) {
        const {
          data: refreshed,
          error: refreshErr,
        } = await supabase
          .from('contacts')
          .select('*')
          .eq('account_id', accountId);

        if (refreshErr) {
          throw new Error(
            `Failed to refresh CSV contacts: ${refreshErr.message}`,
          );
        }

        for (const contact of (
          refreshed ?? []
        ) as Contact[]) {
          const normalized =
            contact.phone_normalized ||
            contact.phone?.replace(/\D/g, '');

          if (normalized) {
            byPhone.set(
              normalized,
              contact,
            );
          }
        }

        continue;
      }

      throw new Error(
        `Failed to create CSV contacts: ${insertErr.message}`,
      );
    }

    // ==========================================================
    // 6. ADICIONAR OS NOVOS CONTATOS AO MAPA
    // ==========================================================

    for (const contact of (
      inserted ?? []
    ) as Contact[]) {
      const normalized =
        contact.phone_normalized ||
        contact.phone?.replace(/\D/g, '');

      if (normalized) {
        byPhone.set(
          normalized,
          contact,
        );
      }
    }
  }

  // ============================================================
  // 7. RETORNAR TODOS OS CONTATOS
  //
  // Aqui estarão:
  //
  // - contatos que já existiam
  // - contatos recém-criados
  //
  // Portanto, ambos seguem para o disparo.
  // ============================================================

  return phones
    .map((phone) =>
      byPhone.get(phone),
    )
    .filter(
      (contact): contact is Contact =>
        Boolean(contact),
    );
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

    else if (
      audience.type === 'csv' &&
      audience.csvContacts
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

      contacts =
        await upsertCsvContacts(
          supabase,
          accountId,
          user.id,
          audience.csvContacts,
        );
    }

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

  async function createAndSendBroadcast(
    payload: BroadcastPayload,
  ): Promise<string> {
    setIsProcessing(true);
    setProgress(0);

    const supabase = createClient();

    try {
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

      /*
       * ----------------------------------------------------------
       * 1. Resolve audiência
       * ----------------------------------------------------------
       *
       * O navegador apenas determina QUEM deve receber.
       *
       * Ele NÃO envia mensagens.
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

      setProgress(15);

      /*
       * ----------------------------------------------------------
       * 2. Resolve os valores das variáveis
       * ----------------------------------------------------------
       *
       * Isso é importante porque migration 038 congela
       * template_params por destinatário.
       *
       * Portanto, se o contato mudar depois, um Resume
       * continuará usando exatamente os mesmos valores.
       */
      const customValueIndex =
        await fetchCustomValueIndex(
          supabase,
          contacts.map(
            (contact) =>
              contact.id,
          ),
        );

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

      /*
       * Monta:
       *
       * [
       *   {
       *     to: "5511999999999",
       *     params: ["João", "R$ 100"]
       *   },
       *   {
       *     to: "5511988888888",
       *     params: ["Maria", "R$ 200"]
       *   }
       * ]
       */
      const recipients = contacts
        .map((contact) => {
          const phone =
            contact.phone?.replace(
              /\D/g,
              '',
            ) ?? '';

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

      if (
        recipients.length === 0
      ) {
        throw new Error(
          'No contacts with valid phone numbers were found.',
        );
      }

      setProgress(25);

      /*
       * ----------------------------------------------------------
       * 3. Cria a campanha no servidor
       * ----------------------------------------------------------
       *
       * NÃO fazemos mais:
       *
       *   broadcasts.insert()
       *   broadcast_recipients.insert()
       *   fetch('/api/whatsapp/broadcast')
       *   update recipient
       *   update broadcast
       *
       * Tudo isso pertence ao broadcast-core.
       *
       * O servidor:
       *
       * createBroadcast()
       *      ↓
       * broadcasts
       *      +
       * broadcast_recipients
       *      +
       * template_params
       *      ↓
       * deliverBroadcast()
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
                'en_US',
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

      if (!response.ok) {
        throw new Error(
          result?.error ??
            result?.message ??
            `Broadcast request failed (${response.status})`,
        );
      }

      const broadcastId =
        result?.data
          ?.broadcast_id;

      if (!broadcastId) {
        throw new Error(
          'Broadcast was accepted but no broadcast_id was returned.',
        );
      }

      /*
       * A campanha já foi persistida.
       *
       * O servidor devolve 202 e continua a entrega
       * através de after() / deliverBroadcast().
       *
       * O navegador NÃO fica mais responsável pelo envio.
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