import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { getMediaUrl } from '@/lib/whatsapp/meta-api'
import { mirrorInboundMedia } from '@/lib/whatsapp/mirror-inbound-media'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook'

export const maxDuration = 60

// Lazy-initialized to avoid build-time crash when env vars are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null

function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }

  return _adminClient
}

interface WhatsAppContactCard {
  addresses?: Array<{
    city?: string
    country?: string
    country_code?: string
    state?: string
    street?: string
    type?: string
    zip?: string
  }>
  birthday?: string
  emails?: Array<{
    email?: string
    type?: string
  }>
  name?: {
    first_name?: string
    formatted_name?: string
    last_name?: string
    middle_name?: string
    prefix?: string
    suffix?: string
  }
  org?: {
    company?: string
    department?: string
    title?: string
  }
  phones?: Array<{
    phone?: string
    type?: string
    wa_id?: string
  }>
  urls?: Array<{
    url?: string
    type?: string
  }>
}

interface WhatsAppMessage {
  id: string
  from: string
  timestamp: string
  type: string

  text?: {
    body: string
  }

  image?: {
    id: string
    mime_type: string
    caption?: string
  }

  video?: {
    id: string
    mime_type: string
    caption?: string
  }

  document?: {
    id: string
    mime_type: string
    filename?: string
    caption?: string
  }

  audio?: {
    id: string
    mime_type: string
  }

  sticker?: {
    id: string
    mime_type: string
  }

  location?: {
    latitude: number
    longitude: number
    name?: string
    address?: string
  }

  /**
   * WhatsApp sends shared contact cards using:
   *
   * type: "contacts"
   * contacts: [...]
   */
  contacts?: WhatsAppContactCard[]

  reaction?: {
    message_id: string
    emoji: string
  }

  interactive?: {
    type: 'button_reply' | 'list_reply'
    button_reply?: {
      id: string
      title: string
    }
    list_reply?: {
      id: string
      title: string
      description?: string
    }
  }

  /**
   * Quick-reply tap on a WhatsApp template.
   */
  button?: {
    text?: string
    payload?: string
  }

  /**
   * Present when the customer replies to one of our messages.
   */
  context?: {
    id: string
  }
}

interface WhatsAppWebhookEntry {
  id: string

  changes: Array<{
    value: {
      messaging_product: string

      metadata: {
        display_phone_number: string
        phone_number_id: string
      }

      contacts?: Array<{
        profile: {
          name: string
        }
        wa_id: string
      }>

      messages?: WhatsAppMessage[]

      statuses?: Array<{
        id: string
        status: string
        timestamp: string
        recipient_id: string

        // ======================================================
        // Meta sends this array when a message fails.
        // ======================================================
        errors?: Array<{
          code?: number
          title?: string
          message?: string
          error_data?: {
            details?: string
          }
        }>
      }>
    }

    field: string
  }>
}

// ============================================================
// GET - Webhook verification
// ============================================================

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)

    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      )
    }

    const { data: configs, error: configError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('id, verify_token')

    if (configError || !configs) {
      console.error(
        'Error fetching configs for verification:',
        configError
      )

      return NextResponse.json(
        { error: 'Verification failed' },
        { status: 403 }
      )
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let matchedConfig: any = null

    for (const config of configs) {
      if (!config.verify_token) continue

      try {
        if (decrypt(config.verify_token) === verifyToken) {
          matchedConfig = config
          break
        }
      } catch {
        // Invalid/malformed token. Continue checking other configs.
      }
    }

    if (matchedConfig) {
      if (isLegacyFormat(matchedConfig.verify_token)) {
        void supabaseAdmin()
          .from('whatsapp_config')
          .update({
            verify_token: encrypt(verifyToken),
          })
          .eq('id', matchedConfig.id)
          .then(({ error }: { error: unknown }) => {
            if (error) {
              console.warn(
                '[webhook] verify_token GCM upgrade failed:',
                (error as { message?: string })?.message ?? error
              )
            }
          })
      }

      return new Response(challenge, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain',
        },
      })
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    )
  } catch (error) {
    console.error(
      'Error in webhook GET verification:',
      error
    )

    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// ============================================================
// POST - Receive messages
// ============================================================

export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    console.warn(
      '[webhook] rejected request with invalid signature'
    )

    return NextResponse.json(
      { error: 'Invalid signature' },
      { status: 401 }
    )
  }

  let body: {
    entry?: WhatsAppWebhookEntry[]
  }

  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON' },
      { status: 400 }
    )
  }

  after(async () => {
    try {
      await processWebhook(body)
    } catch (error) {
      console.error(
        'Error processing webhook:',
        error
      )
    }
  })

  return NextResponse.json(
    { status: 'received' },
    { status: 200 }
  )
}

