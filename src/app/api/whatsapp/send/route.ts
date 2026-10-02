import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  sendMessageToConversation,
  validateSendMessageParams,
  SendMessageError,
} from '@/lib/whatsapp/send-message'

// The dashboard's outbound-send endpoint. It owns auth, per-user rate
// limiting, and the two ways the UI targets a thread — an existing
// `conversation_id` (inbox) or a `contact_id` (Contact detail ->
// find-or-create the conversation).
//
// With multiple WhatsApp numbers, a new conversation created from a
// contact must explicitly identify the WhatsApp configuration through
// `whatsapp_config_id`. Existing conversations already carry their
// channel, so their configured channel is preserved.
//
// The actual Meta plumbing (validate -> send -> persist -> pause flows)
// lives in the shared `sendMessageToConversation` core.
export async function POST(request: Request) {
  try {
    // Requires the 'agent' role, matching both `canSendMessages` and the
    // `messages_modify` RLS policy (migration 017).
    const { supabase, accountId, userId } = await requireRole('agent')

    // Per-user rate limit. Bucket key is scoped to this route so
    // `/broadcast` has an independent budget.
    const limit = checkRateLimit(`send:${userId}`, RATE_LIMITS.send)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    const body = await request.json()

    const {
      // `conversation_id` targets an existing thread (inbox).
      conversation_id: conversationIdInput,

      // `contact_id` lets a caller initiate from a contact that may have
      // no conversation yet.
      contact_id,

      // Required when using `contact_id` to select which WhatsApp number
      // owns the new conversation.
      whatsapp_config_id,

      message_type,
      content_text,
      media_url,
      filename,
      template_name,
      template_language,
      template_params,
      template_message_params,
      interactive_payload,
      reply_to_message_id,
    } = body

    if ((!conversationIdInput && !contact_id) || !message_type) {
      return NextResponse.json(
        {
          error:
            'Either conversation_id or contact_id, plus message_type, are required',
        },
        { status: 400 }
      )
    }

    // Validate the message shape up front — before the contact_id path
    // finds-or-creates a conversation — so an invalid payload 400s
    // without leaving an orphan empty conversation behind.
    try {
      validateSendMessageParams({
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        templateName: template_name,
        interactivePayload: interactive_payload,
      })
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json(
          { error: err.message },
          { status: err.status }
        )
      }

      throw err
    }

    // Resolve the target conversation.
    //
    // Existing conversations already contain whatsapp_config_id, so the
    // channel selected when the conversation was created is preserved.
    //
    // For contact_id, whatsapp_config_id is required because an account
    // may now have multiple WhatsApp numbers.
    let conversationId: string | null = null

    if (conversationIdInput) {
      const { data, error: convError } = await supabase
        .from('conversations')
        .select('id, whatsapp_config_id')
        .eq('id', conversationIdInput)
        .eq('account_id', accountId)
        .single()

      if (convError || !data) {
        return NextResponse.json(
          { error: 'Conversation not found' },
          { status: 404 }
        )
      }

      if (!data.whatsapp_config_id) {
        return NextResponse.json(
          {
            error:
              'This conversation is not associated with a WhatsApp number',
          },
          { status: 400 }
        )
      }

      conversationId = data.id
    } else {
      if (!whatsapp_config_id) {
        return NextResponse.json(
          {
            error:
              'whatsapp_config_id is required when sending to a contact without a conversation',
          },
          { status: 400 }
        )
      }

      // Verify the contact is in this account first so a caller can't open
      // a conversation against someone else's contact.
      const { data: contactRow, error: contactErr } = await supabase
        .from('contacts')
        .select('id')
        .eq('id', contact_id)
        .eq('account_id', accountId)
        .maybeSingle()

      if (contactErr || !contactRow) {
        return NextResponse.json(
          { error: 'Contact not found' },
          { status: 404 }
        )
      }

      // Verify that the selected WhatsApp configuration belongs to this
      // account. This prevents a caller from attempting to create a
      // conversation using another account's channel.
      const { data: configRow, error: configErr } = await supabase
        .from('whatsapp_config')
        .select('id')
        .eq('id', whatsapp_config_id)
        .eq('account_id', accountId)
        .maybeSingle()

      if (configErr || !configRow) {
        return NextResponse.json(
          { error: 'WhatsApp configuration not found' },
          { status: 404 }
        )
      }

      const resolved = await findOrCreateConversation(
        supabase,
        accountId,
        userId,
        contact_id,
        whatsapp_config_id
      )

      if (!resolved) {
        return NextResponse.json(
          { error: 'Failed to open a conversation for this contact' },
          { status: 500 }
        )
      }

      conversationId = resolved
    }

    if (!conversationId) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      )
    }

    // Delegate to the shared send core (validates, sends to Meta with
    // phone-variant retry, persists, pauses active flow runs).
    //
    // The send core obtains the WhatsApp configuration from the
    // conversation's whatsapp_config_id, so no channel can be silently
    // switched during an existing conversation.
    try {
      const result = await sendMessageToConversation(supabase, accountId, {
        conversationId,
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        filename,
        templateName: template_name,
        templateLanguage: template_language,
        templateParams: template_params,
        templateMessageParams: template_message_params,
        interactivePayload: interactive_payload,
        replyToMessageId: reply_to_message_id,
      })

      return NextResponse.json({
        success: true,
        message_id: result.messageId,
        whatsapp_message_id: result.whatsappMessageId,
      })
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json(
          { error: err.message },
          { status: err.status }
        )
      }

      throw err
    }
  } catch (error) {
    // requireRole throws Unauthorized/Forbidden; toErrorResponse maps
    // those to 401/403 and collapses anything else to a generic 500.
    console.error('Error in WhatsApp send POST:', error)
    return toErrorResponse(error)
  }
}

type SendSupabase = Awaited<ReturnType<typeof createClient>>

/**
 * Return the contact's conversation id for the selected WhatsApp channel
 * in this account, creating one if it doesn't exist yet.
 *
 * Conversation identity is now:
 *
 *   account_id + whatsapp_config_id + contact_id
 *
 * This allows the same contact to have separate conversations with
 * different WhatsApp numbers belonging to the same account.
 *
 * Runs under the caller's RLS — the conversations_insert policy requires
 * account agent membership, which the caller already is.
 */
async function findOrCreateConversation(
  supabase: SendSupabase,
  accountId: string,
  userId: string,
  contactId: string,
  whatsappConfigId: string,
): Promise<string | null> {
  const { data: existing, error: existingError } = await supabase
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('whatsapp_config_id', whatsappConfigId)
    .maybeSingle()

  if (existingError) {
    console.error(
      'Error finding conversation for contact send:',
      existingError.message
    )
    return null
  }

  if (existing) {
    return existing.id
  }

  const { data: created, error } = await supabase
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
      whatsapp_config_id: whatsappConfigId,
    })
    .select('id')
    .single()

  if (error) {
    // Another request may have created the same channel-specific
    // conversation between our SELECT and INSERT. Recover it instead
    // of returning an unnecessary 500.
    const { data: raceWinner } = await supabase
      .from('conversations')
      .select('id')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .eq('whatsapp_config_id', whatsappConfigId)
      .maybeSingle()

    if (raceWinner) {
      return raceWinner.id
    }

    console.error(
      'Error creating conversation for contact send:',
      error.message
    )
    return null
  }

  return created.id
}