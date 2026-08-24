// ============================================================
// Public-API broadcast core.
//
// Broadcasts are split into two phases:
//
//   createBroadcast()
//     - validates the request
//     - resolves/creates contacts
//     - deduplicates recipients
//     - atomically persists the broadcast + recipients
//     - freezes per-recipient template params
//     - persists campaign header media URL
//     - returns a delivery plan
//
//   deliverBroadcast()
//     - sends each recipient through Meta
//     - retries phone variants when appropriate
//     - persists the Meta message in the canonical conversation
//     - stores the WAMID on broadcast_recipients
//     - stores the rendered template text on broadcast_recipients
//     - finalizes the broadcast status
//
// The browser does NOT send WhatsApp messages directly.
// The route creates the plan and schedules delivery through after().
//
// Conversation identity:
//   account_id + contact_id
//
// Every successful Meta send is persisted into the SAME canonical
// conversation used by normal dashboard/inbound messaging.
//
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

import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Thrown by createBroadcast on a caller-visible failure.
 * The API route maps this into the public API error envelope.
 */
export class BroadcastError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(
    code: string,
    message: string,
    status: number,
  ) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Recipient received by the public broadcast API.
 *
 * `to` is the destination phone.
 *
 * `params` contains the positional body variables:
 *
 *   {{1}}, {{2}}, {{3}}, ...
 */
export interface BroadcastRecipientInput {
  to: string;
  params?: string[];
}

/**
 * Parameters required to create a broadcast.
 */
export interface CreateBroadcastParams {
  name?: string | null;

  templateName: string;

  templateLanguage?: string | null;

  recipients: BroadcastRecipientInput[];

  /**
   * Optional campaign-level media URL used by image/video/document
   * template headers.
   *
   * This is persisted on broadcasts.header_media_url so delivery
   * and resume can reconstruct the exact campaign later.
   */
  headerMediaUrl?: string | null;
}

interface PlannedRecipient {
  recipientRowId: string;
  contactId: string;
  phone: string;
  params: string[];
}

/**
 * Everything required by deliverBroadcast().
 *
 * The plan is intentionally self-contained because delivery happens
 * asynchronously in after().
 */
export interface BroadcastPlan {
  broadcastId: string;

  accountId: string;

  auditUserId: string;

  templateName: string;

  templateLanguage: string;

  phoneNumberId: string;

  accessToken: string;

  templateRow: MessageTemplate | null;

  /**
   * Campaign-level header media URL.
   *
   * Used for image/video/document template headers.
   *
   * Optional for backwards compatibility with existing callers/tests
   * that construct BroadcastPlan objects manually.
   */
  headerMediaUrl?: string | null;

  planned: PlannedRecipient[];

  /**
   * Phones rejected before recipient rows were created.
   *
   * These are invalid E.164 numbers.
   */
  rejected: number;
}

const MAX_RECIPIENTS = 1000;