// ============================================================
// Webhook processing
// ============================================================

async function processWebhook(
  body: {
    entry?: WhatsAppWebhookEntry[]
  }
) {
  if (!body.entry) return

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      if (isTemplateWebhookField(change.field)) {
        await handleTemplateWebhookChange(
          {
            field: change.field,
            value: change.value as unknown,
          },
          supabaseAdmin()
        )

        continue
      }

      const value = change.value

      // --------------------------------------------------------
      // Status updates
      // --------------------------------------------------------

      if (value.statuses) {
        for (const status of value.statuses) {
          await handleStatusUpdate(status)
        }
      }

      // --------------------------------------------------------
      // Incoming messages
      //
      // IMPORTANT:
      // value.contacts here is the Meta webhook sender metadata.
      //
      // message.contacts is the actual shared WhatsApp contact card.
      // --------------------------------------------------------

      if (!value.messages || !value.contacts) continue

      const phoneNumberId = value.metadata.phone_number_id

      const { data: configRows, error: configError } =
        await supabaseAdmin()
          .from('whatsapp_config')
          .select('*')
          .eq('phone_number_id', phoneNumberId)

      if (configError) {
        console.error(
          'Error fetching whatsapp_config for phone_number_id:',
          phoneNumberId,
          configError
        )

        continue
      }

      if (!configRows || configRows.length === 0) {
        console.error(
          'No config found for phone_number_id:',
          phoneNumberId
        )

        continue
      }

      if (configRows.length > 1) {
        console.error(
          `Multiple configs (${configRows.length}) found for phone_number_id:`,
          phoneNumberId,
          '— inbound message dropped.',
          'Account owners:',
          configRows.map(
            (r: {
              account_id: string
              user_id: string
            }) =>
              `${r.account_id} (admin ${r.user_id})`
          )
        )

        continue
      }

      const config = configRows[0]

      const decryptedAccessToken = decrypt(
        config.access_token
      )

      for (
        let i = 0;
        i < value.messages.length;
        i++
      ) {
        const message = value.messages[i]

        const senderContact =
          value.contacts[i] ||
          value.contacts[0]

        await processMessage(
          message,
          senderContact,
          config.account_id,
          config.user_id,
          decryptedAccessToken,
          config.mirror_inbound_media !== false
        )
      }
    }
  }
}

// ============================================================
// Broadcast status ladder
// ============================================================

const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const

function ladderLevel(
  status: string
): number {
  const idx =
    (
      RECIPIENT_STATUS_LADDER as readonly string[]
    ).indexOf(status)

  return idx < 0 ? -1 : idx
}

function isValidStatusTransition(
  current: string,
  incoming: string
): boolean {
  if (incoming === 'failed') {
    return (
      current === 'pending' ||
      current === 'sent'
    )
  }

  if (current === 'failed') {
    return false
  }

  const currentLevel =
    ladderLevel(current)

  const incomingLevel =
    ladderLevel(incoming)

  if (incomingLevel < 0) {
    return false
  }

  if (currentLevel < 0) {
    return true
  }

  return incomingLevel > currentLevel
}

