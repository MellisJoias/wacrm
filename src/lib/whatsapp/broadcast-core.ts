// ============================================================
// WhatsApp Broadcast Core
//
// DELIVERY MODEL:
//
//   Recipient 1
//      |
//      +--> await Meta
//      |
//      +--> persist result
//      |
//      +--> random delay
//      |
//      v
//   Recipient 2
//
// CONCURRENCY = 1
//
// Nunca existe Promise.all() para recipients.
//
// IMPORTANTE:
//
// O delay acontece SOMENTE entre destinatários.
// As variantes do mesmo telefone são tentadas sem delay.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';

import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';

import {
  resolveTemplateRow,
  templateContentText,
} from '@/lib/whatsapp/template-body';

import type { MessageTemplate } from '@/types';

import { findOrCreateContact } from '@/lib/api/v1/contacts';

import { createAdminClient } from '@/lib/supabase/admin';

// ============================================================
// Errors
// ============================================================

export class BroadcastError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(
    code: string,
    message: string,
    status: number,
  ) {
    super(message);

    this.name =
      'BroadcastError';

    this.code =
      code;

    this.status =
      status;
  }
}

// ============================================================
// Types
// ============================================================

export interface BroadcastRecipientInput {
  to: string;
  params?: string[];
}

export interface CreateBroadcastParams {
  name?: string | null;

  templateName: string;

  templateLanguage?: string | null;

  recipients:
    BroadcastRecipientInput[];

  headerMediaUrl?: string | null;
}

export interface PlannedRecipient {
  recipientRowId: string;

  contactId: string;

  phone: string;

  params: string[];
}

export interface BroadcastPlan {
  broadcastId: string;

  accountId: string;

  auditUserId: string;

  templateName: string;

  templateLanguage: string;

  phoneNumberId: string;

  accessToken: string;

  templateRow:
    MessageTemplate | null;

  headerMediaUrl?:
    string | null;

  planned:
    PlannedRecipient[];

  rejected: number;
}

// ============================================================
// Limits
// ============================================================

export const MAX_RECIPIENTS =
  1000;

/**
 * Quantos recipients uma execução processa.
 *
 * Continua sendo sequencial.
 *
 * Máximo de 12 recipients por pass.
 */
export const DELIVERY_BATCH_SIZE =
  12;

// ============================================================
// Broadcast delay
// ============================================================
//
// Intervalo aplicado SOMENTE depois que um destinatário
// terminou completamente.
//
// As variantes do mesmo telefone NÃO passam por este delay.
//
// Exemplo:
//
//   telefone A
//      -> variante 1
//      -> variante 2
//      -> variante 3
//      -> resultado final
//      -> DELAY 10-20s
//      -> telefone B
//
// ============================================================

export const BROADCAST_MIN_DELAY_MS =
  10_000;

export const BROADCAST_MAX_DELAY_MS =
  20_000;

/**
 * Aguarda um intervalo aleatório entre
 * 10 e 20 segundos.
 */
async function waitBetweenBroadcastRecipients(): Promise<void> {
  const min =
    BROADCAST_MIN_DELAY_MS;

  const max =
    BROADCAST_MAX_DELAY_MS;

  const delayMs =
    Math.floor(
      Math.random() *
        (max - min + 1),
    ) + min;

  console.log(
    '[broadcast-core] WAITING BETWEEN RECIPIENTS',
    {
      delayMs,

      delaySeconds:
        Math.round(
          delayMs / 1000,
        ),
    },
  );

  await new Promise<void>(
    (resolve) => {
      setTimeout(
        resolve,
        delayMs,
      );
    },
  );
}

// ============================================================
// Create broadcast
// ============================================================