/**
 * Validate and persist a broadcast.
 *
 * IMPORTANT:
 * Nothing is sent to Meta in this phase.
 *
 * The function only prepares the delivery plan and atomically persists
 * the campaign and recipient rows.
 */
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

  // ------------------------------------------------------------
  // Basic validation
  // ------------------------------------------------------------

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

  if (recipients.length > MAX_RECIPIENTS) {
    throw new BroadcastError(
      'bad_request',
      `A broadcast is capped at ${MAX_RECIPIENTS} recipients per request; split larger sends`,
      400,
    );
  }

  // ------------------------------------------------------------
  // WhatsApp configuration
  // ------------------------------------------------------------

  const {
    data: config,
    error: configError,
  } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single();

  if (configError || !config) {
    throw new BroadcastError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400,
    );
  }

  const accessToken = decrypt(
    config.access_token,
  );

  // ------------------------------------------------------------
  // Template
  // ------------------------------------------------------------

  const resolvedTemplate =
    await resolveTemplateRow(
      db,
      accountId,
      templateName,
      params.templateLanguage,
    );

  if (resolvedTemplate.malformed) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
      500,
    );
  }

  const templateRow =
    resolvedTemplate.row;

  // ------------------------------------------------------------
  // Header media
  // ------------------------------------------------------------

  const normalizedHeaderMediaUrl =
    typeof headerMediaUrl === 'string'
      ? headerMediaUrl.trim()
      : '';

  const effectiveHeaderMediaUrl =
    normalizedHeaderMediaUrl ||
    templateRow?.header_media_url ||
    null;

  // ------------------------------------------------------------
  // Contact resolution
  // ------------------------------------------------------------

  const resolved: {
    contactId: string;
    phone: string;
    params: string[];
  }[] = [];

  let rejected = 0;

  for (const recipient of recipients) {
    const sanitized =
      sanitizePhoneForMeta(
        typeof recipient.to === 'string'
          ? recipient.to
          : '',
      );

    if (!isValidE164(sanitized)) {
      rejected++;
      continue;
    }

    const { id } =
      await findOrCreateContact(
        db,
        accountId,
        auditUserId,
        {
          phone: sanitized,
        },
      );

    resolved.push({
      contactId: id,
      phone: sanitized,
      params: Array.isArray(
        recipient.params,
      )
        ? recipient.params.filter(
            (
              value,
            ): value is string =>
              typeof value === 'string',
          )
        : [],
    });
  }

  // ------------------------------------------------------------
  // Contact deduplication
  // ------------------------------------------------------------

  const seenContact =
    new Set<string>();

  const deduped =
    resolved.filter(
      (recipient) => {
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

  if (deduped.length === 0) {
    throw new BroadcastError(
      'bad_request',
      'No recipients had a valid E.164 phone number',
      400,
    );
  }

  // ------------------------------------------------------------
  // Atomic broadcast persistence
  // ------------------------------------------------------------

  const adminDb = createAdminClient();

  const {
    data: createdRows,
    error: createErr,
  } = await adminDb.rpc(
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
          (recipient) =>
            recipient.contactId,
        ),

      p_template_params:
        deduped.map(
          (recipient) =>
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

  // ------------------------------------------------------------
  // Map inserted rows back to resolved recipients
  // ------------------------------------------------------------

  const byContact =
    new Map(
      deduped.map(
        (recipient) => [
          recipient.contactId,
          recipient,
        ],
      ),
    );

  const planned: PlannedRecipient[] =
    createdRows.map(
      (row: {
        recipient_id: string;
        contact_id: string;
      }) => {
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

/**
 * Resolve the local template used to reconstruct the message text.
 *
 * The send has already been accepted by Meta when this function is
 * called. Therefore this function is strictly for local persistence.
 */
async function resolveBroadcastTemplateForPersistence(
  db: SupabaseClient,
  plan: BroadcastPlan,
): Promise<MessageTemplate | null> {
  if (
    plan.templateRow &&
    typeof plan.templateRow.body_text === 'string' &&
    plan.templateRow.body_text.length > 0
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
      typeof resolved.row.body_text === 'string' &&
      resolved.row.body_text.length > 0
    ) {
      return resolved.row;
    }
  } catch (error) {
    console.error(
      '[broadcast-core] template resolution failed:',
      error,
    );
  }

  /**
   * Last fallback: find any local translation containing body_text.
   */
  try {
    const {
      data,
      error,
    } = await db
      .from('message_templates')
      .select('*')
      .eq('account_id', plan.accountId)
      .eq('name', plan.templateName)
      .not('body_text', 'is', null)
      .limit(20);

    if (error) {
      console.error(
        '[broadcast-core] fallback template lookup failed:',
        {
          accountId:
            plan.accountId,

          templateName:
            plan.templateName,

          error,
        },
      );

      return null;
    }

    const rows =
      Array.isArray(data)
        ? (data as MessageTemplate[])
        : [];

    if (rows.length === 0) {
      return null;
    }

    const wanted =
      plan.templateLanguage?.toLowerCase();

    if (wanted) {
      const exact =
        rows.find(
          (row) =>
            typeof row.language === 'string' &&
            row.language.toLowerCase() === wanted &&
            !!row.body_text,
        );

      if (exact) {
        return exact;
      }

      const wantedBase =
        wanted.split(/[_-]/)[0];

      const sameBase =
        rows.find(
          (row) =>
            typeof row.language === 'string' &&
            row.language
              .toLowerCase()
              .split(/[_-]/)[0] === wantedBase &&
            !!row.body_text,
        );

      if (sameBase) {
        return sameBase;
      }
    }

    return (
      rows.find(
        (row) => !!row.body_text,
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

/**
 * Persist a successful broadcast send into the canonical conversation.
 *
 * This is the critical Inbox persistence path.
 *
 * One successful Meta send must result in:
 *
 *   broadcast_recipients.message_text
 *   messages.content_text
 *   conversations.last_message_text
 *
 * using the SAME conversation_id.
 */
async function persistBroadcastMessage(
  db: SupabaseClient,
  plan: BroadcastPlan,
  recipient: PlannedRecipient,
  whatsappMessageId: string,
): Promise<void> {
  // ------------------------------------------------------------
  // Resolve template
  // ------------------------------------------------------------

  const templateRow =
    await resolveBroadcastTemplateForPersistence(
      db,
      plan,
    );

  // ------------------------------------------------------------
  // Render exact body
  // ------------------------------------------------------------

  const renderedText =
    templateContentText(
      templateRow,
      recipient.params,
    );

  const finalText =
    typeof renderedText === 'string'
      ? renderedText.trim()
      : '';

  console.log(
    '[broadcast-core] persistence payload:',
    {
      broadcastId:
        plan.broadcastId,

      recipientRowId:
        recipient.recipientRowId,

      contactId:
        recipient.contactId,

      phone:
        recipient.phone,

      templateName:
        plan.templateName,

      templateLanguage:
        plan.templateLanguage,

      templateFound:
        !!templateRow,

      templateBody:
        templateRow?.body_text ?? null,

      templateParams:
        recipient.params,

      renderedText:
        finalText,

      whatsappMessageId,
    },
  );

  // ------------------------------------------------------------
  // Resolve canonical conversation
  // ------------------------------------------------------------

  let resolved;

  try {
    resolved =
      await resolveConversationByPhone(
        db,
        plan.accountId,
        recipient.phone,
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

        error,
      },
    );

    return;
  }

  if (!resolved?.conversationId) {
    console.error(
      '[broadcast-core] canonical conversation was not resolved:',
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
      },
    );

    return;
  }

  console.log(
    '[broadcast-core] canonical conversation resolved:',
    {
      conversationId:
        resolved.conversationId,

      contactId:
        resolved.contactId,

      broadcastId:
        plan.broadcastId,

      recipientRowId:
        recipient.recipientRowId,
    },
  );

  // ------------------------------------------------------------
  // Persist rendered text on broadcast_recipients
  // ------------------------------------------------------------

  const {
    error: recipientTextError,
  } = await db
    .from('broadcast_recipients')
    .update({
      message_text:
        finalText || null,
    })
    .eq(
      'id',
      recipient.recipientRowId,
    );

  if (recipientTextError) {
    console.error(
      '[broadcast-core] FAILED broadcast_recipients.message_text update:',
      {
        broadcastId:
          plan.broadcastId,

        recipientRowId:
          recipient.recipientRowId,

        renderedText:
          finalText,

        error:
          recipientTextError,
      },
    );
  } else {
    console.log(
      '[broadcast-core] broadcast_recipients.message_text saved:',
      {
        recipientRowId:
          recipient.recipientRowId,

        messageText:
          finalText,
      },
    );
  }

  // ------------------------------------------------------------
  // Insert canonical messages row
  // ------------------------------------------------------------

  /**
   * Do NOT skip the insert when the local template body is missing.
   *
   * The Meta message already exists.
   *
   * Persisting the canonical row is more important than silently
   * dropping the message from the Inbox.
   */
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
      finalText || null,

    template_name:
      plan.templateName,

    message_id:
      whatsappMessageId,

    status:
      'sent',
  };

  console.log(
    '[broadcast-core] inserting messages row:',
    messagePayload,
  );

  const {
    data: insertedMessage,
    error: messageError,
  } = await db
    .from('messages')
    .insert(messagePayload)
    .select('id, conversation_id, content_type, content_text, template_name, message_id, status, created_at')
    .single();

  if (messageError) {
    console.error(
      '[broadcast-core] FAILED messages INSERT:',
      {
        broadcastId:
          plan.broadcastId,

        recipientRowId:
          recipient.recipientRowId,

        conversationId:
          resolved.conversationId,

        contactId:
          resolved.contactId,

        whatsappMessageId,

        renderedText:
          finalText,

        payload:
          messagePayload,

        error:
          messageError,
      },
    );

    return;
  }

  console.log(
    '[broadcast-core] messages row inserted successfully:',
    insertedMessage,
  );

  // ------------------------------------------------------------
  // Update Inbox conversation preview
  // ------------------------------------------------------------

  const now =
    new Date().toISOString();

  const {
    error: conversationError,
  } = await db
    .from('conversations')
    .update({
      last_message_text:
        finalText || '[template]',

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

  if (conversationError) {
    console.error(
      '[broadcast-core] FAILED conversations preview update:',
      {
        broadcastId:
          plan.broadcastId,

        recipientRowId:
          recipient.recipientRowId,

        conversationId:
          resolved.conversationId,

        renderedText:
          finalText,

        error:
          conversationError,
      },
    );

    return;
  }

  console.log(
    '[broadcast-core] Inbox conversation preview updated:',
    {
      conversationId:
        resolved.conversationId,

      lastMessageText:
        finalText || '[template]',

      lastMessageAt:
        now,
    },
  );
}

/**
 * Fan out a BroadcastPlan.
 *
 * Each recipient is sent independently.
 *
 * A failure for one recipient never aborts the remaining recipients.
 *
 * This function is designed to run inside Next.js after().
 */
export async function deliverBroadcast(
  db: SupabaseClient,
  plan: BroadcastPlan,
): Promise<void> {
  for (const recipient of plan.planned) {
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

    const messageParams =
      plan.headerMediaUrl
        ? {
            headerMediaUrl:
              plan.headerMediaUrl,
          }
        : undefined;

    // ----------------------------------------------------------
    // Send through Meta
    // ----------------------------------------------------------

    for (const variant of variants) {
      try {
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

        lastError = null;

        break;
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Unknown error';

        lastError =
          message;

        console.error(
          '[broadcast-core] Meta template send failed:',
          {
            broadcastId:
              plan.broadcastId,

            recipientRowId:
              recipient.recipientRowId,

            phone:
              variant,

            templateName:
              plan.templateName,

            error:
              message,
          },
        );

        if (
          !isRecipientNotAllowedError(
            message,
          )
        ) {
          break;
        }
      }
    }

    // ------------------------------------------------------------
    // Successful send
    // ------------------------------------------------------------

    if (sentMessageId) {
      const {
        error:
          recipientUpdateError,
      } = await db
        .from(
          'broadcast_recipients',
        )
        .update({
          status:
            'sent',

          sent_at:
            new Date().toISOString(),

          whatsapp_message_id:
            sentMessageId,

          error_message:
            null,
        })
        .eq(
          'id',
          recipient.recipientRowId,
        );

      if (
        recipientUpdateError
      ) {
        console.error(
          '[broadcast-core] failed to update broadcast recipient:',
          {
            broadcastId:
              plan.broadcastId,

            recipientRowId:
              recipient.recipientRowId,

            whatsappMessageId:
              sentMessageId,

            error:
              recipientUpdateError,
          },
        );
      }

      /**
       * Critical canonical persistence.
       */
      await persistBroadcastMessage(
        db,
        plan,
        recipient,
        sentMessageId,
      );
    } else {
      // --------------------------------------------------------
      // Failed send
      // --------------------------------------------------------

      const {
        error:
          recipientUpdateError,
      } = await db
        .from(
          'broadcast_recipients',
        )
        .update({
          status:
            'failed',

          error_message:
            lastError ||
            'Unknown error',
        })
        .eq(
          'id',
          recipient.recipientRowId,
        );

      if (
        recipientUpdateError
      ) {
        console.error(
          '[broadcast-core] failed to mark broadcast recipient failed:',
          {
            broadcastId:
              plan.broadcastId,

            recipientRowId:
              recipient.recipientRowId,

            error:
              recipientUpdateError,
          },
        );
      }
    }
  }

  await finalizeBroadcastStatus(
    db,
    plan.broadcastId,
  );
}

/**
 * Finalize a broadcast once no recipient remains pending.
 *
 * If pending rows still exist, the campaign remains "sending".
 */
export async function finalizeBroadcastStatus(
  db: SupabaseClient,
  broadcastId: string,
): Promise<void> {
  const countWhere =
    async (
      status: string,
    ): Promise<number> => {
      const { count } =
        await db
          .from(
            'broadcast_recipients',
          )
          .select('id', {
            count: 'exact',
            head: true,
          })
          .eq(
            'broadcast_id',
            broadcastId,
          )
          .eq(
            'status',
            status,
          );

      return count ?? 0;
    };

  if (
    (await countWhere(
      'pending',
    )) > 0
  ) {
    return;
  }

  const failed =
    await countWhere(
      'failed',
    );

  const {
    count: total,
  } = await db
    .from(
      'broadcast_recipients',
    )
    .select('id', {
      count: 'exact',
      head: true,
    })
    .eq(
      'broadcast_id',
      broadcastId,
    );

  const terminalStatus =
    failed > 0 &&
    failed === (total ?? 0)
      ? 'failed'
      : 'sent';

  await db
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
}