// ============================================================
// Handle status update
// ============================================================

async function handleStatusUpdate(status: {
  id: string
  status: string
  timestamp: string
  recipient_id: string

  // ============================================================
  // Meta sends this array when a message fails.
  // ============================================================
  errors?: Array<{
    code?: number
    title?: string
    message?: string
    error_data?: {
      details?: string
    }
  }>
}) {
  const { error: msgErr } =
    await supabaseAdmin()
      .from('messages')
      .update({
        status: status.status,
      })
      .eq('message_id', status.id)

  if (msgErr) {
    console.error(
      'Error updating message status:',
      msgErr
    )
  }

  const tsIso =
    new Date(
      parseInt(status.timestamp) * 1000
    ).toISOString()

  const {
    data: recipient,
    error: recFetchErr,
  } = await supabaseAdmin()
    .from('broadcast_recipients')
    .select('id, status')
    .eq(
      'whatsapp_message_id',
      status.id
    )
    .maybeSingle()

  if (recFetchErr) {
    console.error(
      'Error fetching broadcast recipient:',
      recFetchErr
    )
  } else if (
    recipient &&
    isValidStatusTransition(
      recipient.status,
      status.status
    )
  ) {
    const update: Record<
      string,
      unknown
    > = {
      status: status.status,
    }

    if (
      status.status === 'sent'
    ) {
      update.sent_at = tsIso
    }

    if (
      status.status === 'delivered'
    ) {
      update.delivered_at = tsIso
    }

    if (
      status.status === 'read'
    ) {
      update.read_at = tsIso
    }

    // ==========================================================
    // IMPORTANT:
    // When Meta reports "failed", save the actual error returned
    // by Meta instead of leaving error_message as NULL.
    // ==========================================================

    if (
      status.status === 'failed'
    ) {
      const metaError =
        status.errors?.[0]

      update.error_message =
        metaError
          ? [
              metaError.code !== undefined
                ? `Código ${metaError.code}`
                : null,
              metaError.title,
              metaError.message,
              metaError.error_data?.details,
            ]
              .filter(Boolean)
              .join(' — ')
          : 'Meta marcou a mensagem como failed, mas não informou o motivo.'

      console.error(
        '[whatsapp-webhook] Meta delivery failed:',
        {
          whatsapp_message_id:
            status.id,

          recipient_id:
            status.recipient_id,

          error:
            metaError,
        }
      )
    }

    const {
      error: recUpdateErr,
    } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update(update)
      .eq(
        'id',
        recipient.id
      )

    if (recUpdateErr) {
      console.error(
        'Error updating broadcast recipient status:',
        recUpdateErr
      )
    }
  }

  const {
    data: msgRow,
  } = await supabaseAdmin()
    .from('messages')
    .select(
      'conversation_id, conversations(account_id)'
    )
    .eq(
      'message_id',
      status.id
    )
    .limit(1)
    .maybeSingle()

  if (msgRow) {
    const conv =
      msgRow.conversations as {
        account_id: string
      } | null

    const accountId =
      conv?.account_id

    if (accountId) {
      await dispatchWebhookEvent(
        supabaseAdmin(),
        accountId,
        'message.status_updated',
        {
          whatsapp_message_id:
            status.id,
          conversation_id:
            msgRow.conversation_id,
          status:
            status.status,
        }
      )
    }
  }
}

// ============================================================
// Broadcast reply
// ============================================================