export async function createBroadcast(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  params: CreateBroadcastParams,
): Promise<BroadcastPlan> {
  const {
    name,
    templateName,
    recipients,
    headerMediaUrl,
  } = params;

  if (!templateName) {
    throw new BroadcastError(
      'bad_request',
      "'template_name' is required",
      400,
    );
  }

  if (
    !Array.isArray(recipients) ||
    recipients.length === 0
  ) {
    throw new BroadcastError(
      'bad_request',
      "'recipients' must be a non-empty array of { to, params? }",
      400,
    );
  }

  if (
    recipients.length >
    MAX_RECIPIENTS
  ) {
    throw new BroadcastError(
      'bad_request',
      `A broadcast is capped at ${MAX_RECIPIENTS} recipients per request; split larger sends`,
      400,
    );
  }

  const {
    data: config,
    error: configError,
  } = await db
    .from('whatsapp_config')
    .select('*')
    .eq(
      'account_id',
      accountId,
    )
    .single();

  if (
    configError ||
    !config
  ) {
    throw new BroadcastError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400,
    );
  }

  const accessToken =
    decrypt(
      config.access_token,
    );

  const resolvedTemplate =
    await resolveTemplateRow(
      db,
      accountId,
      templateName,
      params.templateLanguage,
    );

  if (
    resolvedTemplate.malformed
  ) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
      500,
    );
  }

  const templateRow =
    resolvedTemplate.row;

  const normalizedHeaderMediaUrl =
    typeof headerMediaUrl === 'string'
      ? headerMediaUrl.trim()
      : '';

  const effectiveHeaderMediaUrl =
    normalizedHeaderMediaUrl ||
    templateRow?.header_media_url ||
    null;

  const resolved: {
    contactId: string;
    phone: string;
    params: string[];
  }[] = [];

  let rejected = 0;

  for (
    const recipient of recipients
  ) {
    const sanitized =
      sanitizePhoneForMeta(
        typeof recipient.to ===
          'string'
          ? recipient.to
          : '',
      );

    if (
      !isValidE164(
        sanitized,
      )
    ) {
      rejected++;
      continue;
    }

    const { id } =
      await findOrCreateContact(
        db,
        accountId,
        auditUserId,
        {
          phone:
            sanitized,
        },
      );

    resolved.push({
      contactId:
        id,

      phone:
        sanitized,

      params:
        Array.isArray(
          recipient.params,
        )
          ? recipient.params.filter(
              (
                value,
              ): value is string =>
                typeof value ===
                'string',
            )
          : [],
    });
  }

  const seenContact =
    new Set<string>();

  const deduped =
    resolved.filter(
      (
        recipient,
      ) => {
        if (
          seenContact.has(
            recipient.contactId,
          )
        ) {
          return false;
        }

        seenContact.add(
          recipient.contactId,
        );

        return true;
      },
    );

  if (
    deduped.length === 0
  ) {
    throw new BroadcastError(
      'bad_request',
      'No recipients had a valid E.164 phone number',
      400,
    );
  }

  const adminDb =
    createAdminClient();

  const {
    data: createdRows,
    error: createErr,
  } =
    await adminDb.rpc(
      'create_broadcast_with_recipients',
      {
        p_account_id:
          accountId,

        p_user_id:
          auditUserId,

        p_name:
          name ||
          `API broadcast (${templateName})`,

        p_template_name:
          templateName,

        p_template_language:
          resolvedTemplate.language,

        p_total_recipients:
          deduped.length,

        p_contact_ids:
          deduped.map(
            (
              recipient,
            ) =>
              recipient.contactId,
          ),

        p_template_params:
          deduped.map(
            (
              recipient,
            ) =>
              recipient.params,
          ),

        p_header_media_url:
          effectiveHeaderMediaUrl,
      },
    );

  if (
    createErr ||
    !createdRows ||
    createdRows.length === 0
  ) {
    console.error(
      '[broadcast-core] create broadcast error:',
      createErr,
    );

    throw new BroadcastError(
      'internal',
      'Failed to create broadcast',
      500,
    );
  }

  const broadcastId =
    createdRows[0]
      .broadcast_id as string;

  const byContact =
    new Map(
      deduped.map(
        (
          recipient,
        ) => [
          recipient.contactId,
          recipient,
        ],
      ),
    );

  const planned:
    PlannedRecipient[] =
    createdRows.map(
      (
        row: {
          recipient_id: string;
          contact_id: string;
        },
      ) => {
        const recipient =
          byContact.get(
            row.contact_id,
          );

        if (!recipient) {
          throw new BroadcastError(
            'internal',
            'Broadcast recipient could not be mapped to its contact',
            500,
          );
        }

        return {
          recipientRowId:
            row.recipient_id,

          contactId:
            recipient.contactId,

          phone:
            recipient.phone,

          params:
            recipient.params,
        };
      },
    );

  return {
    broadcastId,

    accountId,

    auditUserId,

    templateName,

    templateLanguage:
      resolvedTemplate.language,

    phoneNumberId:
      config.phone_number_id,

    accessToken,

    templateRow,

    headerMediaUrl:
      effectiveHeaderMediaUrl,

    planned,

    rejected,
  };
}

// ============================================================
// Limit current delivery plan
// ============================================================

