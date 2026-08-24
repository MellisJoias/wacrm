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

  /**
   * If the caller does not explicitly provide a media URL,
   * retain the template's configured media URL when one exists.
   *
   * This keeps existing templates with header_media_url working
   * without forcing the frontend to duplicate that value.
   */
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

  /**
   * A contact can only receive one message per broadcast.
   *
   * Conversation identity is contact-based, so duplicate recipients
   * would otherwise produce duplicate messages in the same canonical
   * conversation.
   *
   * The first occurrence wins and therefore its template params are
   * authoritative.
   */
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

  /**
   * Migration 039 provides the current RPC signature:
   *
   *   create_broadcast_with_recipients(
   *     account_id,
   *     user_id,
   *     name,
   *     template_name,
   *     template_language,
   *     total_recipients,
   *     contact_ids,
   *     template_params,
   *     header_media_url
   *   )
   *
   * The RPC atomically creates:
   *
   *   broadcasts
   *   broadcast_recipients
   *
   * This prevents an orphaned broadcast if recipient insertion fails.
   *
   * Migration 038 freezes template_params per recipient so a later
   * resume can reconstruct {{1}}, {{2}}, etc.
   *
   * Migration 039 additionally freezes the campaign-level media URL.
   */
  const {
    data: createdRows,
    error: createErr,
  } = await db.rpc(
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
 * Persist a successful broadcast send into the canonical conversation.
 *
 * IMPORTANT:
 * This does NOT blindly create a new conversation.
 *
 * resolveConversationByPhone() resolves:
 *
 *   account_id + contact_id
 *
 * and returns the existing canonical conversation when available.
 *
 * The rendered template text is persisted in BOTH:
 *
 *   broadcast_recipients.message_text
 *   messages.content_text
 *
 * This allows the broadcast recipient record to retain the exact
 * text that was sent while the Inbox continues to use messages as
 * its canonical message history.
 */
async function persistBroadcastMessage(
  db: SupabaseClient,
  plan: BroadcastPlan,
  recipient: PlannedRecipient,
  whatsappMessageId: string,
): Promise<void> {
  // ------------------------------------------------------------
  // Render the actual text using the frozen recipient parameters
  // ------------------------------------------------------------

  const renderedText =
    templateContentText(
      plan.templateRow,
      recipient.params,
    ) ?? '';

  // ------------------------------------------------------------
  // Resolve canonical conversation
  // ------------------------------------------------------------

  const resolved =
    await resolveConversationByPhone(
      db,
      plan.accountId,
      recipient.phone,
    );

  // ------------------------------------------------------------
  // Persist text on broadcast_recipients
  // ------------------------------------------------------------

  const {
    error: recipientTextError,
  } = await db
    .from('broadcast_recipients')
    .update({
      message_text:
        renderedText,
    })
    .eq(
      'id',
      recipient.recipientRowId,
    );

  if (recipientTextError) {
    /**
     * Do not abort the message persistence if this auxiliary field
     * cannot be updated.
     *
     * The canonical messages table remains the source of truth
     * for the Inbox.
     */
    console.error(
      '[broadcast-core] failed to save broadcast recipient message text:',
      {
        broadcastId:
          plan.broadcastId,

        recipientRowId:
          recipient.recipientRowId,

        error:
          recipientTextError,
      },
    );
  }

  // ------------------------------------------------------------
  // Persist the exact Meta send
  // ------------------------------------------------------------

  const {
    error: messageError,
  } = await db
    .from('messages')
    .insert({
      conversation_id:
        resolved.conversationId,

      sender_type:
        'agent',

      sender_id:
        plan.auditUserId,

      content_type:
        'template',

      content_text:
        renderedText,

      template_name:
        plan.templateName,

      message_id:
        whatsappMessageId,

      status:
        'sent',
    });

  if (messageError) {
    /**
     * Meta has already accepted the message.
     *
     * Therefore local persistence failure must NOT turn a successful
     * WhatsApp send into a failed recipient.
     */
    console.error(
      '[broadcast-core] failed to persist sent template message:',
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

        renderedText,

        error:
          messageError,
      },
    );

    return;
  }

  // ------------------------------------------------------------
  // Update Inbox preview
  // ------------------------------------------------------------

  const {
    error: conversationError,
  } = await db
    .from('conversations')
    .update({
      last_message_text:
        renderedText,

      last_message_at:
        new Date().toISOString(),

      updated_at:
        new Date().toISOString(),
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
    /**
     * The message is already correctly persisted.
     *
     * Preview failure must not turn a successful WhatsApp send into
     * a failed recipient.
     */
    console.error(
      '[broadcast-core] failed to update conversation preview:',
      {
        broadcastId:
          plan.broadcastId,

        recipientRowId:
          recipient.recipientRowId,

        conversationId:
          resolved.conversationId,

        error:
          conversationError,
      },
    );
  }
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

    // ----------------------------------------------------------
    // Build structured send-time parameters
    // ----------------------------------------------------------

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

        lastError = message;

        /**
         * Only retry phone variants for the specific
         * "recipient not allowed" condition.
         */
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
      /**
       * Store the WAMID first.
       *
       * The inbound webhook later uses this same ID to advance
       * the recipient/message status to delivered/read.
       */
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
       * Persist the exact same Meta send into the canonical
       * conversation.
       *
       * This also stores the rendered template text in:
       *
       *   broadcast_recipients.message_text
       *   messages.content_text
       *
       * If this local operation fails, the WhatsApp message remains
       * successful because Meta already accepted it.
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

  // ------------------------------------------------------------
  // Finalize
  // ------------------------------------------------------------

  /**
   * Rejected phones do not have recipient rows.
   *
   * The persisted campaign status is therefore derived from the
   * persisted recipient rows.
   */
  await finalizeBroadcastStatus(
    db,
    plan.broadcastId,
  );
}

/**
 * Finalize a broadcast once no recipient remains pending.
 *
 * If pending rows still exist, the campaign remains "sending".
 *
 * This is important for resumable delivery.
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

  // ------------------------------------------------------------
  // Pending recipients
  // ------------------------------------------------------------

  if (
    (await countWhere(
      'pending',
    )) > 0
  ) {
    /**
     * A resumable campaign still has work.
     *
     * Keep "sending" so the UI can offer Resume.
     */
    return;
  }

  // ------------------------------------------------------------
  // Failed recipients
  // ------------------------------------------------------------

  const failed =
    await countWhere(
      'failed',
    );

  // ------------------------------------------------------------
  // Total persisted recipients
  // ------------------------------------------------------------

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

  /**
   * "failed" only when every persisted recipient failed.
   *
   * Otherwise, if at least one recipient reached Meta, the campaign
   * is considered sent and failed_count exposes partial failures.
   */
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