async function flagBroadcastReplyIfAny(
  accountId: string,
  contactId: string
) {
  try {
    const {
      data: recs,
      error,
    } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select(
        'id, status, broadcast_id, broadcasts!inner(account_id)'
      )
      .eq(
        'contact_id',
        contactId
      )
      .eq(
        'broadcasts.account_id',
        accountId
      )
      .in(
        'status',
        [
          'sent',
          'delivered',
          'read',
        ]
      )
      .order(
        'created_at',
        {
          ascending: false,
        }
      )
      .limit(1)

    if (
      error ||
      !recs ||
      recs.length === 0
    ) {
      return
    }

    const row = recs[0]

    const {
      error: updErr,
    } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({
        status: 'replied',
        replied_at:
          new Date().toISOString(),
      })
      .eq(
        'id',
        row.id
      )

    if (updErr) {
      console.error(
        'Error marking broadcast recipient replied:',
        updErr
      )
    }
  } catch (err) {
    console.error(
      'flagBroadcastReplyIfAny failed:',
      err
    )
  }
}

// ============================================================
// Lookup internal message ID
// ============================================================

async function lookupInternalIdByMetaId(
  metaId: string,
  conversationId: string
): Promise<string | null> {
  const {
    data,
    error,
  } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq(
      'message_id',
      metaId
    )
    .eq(
      'conversation_id',
      conversationId
    )
    .maybeSingle()

  if (error) {
    console.error(
      '[webhook] lookupInternalIdByMetaId failed:',
      error.message
    )

    return null
  }

  return data?.id ?? null
}

// ============================================================
// Reactions
// ============================================================

async function handleReaction(
  message: WhatsAppMessage,
  conversationId: string,
  contactId: string
) {
  const reaction =
    message.reaction

  if (!reaction?.message_id) {
    return
  }

  const targetInternalId =
    await lookupInternalIdByMetaId(
      reaction.message_id,
      conversationId
    )

  if (!targetInternalId) {
    console.warn(
      '[webhook] reaction target message not found; skipping',
      reaction.message_id
    )

    return
  }

  if (!reaction.emoji) {
    const {
      error: delError,
    } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq(
        'message_id',
        targetInternalId
      )
      .eq(
        'actor_type',
        'customer'
      )
      .eq(
        'actor_id',
        contactId
      )

    if (delError) {
      console.error(
        '[webhook] reaction delete failed:',
        delError.message
      )
    }

    return
  }

  const {
    error: upsertError,
  } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id:
          targetInternalId,
        conversation_id:
          conversationId,
        actor_type:
          'customer',
        actor_id:
          contactId,
        emoji:
          reaction.emoji,
      },
      {
        onConflict:
          'message_id,actor_type,actor_id',
      }
    )

  if (upsertError) {
    console.error(
      '[webhook] reaction upsert failed:',
      upsertError.message
    )
  }
}

// ============================================================
// Process message
// ============================================================