export function limitBroadcastPlan(
  plan: BroadcastPlan,
): BroadcastPlan {
  return {
    ...plan,

    planned:
      plan.planned.slice(
        0,
        DELIVERY_BATCH_SIZE,
      ),
  };
}

// ============================================================
// Resolve template for persistence
// ============================================================

async function resolveBroadcastTemplateForPersistence(
  db: SupabaseClient,
  plan: BroadcastPlan,
): Promise<MessageTemplate | null> {
  if (
    plan.templateRow &&
    typeof plan.templateRow.body_text ===
      'string' &&
    plan.templateRow.body_text.length >
      0
  ) {
    return plan.templateRow;
  }

  try {
    const resolved =
      await resolveTemplateRow(
        db,
        plan.accountId,
        plan.templateName,
        plan.templateLanguage,
      );

    if (
      !resolved.malformed &&
      resolved.row &&
      typeof resolved.row.body_text ===
        'string' &&
      resolved.row.body_text.length >
        0
    ) {
      return resolved.row;
    }
  } catch (error) {
    console.error(
      '[broadcast-core] template resolution failed:',
      error,
    );
  }

  try {
    const {
      data,
      error,
    } = await db
      .from('message_templates')
      .select('*')
      .eq(
        'account_id',
        plan.accountId,
      )
      .eq(
        'name',
        plan.templateName,
      )
      .not(
        'body_text',
        'is',
        null,
      )
      .limit(20);

    if (error) {
      console.error(
        '[broadcast-core] fallback template lookup failed:',
        error,
      );

      return null;
    }

    const rows =
      Array.isArray(data)
        ? (
            data as MessageTemplate[]
          )
        : [];

    if (
      rows.length === 0
    ) {
      return null;
    }

    const wanted =
      plan.templateLanguage?.toLowerCase();

    if (wanted) {
      const exact =
        rows.find(
          (
            row,
          ) =>
            typeof row.language ===
              'string' &&
            row.language.toLowerCase() ===
              wanted &&
            !!row.body_text,
        );

      if (exact) {
        return exact;
      }

      const wantedBase =
        wanted.split(
          /[_-]/,
        )[0];

      const sameBase =
        rows.find(
          (
            row,
          ) =>
            typeof row.language ===
              'string' &&
            row.language
              .toLowerCase()
              .split(
                /[_-]/,
              )[0] ===
              wantedBase &&
            !!row.body_text,
        );

      if (sameBase) {
        return sameBase;
      }
    }

    return (
      rows.find(
        (
          row,
        ) =>
          !!row.body_text,
      ) ?? null
    );
  } catch (error) {
    console.error(
      '[broadcast-core] fallback template lookup threw:',
      error,
    );

    return null;
  }
}

// ============================================================
// Resolve canonical conversation
// ============================================================

async function resolveCanonicalConversation(
  db: SupabaseClient,
  plan: BroadcastPlan,
  recipient: PlannedRecipient,
): Promise<{
  conversationId: string;
}> {
  const {
    data: existing,
    error: lookupError,
  } = await db
    .from('conversations')
    .select('id')
    .eq(
      'account_id',
      plan.accountId,
    )
    .eq(
      'contact_id',
      recipient.contactId,
    )
    .order(
      'created_at',
      {
        ascending: true,
      },
    )
    .limit(1);

  if (lookupError) {
    console.error(
      '[broadcast-core] canonical conversation lookup failed:',
      lookupError,
    );

    throw new Error(
      'Failed to resolve canonical conversation',
    );
  }

  if (
    existing &&
    existing.length > 0
  ) {
    return {
      conversationId:
        existing[0].id,
    };
  }

  const {
    data: created,
    error: createError,
  } = await db
    .from('conversations')
    .insert({
      account_id:
        plan.accountId,

      user_id:
        plan.auditUserId,

      contact_id:
        recipient.contactId,
    })
    .select('id')
    .single();

  if (
    !createError &&
    created
  ) {
    return {
      conversationId:
        created.id,
    };
  }

  if (
    createError &&
    (
      createError.code ===
        '23505' ||
      /duplicate|unique/i.test(
        createError.message ??
          '',
      )
    )
  ) {
    const {
      data: raced,
      error: racedError,
    } = await db
      .from('conversations')
      .select('id')
      .eq(
        'account_id',
        plan.accountId,
      )
      .eq(
        'contact_id',
        recipient.contactId,
      )
      .order(
        'created_at',
        {
          ascending: true,
        },
      )
      .limit(1);

    if (
      !racedError &&
      raced &&
      raced.length > 0
    ) {
      return {
        conversationId:
          raced[0].id,
      };
    }
  }

  console.error(
    '[broadcast-core] canonical conversation creation failed:',
    createError,
  );

  throw new Error(
    'Failed to create canonical conversation',
  );
}