async function processMessage(
  message: WhatsAppMessage,
  contact: {
    profile: {
      name: string
    }
    wa_id: string
  },
  accountId: string,
  configOwnerUserId: string,
  accessToken: string,
  mirrorMedia: boolean
) {
  const senderPhone =
    normalizePhone(message.from)

  const contactName =
    contact.profile.name

  // ----------------------------------------------------------
  // Find/create contact
  // ----------------------------------------------------------

  const contactOutcome =
    await findOrCreateContact(
      accountId,
      configOwnerUserId,
      senderPhone,
      contactName
    )

  if (!contactOutcome) {
    return
  }

  const contactRecord =
    contactOutcome.contact

  // ----------------------------------------------------------
  // Find/create conversation
  // ----------------------------------------------------------

  const convResult =
    await findOrCreateConversation(
      accountId,
      configOwnerUserId,
      contactRecord.id
    )

  if (!convResult) {
    return
  }

  const conversation =
    convResult.conversation

  // ----------------------------------------------------------
  // Conversation created webhook
  // ----------------------------------------------------------

  if (convResult.created) {
    await dispatchWebhookEvent(
      supabaseAdmin(),
      accountId,
      'conversation.created',
      {
        conversation_id:
          conversation.id,
        contact_id:
          contactRecord.id,
      }
    )
  }

  // ----------------------------------------------------------
  // Reaction
  // ----------------------------------------------------------

  if (message.type === 'reaction') {
    await handleReaction(
      message,
      conversation.id,
      contactRecord.id
    )

    return
  }

  // ----------------------------------------------------------
  // Parse message
  // ----------------------------------------------------------

  const {
    contentText,
    mediaUrl,
    mediaType,
    interactiveReplyId,
    contactCard,
  } = await parseMessageContent(
    message,
    accessToken,
    mirrorMedia
      ? { accountId }
      : null
  )

  // ----------------------------------------------------------
  // Reply context
  // ----------------------------------------------------------

  let replyToInternalId:
    | string
    | null = null

  if (message.context?.id) {
    replyToInternalId =
      await lookupInternalIdByMetaId(
        message.context.id,
        conversation.id
      )

    if (!replyToInternalId) {
      console.warn(
        '[webhook] reply context parent not found:',
        message.context.id
      )
    }
  }

  // ----------------------------------------------------------
  // Content type
  // ----------------------------------------------------------

  const ALLOWED_CONTENT_TYPES =
    new Set([
      'text',
      'image',
      'document',
      'audio',
      'video',
      'location',
      'template',
      'interactive',
      'contact',
    ])

  const contentType =
    ALLOWED_CONTENT_TYPES.has(
      message.type
    )
      ? message.type
      : message.type === 'sticker'
        ? 'image'
        : message.type === 'button'
          ? 'interactive'
          : 'text'

  // ----------------------------------------------------------
  // First inbound message
  // ----------------------------------------------------------

  const {
    count:
      priorCustomerMsgCount,
  } = await supabaseAdmin()
    .from('messages')
    .select(
      'id',
      {
        count: 'exact',
        head: true,
      }
    )
    .eq(
      'conversation_id',
      conversation.id
    )
    .eq(
      'sender_type',
      'customer'
    )

  const isFirstInboundMessage =
    (priorCustomerMsgCount ?? 0) === 0

  // ----------------------------------------------------------
  // Insert message
  // ----------------------------------------------------------

  const {
    data: insertedRows,
    error: msgError,
  } = await supabaseAdmin()
    .from('messages')
    .upsert(
      {
        conversation_id:
          conversation.id,

        sender_type:
          'customer',

        content_type:
          contentType,

        content_text:
          contentText,

        media_url:
          mediaUrl,

        media_type:
          mediaType,

        message_id:
          message.id,

        status:
          'delivered',

        created_at:
          new Date(
            parseInt(
              message.timestamp
            ) * 1000
          ).toISOString(),

        reply_to_message_id:
          replyToInternalId,

        interactive_reply_id:
          interactiveReplyId,

        // ----------------------------------------------------
        // NEW:
        // Persist the actual WhatsApp shared contact card.
        // ----------------------------------------------------
        contact_card:
          contactCard,
      },
      {
        onConflict:
          'conversation_id,message_id',

        ignoreDuplicates:
          true,
      }
    )
    .select('id')

  if (msgError) {
    console.error(
      'Error inserting message:',
      msgError
    )

    return
  }

  // ----------------------------------------------------------
  // Idempotency
  // ----------------------------------------------------------

  if (
    !insertedRows ||
    insertedRows.length === 0
  ) {
    console.info(
      '[webhook] duplicate inbound message ignored (idempotent replay):',
      message.id
    )

    return
  }

  // ----------------------------------------------------------
  // Update conversation
  // ----------------------------------------------------------

  const {
    error: convError,
  } = await supabaseAdmin()
    .rpc(
      'bump_conversation_on_inbound',
      {
        p_conversation_id:
          conversation.id,

        p_last_message_text:
          contentText ||
          `[${message.type}]`,
      }
    )

  if (convError) {
    console.error(
      'Error updating conversation:',
      convError
    )
  }

  // ----------------------------------------------------------
  // Reopen closed conversation
  // ----------------------------------------------------------

  await reopenClosedConversation(
    supabaseAdmin(),
    conversation
  )

  // ----------------------------------------------------------
  // Broadcast reply
  // ----------------------------------------------------------

  await flagBroadcastReplyIfAny(
    accountId,
    contactRecord.id
  )

  // ----------------------------------------------------------
  // Flows
  // ----------------------------------------------------------

  const flowResult =
    await dispatchInboundToFlows({
      accountId,
      userId:
        configOwnerUserId,
      contactId:
        contactRecord.id,
      conversationId:
        conversation.id,

      message:
        interactiveReplyId
          ? {
              kind:
                'interactive_reply',

              reply_id:
                interactiveReplyId,

              reply_title:
                contentText ?? '',

              meta_message_id:
                message.id,
            }
          : {
              kind:
                'text',

              text:
                contentText ??
                message.text?.body ??
                '',

              meta_message_id:
                message.id,
            },

      isFirstInboundMessage,
    })

  const flowConsumed =
    flowResult.consumed

  // ----------------------------------------------------------
  // Automations
  // ----------------------------------------------------------

  const inboundText =
    contentText ??
    message.text?.body ??
    ''

  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []

  if (!flowConsumed) {
    automationTriggers.push(
      'new_message_received',
      'keyword_match'
    )

    if (interactiveReplyId) {
      automationTriggers.push(
        'interactive_reply'
      )
    }
  }

  if (
    contactOutcome.wasCreated
  ) {
    automationTriggers.unshift(
      'new_contact_created'
    )
  }

  if (
    isFirstInboundMessage
  ) {
    automationTriggers.unshift(
      'first_inbound_message'
    )
  }

  for (
    const triggerType of automationTriggers
  ) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId:
        contactRecord.id,

      context: {
        message_text:
          inboundText,

        conversation_id:
          conversation.id,

        interactive_reply_id:
          interactiveReplyId ??
          undefined,
      },
    }).catch(
      (err) =>
        console.error(
          '[automations] dispatch failed:',
          err
        )
    )
  }

  // ----------------------------------------------------------
  // AI auto reply
  // ----------------------------------------------------------

  if (
    !flowConsumed &&
    !interactiveReplyId &&
    inboundText.trim()
  ) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId:
        conversation.id,
      contactId:
        contactRecord.id,
      configOwnerUserId,
    })
  }

  // ----------------------------------------------------------
  // Public webhook
  // ----------------------------------------------------------

  await dispatchWebhookEvent(
    supabaseAdmin(),
    accountId,
    'message.received',
    {
      conversation_id:
        conversation.id,

      contact_id:
        contactRecord.id,

      whatsapp_message_id:
        message.id,

      content_type:
        contentType,

      text:
        contentText,
    }
  )
}