// ============================================================
// Persist successful message
// ============================================================

async function persistBroadcastMessage(
  db: SupabaseClient,
  plan: BroadcastPlan,
  recipient: PlannedRecipient,
  whatsappMessageId: string,
): Promise<void> {
  const templateRow =
    await resolveBroadcastTemplateForPersistence(
      db,
      plan,
    );

  const renderedText =
    templateContentText(
      templateRow,
      recipient.params,
    );

  const finalText =
    typeof renderedText ===
      'string'
      ? renderedText.trim()
      : '';

  let resolved: {
    conversationId: string;
  };

  try {
    resolved =
      await resolveCanonicalConversation(
        db,
        plan,
        recipient,
      );
  } catch (error) {
    console.error(
      '[broadcast-core] failed to resolve canonical conversation:',
      {
        broadcastId:
          plan.broadcastId,

        recipientRowId:
          recipient.recipientRowId,

        contactId:
          recipient.contactId,

        phone:
          recipient.phone,

        whatsappMessageId,

        error,
      },
    );

    return;
  }

  if (
    !resolved?.conversationId
  ) {
    return;
  }

  const {
    error:
      recipientTextError,
  } = await db
    .from('broadcast_recipients')
    .update({
      message_text:
        finalText ||
        null,
    })
    .eq(
      'id',
      recipient.recipientRowId,
    );

  if (recipientTextError) {
    console.error(
      '[broadcast-core] FAILED broadcast_recipients.message_text update:',
      recipientTextError,
    );
  }

  const {
    data: existingMessage,
    error:
      existingMessageError,
  } = await db
    .from('messages')
    .select(
      'id, conversation_id, content_text, created_at',
    )
    .eq(
      'message_id',
      whatsappMessageId,
    )
    .maybeSingle();

  if (existingMessageError) {
    console.error(
      '[broadcast-core] existing message lookup failed:',
      existingMessageError,
    );
  }

  const now =
    new Date().toISOString();

  if (
    existingMessage &&
    existingMessage.id
  ) {
    await db
      .from('conversations')
      .update({
        last_message_text:
          finalText ||
          '[template]',

        last_message_at:
          now,

        updated_at:
          now,
      })
      .eq(
        'id',
        resolved.conversationId,
      )
      .eq(
        'account_id',
        plan.accountId,
      );

    return;
  }

  const messagePayload = {
    conversation_id:
      resolved.conversationId,

    sender_type:
      'agent',

    sender_id:
      plan.auditUserId,

    content_type:
      'template',

    content_text:
      finalText ||
      null,

    template_name:
      plan.templateName,

    message_id:
      whatsappMessageId,

    status:
      'sent',
  };

  const {
    error:
      messageError,
  } = await db
    .from('messages')
    .insert(
      messagePayload,
    )
    .select('id')
    .single();

  if (
    messageError &&
    messageError.code !==
      '23505' &&
    !/duplicate|unique/i.test(
      messageError.message ??
        '',
    )
  ) {
    console.error(
      '[broadcast-core] FAILED messages INSERT:',
      messageError,
    );

    return;
  }

  await db
    .from('conversations')
    .update({
      last_message_text:
        finalText ||
        '[template]',

      last_message_at:
        now,

      updated_at:
        now,
    })
    .eq(
      'id',
      resolved.conversationId,
    )
    .eq(
      'account_id',
      plan.accountId,
    );
}

// ============================================================
// Number without WhatsApp
// ============================================================

function isNumberWithoutWhatsAppError(
  errorMessage: string,
): boolean {
  const normalized =
    errorMessage
      .toLowerCase()
      .normalize('NFD')
      .replace(
        /[\u0300-\u036f]/g,
        '',
      );

  return (
    normalized.includes(
      'not a whatsapp user',
    ) ||
    normalized.includes(
      'not registered',
    ) ||
    normalized.includes(
      'not on whatsapp',
    ) ||
    normalized.includes(
      'does not have a whatsapp',
    ) ||
    normalized.includes(
      'not a valid whatsapp',
    ) ||
    normalized.includes(
      'recipient is not a whatsapp user',
    ) ||
    normalized.includes(
      'phone number is not registered',
    ) ||
    normalized.includes(
      'recipient phone number is not registered',
    ) ||
    normalized.includes(
      'number is not registered',
    )
  );
}

// ============================================================
// DELIVERY
// ============================================================

export async function deliverBroadcast(
  db: SupabaseClient,
  plan: BroadcastPlan,
): Promise<void> {
  let processed = 0;

  let sent = 0;

  let failed = 0;

  const total =
    plan.planned.length;

  console.log(
    '[broadcast-core] STARTING SEQUENTIAL DELIVERY',
    {
      broadcastId:
        plan.broadcastId,

      total,

      concurrency: 1,

      delayRange:
        '10-20 seconds between recipients',
    },
  );

  // ----------------------------------------------------------
  // SEQUENTIAL LOOP
  // ----------------------------------------------------------

  for (
    const recipient of plan.planned
  ) {
    processed++;

    const position =
      processed;

    const startedAt =
      Date.now();

    const variants =
      phoneVariants(
        recipient.phone,
      );

    let sentMessageId:
      | string
      | null = null;

    let lastError:
      | string
      | null = null;

    let numberWithoutWhatsApp =
      false;

    const messageParams =
      plan.headerMediaUrl
        ? {
            headerMediaUrl:
              plan.headerMediaUrl,
          }
        : undefined;

    console.log(
      '[broadcast-core] START RECIPIENT',
      {
        broadcastId:
          plan.broadcastId,

        position:
          `${position}/${total}`,

        recipientRowId:
          recipient.recipientRowId,

        phone:
          recipient.phone,

        variants,
      },
    );

    // --------------------------------------------------------
    // Phone variants
    //
    // SEM delay entre variantes.
    // --------------------------------------------------------

    for (
      const variant of variants
    ) {
      try {
        console.log(
          '[broadcast-core] WAITING FOR META',
          {
            broadcastId:
              plan.broadcastId,

            position:
              `${position}/${total}`,

            phone:
              variant,
          },
        );

        const result =
          await sendTemplateMessage({
            phoneNumberId:
              plan.phoneNumberId,

            accessToken:
              plan.accessToken,

            to:
              variant,

            templateName:
              plan.templateName,

            language:
              plan.templateLanguage,

            template:
              plan.templateRow ??
              undefined,

            params:
              recipient.params,

            messageParams,
          });

        sentMessageId =
          result.messageId;

        lastError =
          null;

        console.log(
          '[broadcast-core] META ACCEPTED',
          {
            broadcastId:
              plan.broadcastId,

            position:
              `${position}/${total}`,

            phone:
              variant,

            whatsappMessageId:
              sentMessageId,

            elapsedMs:
              Date.now() -
              startedAt,
          },
        );

        break;
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Unknown error';

        lastError =
          message;

        console.error(
          '[broadcast-core] META SEND FAILED',
          {
            broadcastId:
              plan.broadcastId,

            position:
              `${position}/${total}`,

            phone:
              variant,

            error:
              message,
          },
        );

        if (
          isNumberWithoutWhatsAppError(
            message,
          )
        ) {
          numberWithoutWhatsApp =
            true;

          break;
        }

        if (
          !isRecipientNotAllowedError(
            message,
          )
        ) {
          break;
        }

        console.log(
          '[broadcast-core] trying next phone variant',
          {
            broadcastId:
              plan.broadcastId,

            recipientRowId:
              recipient.recipientRowId,

            phone:
              recipient.phone,

            failedVariant:
              variant,
          },
        );

        // Próxima variante imediatamente.
      }
    }

    // ----------------------------------------------------------
    // SUCCESS
    // ----------------------------------------------------------

    if (sentMessageId) {
      const sentAt =
        new Date().toISOString();

      const {
        error:
          recipientUpdateError,
      } = await db
        .from('broadcast_recipients')
        .update({
          status: 'sent',

          sent_at:
            sentAt,

          whatsapp_message_id:
            sentMessageId,

          error_message:
            null,
        })
        .eq(
          'id',
          recipient.recipientRowId,
        );

      if (recipientUpdateError) {
        console.error(
          '[broadcast-core] failed updating broadcast recipient:',
          recipientUpdateError,
        );
      }

      sent++;

      await persistBroadcastMessage(
        db,
        plan,
        recipient,
        sentMessageId,
      );

      console.log(
        '[broadcast-core] RECIPIENT COMPLETE',
        {
          broadcastId:
            plan.broadcastId,

          position:
            `${position}/${total}`,

          phone:
            recipient.phone,

          status:
            'sent',

          sent,

          failed,

          remaining:
            total -
            processed,

          elapsedMs:
            Date.now() -
            startedAt,
        },
      );
    } else {
      // --------------------------------------------------------
      // FAILURE
      // --------------------------------------------------------

      failed++;

      const failureMessage =
        numberWithoutWhatsApp
          ? 'Número não possui WhatsApp'
          : (
              lastError ||
              'Unknown error'
            );

      const {
        error:
          recipientUpdateError,
      } = await db
        .from('broadcast_recipients')
        .update({
          status:
            'failed',

          error_message:
            failureMessage,
        })
        .eq(
          'id',
          recipient.recipientRowId,
        );

      if (recipientUpdateError) {
        console.error(
          '[broadcast-core] failed marking recipient failed:',
          recipientUpdateError,
        );
      }

      console.warn(
        '[broadcast-core] RECIPIENT FAILED',
        {
          broadcastId:
            plan.broadcastId,

          position:
            `${position}/${total}`,

          phone:
            recipient.phone,

          reason:
            failureMessage,

          sent,

          failed,

          remaining:
            total -
            processed,

          elapsedMs:
            Date.now() -
            startedAt,
        },
      );
    }

    // ----------------------------------------------------------
    // DELAY ENTRE DESTINATÁRIOS
    // ----------------------------------------------------------
    //
    // SOMENTE aqui existe o delay.
    //
    // sucesso -> delay
    // falha -> delay
    //
    // variante 1 -> variante 2 = sem delay
    // variante 2 -> variante 3 = sem delay
    //
    // Não espera depois do último recipient do pass.
    // ----------------------------------------------------------

    if (
      processed <
      total
    ) {
      await waitBetweenBroadcastRecipients();
    }
  }

  // ----------------------------------------------------------
  // Pass finished
  // ----------------------------------------------------------

  console.log(
    '[broadcast-core] DELIVERY PASS FINISHED',
    {
      broadcastId:
        plan.broadcastId,

      total,

      processed,

      sent,

      failed,

      concurrency: 1,
    },
  );

  await finalizeBroadcastStatus(
    db,
    plan.broadcastId,
  );
}