// ============================================================
// Parse message content
// ============================================================

async function parseMessageContent(
  message: WhatsAppMessage,
  accessToken: string,
  mirror: {
    accountId: string
  } | null
): Promise<{
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  interactiveReplyId: string | null
  contactCard:
    | WhatsAppContactCard
    | WhatsAppContactCard[]
    | null
}> {
  const verifyAndBuildUrl = async (
    mediaId: string,
    fileName?: string | null
  ): Promise<string | null> => {
    try {
      const info =
        await getMediaUrl({
          mediaId,
          accessToken,
        })

      if (mirror) {
        const mirrored =
          await mirrorInboundMedia({
            storage:
              supabaseAdmin()
                .storage,

            accountId:
              mirror.accountId,

            mediaId,

            downloadUrl:
              info.url,

            accessToken,

            mimeType:
              info.mimeType,

            fileSize:
              info.fileSize,

            fileName,

            messageTimestamp:
              message.timestamp,
          })

        if (mirrored) {
          return mirrored
        }
      }

      return `/api/whatsapp/media/${mediaId}`
    } catch (error) {
      console.error(
        `Failed to verify media ${mediaId} with Meta:`,
        error instanceof Error
          ? error.message
          : error
      )

      return null
    }
  }

  const empty = {
    contentText: null,
    mediaUrl: null,
    mediaType: null,
    interactiveReplyId: null,
    contactCard: null,
  }

  switch (message.type) {
    // --------------------------------------------------------
    // Text
    // --------------------------------------------------------

    case 'text':
      return {
        ...empty,
        contentText:
          message.text?.body ||
          null,
      }

    // --------------------------------------------------------
    // Image
    // --------------------------------------------------------

    case 'image':
      if (message.image?.id) {
        return {
          ...empty,

          contentText:
            message.image.caption ||
            null,

          mediaUrl:
            await verifyAndBuildUrl(
              message.image.id
            ),

          mediaType:
            message.image.mime_type,
        }
      }

      return empty

    // --------------------------------------------------------
    // Video
    // --------------------------------------------------------

    case 'video':
      if (message.video?.id) {
        return {
          ...empty,

          contentText:
            message.video.caption ||
            null,

          mediaUrl:
            await verifyAndBuildUrl(
              message.video.id
            ),

          mediaType:
            message.video.mime_type,
        }
      }

      return empty

    // --------------------------------------------------------
    // Document
    // --------------------------------------------------------

    case 'document':
      if (message.document?.id) {
        return {
          ...empty,

          contentText:
            message.document.caption ||
            message.document.filename ||
            null,

          mediaUrl:
            await verifyAndBuildUrl(
              message.document.id,
              message.document.filename
            ),

          mediaType:
            message.document.mime_type,
        }
      }

      return empty

    // --------------------------------------------------------
    // Audio
    // --------------------------------------------------------

    case 'audio':
      if (message.audio?.id) {
        return {
          ...empty,

          mediaUrl:
            await verifyAndBuildUrl(
              message.audio.id
            ),

          mediaType:
            message.audio.mime_type,
        }
      }

      return empty

    // --------------------------------------------------------
    // Sticker
    // --------------------------------------------------------

    case 'sticker':
      if (message.sticker?.id) {
        return {
          ...empty,

          mediaUrl:
            await verifyAndBuildUrl(
              message.sticker.id
            ),

          mediaType:
            message.sticker.mime_type,
        }
      }

      return empty

    // --------------------------------------------------------
    // Location
    // --------------------------------------------------------

    case 'location':
      if (message.location) {
        const loc =
          message.location

        const locationText = [
          loc.name,
          loc.address,
          `${loc.latitude},${loc.longitude}`,
        ]
          .filter(Boolean)
          .join(' - ')

        return {
          ...empty,
          contentText:
            locationText,
        }
      }

      return empty

    // --------------------------------------------------------
    // Reaction
    // --------------------------------------------------------

    case 'reaction':
      return {
        ...empty,

        contentText:
          message.reaction?.emoji ||
          null,
      }

    // --------------------------------------------------------
    // WhatsApp shared contact
    //
    // IMPORTANT:
    // Meta's message type is "contacts".
    // Internally we store it as "contact".
    // --------------------------------------------------------

    case 'contacts': {
      const contacts =
        message.contacts || []

      if (
        contacts.length === 0
      ) {
        return {
          ...empty,

          contentText:
            '[Contato compartilhado]',
        }
      }

      const contactNames =
        contacts
          .map(
            (contact) =>
              contact.name
                ?.formatted_name
          )
          .filter(
            (
              value
            ): value is string =>
              Boolean(value)
          )

      const contactPhones =
        contacts
          .flatMap(
            (contact) =>
              contact.phones || []
          )
          .map(
            (phone) =>
              phone.phone ||
              phone.wa_id
          )
          .filter(
            (
              value
            ): value is string =>
              Boolean(value)
          )

      const lines: string[] =
        []

      if (
        contactNames.length > 0
      ) {
        lines.push(
          `Nome: ${contactNames.join(', ')}`
        )
      }

      if (
        contactPhones.length > 0
      ) {
        lines.push(
          `Telefone: ${contactPhones.join(', ')}`
        )
      }

      return {
        ...empty,

        contentText:
          lines.length > 0
            ? lines.join('\n')
            : '[Contato compartilhado]',

        contactCard:
          contacts.length === 1
            ? contacts[0]
            : contacts,
      }
    }

    // --------------------------------------------------------
    // Interactive
    // --------------------------------------------------------

    case 'interactive': {
      const reply =
        message.interactive
          ?.button_reply ??
        message.interactive
          ?.list_reply

      if (reply?.id) {
        return {
          ...empty,

          contentText:
            reply.title ||
            reply.id,

          interactiveReplyId:
            reply.id,
        }
      }

      return {
        ...empty,

        contentText:
          '[Interactive reply]',
      }
    }

    // --------------------------------------------------------
    // Template quick reply
    // --------------------------------------------------------

    case 'button': {
      const payload =
        message.button
          ?.payload ||
        null

      const label =
        message.button
          ?.text ||
        null

      return {
        ...empty,

        contentText:
          label ||
          payload,

        interactiveReplyId:
          payload ||
          label,
      }
    }

    // --------------------------------------------------------
    // Unknown
    // --------------------------------------------------------

    default:
      return {
        ...empty,

        contentText:
          `[Unsupported message type: ${message.type}]`,
      }
  }
}