// ============================================================
// Finalize
// ============================================================

export async function finalizeBroadcastStatus(
  db: SupabaseClient,
  broadcastId: string,
): Promise<void> {
  const countWhere =
    async (
      status: string,
    ): Promise<number> => {
      const {
        count,
        error,
      } = await db
        .from(
          'broadcast_recipients',
        )
        .select(
          'id',
          {
            count:
              'exact',

            head:
              true,
          },
        )
        .eq(
          'broadcast_id',
          broadcastId,
        )
        .eq(
          'status',
          status,
        );

      if (error) {
        console.error(
          '[broadcast-core] failed counting recipient status:',
          {
            broadcastId,
            status,
            error,
          },
        );
      }

      return count ?? 0;
    };

  const pending =
    await countWhere(
      'pending',
    );

  if (
    pending > 0
  ) {
    console.log(
      '[broadcast-core] broadcast remains sending',
      {
        broadcastId,
        pending,
      },
    );

    return;
  }

  const failed =
    await countWhere(
      'failed',
    );

  const {
    count: total,
    error: totalError,
  } = await db
    .from(
      'broadcast_recipients',
    )
    .select(
      'id',
      {
        count:
          'exact',

        head:
          true,
      },
    )
    .eq(
      'broadcast_id',
      broadcastId,
    );

  if (totalError) {
    console.error(
      '[broadcast-core] failed counting total recipients:',
      totalError,
    );

    return;
  }

  const totalCount =
    total ?? 0;

  const terminalStatus =
    failed > 0 &&
    failed === totalCount
      ? 'failed'
      : 'sent';

  const {
    error:
      updateError,
  } = await db
    .from('broadcasts')
    .update({
      status:
        terminalStatus,

      updated_at:
        new Date().toISOString(),
    })
    .eq(
      'id',
      broadcastId,
    );

  if (updateError) {
    console.error(
      '[broadcast-core] failed finalizing broadcast:',
      updateError,
    );

    return;
  }

  console.log(
    '[broadcast-core] BROADCAST FINALIZED',
    {
      broadcastId,

      status:
        terminalStatus,

      failed,

      total:
        totalCount,
    },
  );
}