// ============================================================
// Contact helpers
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  wasCreated: boolean
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string
): Promise<ContactOutcome | null> {
  const existingContact =
    await findExistingContact(
      supabaseAdmin(),
      accountId,
      phone
    )

  if (existingContact) {
    if (
      name &&
      name !== existingContact.name
    ) {
      await supabaseAdmin()
        .from('contacts')
        .update({
          name,
          updated_at:
            new Date().toISOString(),
        })
        .eq(
          'id',
          existingContact.id
        )
    }

    return {
      contact:
        existingContact,
      wasCreated:
        false,
    }
  }

  const {
    data: newContact,
    error: createError,
  } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id:
        accountId,

      user_id:
        configOwnerUserId,

      phone,

      name:
        name || phone,
    })
    .select()
    .single()

  if (createError) {
    if (
      isUniqueViolation(
        createError
      )
    ) {
      const raced =
        await findExistingContact(
          supabaseAdmin(),
          accountId,
          phone
        )

      if (raced) {
        return {
          contact:
            raced,
          wasCreated:
            false,
        }
      }
    }

    console.error(
      'Error creating contact:',
      createError
    )

    return null
  }

  return {
    contact:
      newContact,
    wasCreated:
      true,
  }
}

// ============================================================
// Conversation helpers
// ============================================================

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string
) {
  const {
    data: existingRows,
    error: findError,
  } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq(
      'account_id',
      accountId
    )
    .eq(
      'contact_id',
      contactId
    )
    .order(
      'created_at',
      {
        ascending: true,
      }
    )
    .limit(1)

  if (findError) {
    console.error(
      'Error finding conversation:',
      findError
    )

    return null
  }

  if (
    existingRows &&
    existingRows.length > 0
  ) {
    return {
      conversation:
        existingRows[0],
      created:
        false,
    }
  }

  const {
    data: newConv,
    error: createError,
  } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id:
        accountId,

      user_id:
        configOwnerUserId,

      contact_id:
        contactId,
    })
    .select()
    .single()

  if (createError) {
    if (
      isUniqueViolation(
        createError
      )
    ) {
      const {
        data: raced,
      } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq(
          'account_id',
          accountId
        )
        .eq(
          'contact_id',
          contactId
        )
        .order(
          'created_at',
          {
            ascending: true,
          }
        )
        .limit(1)

      if (
        raced &&
        raced.length > 0
      ) {
        return {
          conversation:
            raced[0],
          created:
            false,
        }
      }
    }

    console.error(
      'Error creating conversation:',
      createError
    )

    return null
  }

  return {
    conversation:
      newConv,
    created:
      true,
  }
}