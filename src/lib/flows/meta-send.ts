import {
  sendInteractiveButtons,
  sendInteractiveList,
  sendMediaMessage,
  sendTextMessage,
  type InteractiveButton,
  type InteractiveListSection,
  type MediaKind,
} from '@/lib/whatsapp/meta-api'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { supabaseAdmin } from './admin-client'

// ------------------------------------------------------------
// Flows-side Meta sender (interactive variants).
//
// The WhatsApp configuration is resolved from the conversation's
// whatsapp_config_id. This guarantees that flow messages are sent
// through the same WhatsApp number that owns the conversation.
// ------------------------------------------------------------

interface SendTextEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  text: string
  aiGenerated?: boolean
}

/**
 * Send a plain-text WhatsApp message from the Flows engine.
 */
export async function engineSendText(
  args: SendTextEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  // ----------------------------------------------------------
  // Conversation / WhatsApp config
  // ----------------------------------------------------------

  const {
    data: conversation,
    error: conversationErr,
  } = await db
    .from('conversations')
    .select('id, whatsapp_config_id')
    .eq('id', args.conversationId)
    .eq('account_id', args.accountId)
    .maybeSingle()

  if (
    conversationErr ||
    !conversation
  ) {
    throw new Error(
      'conversation not found for this account',
    )
  }

  if (
    !conversation.whatsapp_config_id
  ) {
    throw new Error(
      'conversation has no WhatsApp configuration',
    )
  }

  const whatsappConfigId =
    conversation.whatsapp_config_id

  // ----------------------------------------------------------
  // Contact
  // ----------------------------------------------------------

  const {
    data: contact,
    error: contactErr,
  } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle()

  if (
    contactErr ||
    !contact?.phone
  ) {
    throw new Error(
      'contact not found for this account',
    )
  }

  const sanitized =
    sanitizePhoneForMeta(
      contact.phone,
    )

  if (
    !isValidE164(sanitized)
  ) {
    throw new Error(
      `contact phone invalid: ${contact.phone}`,
    )
  }

  // ----------------------------------------------------------
  // WhatsApp config
  // ----------------------------------------------------------

  const {
    data: config,
    error: configErr,
  } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('id', whatsappConfigId)
    .eq('account_id', args.accountId)
    .maybeSingle()

  if (
    configErr ||
    !config
  ) {
    throw new Error(
      'WhatsApp configuration not found for this conversation',
    )
  }

  const accessToken =
    decrypt(config.access_token)

  const attempt = async (
    phone: string,
  ): Promise<string> => {
    const r =
      await sendTextMessage({
        phoneNumberId:
          config.phone_number_id,
        accessToken,
        to: phone,
        text: args.text,
      })

    return r.messageId
  }

  // ----------------------------------------------------------
  // Phone variants
  // ----------------------------------------------------------

  const variants =
    phoneVariants(sanitized)

  let workingPhone =
    sanitized

  let waMessageId = ''

  let lastError: unknown =
    null

  for (
    const v of variants
  ) {
    try {
      waMessageId =
        await attempt(v)

      workingPhone =
        v

      lastError =
        null

      break
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : String(err)

      if (
        !isRecipientNotAllowedError(
          msg,
        )
      ) {
        throw err
      }

      lastError =
        err
    }
  }

  if (lastError) {
    throw lastError
  }

  if (
    workingPhone !==
    sanitized
  ) {
    await db
      .from('contacts')
      .update({
        phone:
          workingPhone,
      })
      .eq(
        'id',
        contact.id,
      )
      .eq(
        'account_id',
        args.accountId,
      )
  }

  // ----------------------------------------------------------
  // Persist message
  // ----------------------------------------------------------

  const {
    error: msgErr,
  } = await db
    .from('messages')
    .insert({
      conversation_id:
        args.conversationId,
      sender_type:
        'bot',
      content_type:
        'text',
      content_text:
        args.text,
      message_id:
        waMessageId,
      status:
        'sent',
      ai_generated:
        args.aiGenerated ?? false,
    })

  if (msgErr) {
    throw new Error(
      `sent to Meta but DB insert failed: ${msgErr.message}`,
    )
  }

  await db
    .from('conversations')
    .update({
      last_message_text:
        args.text,
      last_message_at:
        new Date().toISOString(),
      updated_at:
        new Date().toISOString(),
    })
    .eq(
      'id',
      args.conversationId,
    )
    .eq(
      'account_id',
      args.accountId,
    )
    .eq(
      'whatsapp_config_id',
      whatsappConfigId,
    )

  return {
    whatsapp_message_id:
      waMessageId,
  }
}

// ============================================================
// Media
// ============================================================

interface SendMediaEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  kind: MediaKind
  link: string
  caption?: string
  filename?: string
}

/**
 * Send an image / video / document from the Flows engine.
 */
export async function engineSendMedia(
  args: SendMediaEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  // ----------------------------------------------------------
  // Conversation / WhatsApp config
  // ----------------------------------------------------------

  const {
    data: conversation,
    error: conversationErr,
  } = await db
    .from('conversations')
    .select('id, whatsapp_config_id')
    .eq('id', args.conversationId)
    .eq('account_id', args.accountId)
    .maybeSingle()

  if (
    conversationErr ||
    !conversation
  ) {
    throw new Error(
      'conversation not found for this account',
    )
  }

  if (
    !conversation.whatsapp_config_id
  ) {
    throw new Error(
      'conversation has no WhatsApp configuration',
    )
  }

  const whatsappConfigId =
    conversation.whatsapp_config_id

  // ----------------------------------------------------------
  // Contact
  // ----------------------------------------------------------

  const {
    data: contact,
    error: contactErr,
  } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle()

  if (
    contactErr ||
    !contact?.phone
  ) {
    throw new Error(
      'contact not found for this account',
    )
  }

  const sanitized =
    sanitizePhoneForMeta(
      contact.phone,
    )

  if (
    !isValidE164(sanitized)
  ) {
    throw new Error(
      `contact phone invalid: ${contact.phone}`,
    )
  }

  // ----------------------------------------------------------
  // WhatsApp config
  // ----------------------------------------------------------

  const {
    data: config,
    error: configErr,
  } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('id', whatsappConfigId)
    .eq('account_id', args.accountId)
    .maybeSingle()

  if (
    configErr ||
    !config
  ) {
    throw new Error(
      'WhatsApp configuration not found for this conversation',
    )
  }

  const accessToken =
    decrypt(config.access_token)

  const attempt = async (
    phone: string,
  ): Promise<string> => {
    const r =
      await sendMediaMessage({
        phoneNumberId:
          config.phone_number_id,
        accessToken,
        to: phone,
        kind:
          args.kind,
        link:
          args.link,
        caption:
          args.caption,
        filename:
          args.filename,
      })

    return r.messageId
  }

  // ----------------------------------------------------------
  // Phone variants
  // ----------------------------------------------------------

  const variants =
    phoneVariants(sanitized)

  let workingPhone =
    sanitized

  let waMessageId = ''

  let lastError: unknown =
    null

  for (
    const v of variants
  ) {
    try {
      waMessageId =
        await attempt(v)

      workingPhone =
        v

      lastError =
        null

      break
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : String(err)

      if (
        !isRecipientNotAllowedError(
          msg,
        )
      ) {
        throw err
      }

      lastError =
        err
    }
  }

  if (lastError) {
    throw lastError
  }

  if (
    workingPhone !==
    sanitized
  ) {
    await db
      .from('contacts')
      .update({
        phone:
          workingPhone,
      })
      .eq(
        'id',
        contact.id,
      )
      .eq(
        'account_id',
        args.accountId,
      )
  }

  const preview =
    args.caption?.trim() ||
    `[${args.kind}]`

  const {
    error: msgErr,
  } = await db
    .from('messages')
    .insert({
      conversation_id:
        args.conversationId,
      sender_type:
        'bot',
      content_type:
        args.kind,
      content_text:
        args.caption ??
        null,
      message_id:
        waMessageId,
      status:
        'sent',
    })

  if (msgErr) {
    throw new Error(
      `sent to Meta but DB insert failed: ${msgErr.message}`,
    )
  }

  await db
    .from('conversations')
    .update({
      last_message_text:
        preview,
      last_message_at:
        new Date().toISOString(),
      updated_at:
        new Date().toISOString(),
    })
    .eq(
      'id',
      args.conversationId,
    )
    .eq(
      'account_id',
      args.accountId,
    )
    .eq(
      'whatsapp_config_id',
      whatsappConfigId,
    )

  return {
    whatsapp_message_id:
      waMessageId,
  }
}

// ============================================================
// Interactive
// ============================================================

interface SendInteractiveButtonsEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttons: InteractiveButton[]
  headerText?: string
  footerText?: string
}

interface SendInteractiveListEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttonLabel: string
  sections: InteractiveListSection[]
  headerText?: string
  footerText?: string
}

/**
 * Send an interactive-button WhatsApp message from the Flows engine.
 */
export async function engineSendInteractiveButtons(
  args: SendInteractiveButtonsEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({
    ...args,
    kind: 'buttons',
  })
}

/**
 * Send an interactive-list WhatsApp message from the Flows engine.
 */
export async function engineSendInteractiveList(
  args: SendInteractiveListEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({
    ...args,
    kind: 'list',
  })
}

type SendInput =
  | (
      SendInteractiveButtonsEngineArgs & {
        kind: 'buttons'
      }
    )
  | (
      SendInteractiveListEngineArgs & {
        kind: 'list'
      }
    )

async function sendInteractiveViaMeta(
  input: SendInput,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  // ----------------------------------------------------------
  // Conversation / WhatsApp config
  // ----------------------------------------------------------

  const {
    data: conversation,
    error: conversationErr,
  } = await db
    .from('conversations')
    .select('id, whatsapp_config_id')
    .eq('id', input.conversationId)
    .eq('account_id', input.accountId)
    .maybeSingle()

  if (
    conversationErr ||
    !conversation
  ) {
    throw new Error(
      'conversation not found for this account',
    )
  }

  if (
    !conversation.whatsapp_config_id
  ) {
    throw new Error(
      'conversation has no WhatsApp configuration',
    )
  }

  const whatsappConfigId =
    conversation.whatsapp_config_id

  // ----------------------------------------------------------
  // Contact
  // ----------------------------------------------------------

  const {
    data: contact,
    error: contactErr,
  } = await db
    .from('contacts')
    .select('id, phone')
    .eq(
      'id',
      input.contactId,
    )
    .eq(
      'account_id',
      input.accountId,
    )
    .maybeSingle()

  if (
    contactErr ||
    !contact?.phone
  ) {
    throw new Error(
      'contact not found for this account',
    )
  }

  const sanitized =
    sanitizePhoneForMeta(
      contact.phone,
    )

  if (
    !isValidE164(sanitized)
  ) {
    throw new Error(
      `contact phone invalid: ${contact.phone}`,
    )
  }

  // ----------------------------------------------------------
  // WhatsApp config
  // ----------------------------------------------------------

  const {
    data: config,
    error: configErr,
  } = await db
    .from('whatsapp_config')
    .select('*')
    .eq(
      'id',
      whatsappConfigId,
    )
    .eq(
      'account_id',
      input.accountId,
    )
    .maybeSingle()

  if (
    configErr ||
    !config
  ) {
    throw new Error(
      'WhatsApp configuration not found for this conversation',
    )
  }

  const accessToken =
    decrypt(config.access_token)

  // ----------------------------------------------------------
  // Meta attempt
  // ----------------------------------------------------------

  const attempt = async (
    phone: string,
  ): Promise<string> => {
    if (
      input.kind === 'buttons'
    ) {
      const r =
        await sendInteractiveButtons({
          phoneNumberId:
            config.phone_number_id,
          accessToken,
          to: phone,
          bodyText:
            input.bodyText,
          buttons:
            input.buttons,
          headerText:
            input.headerText,
          footerText:
            input.footerText,
        })

      return r.messageId
    }

    const r =
      await sendInteractiveList({
        phoneNumberId:
          config.phone_number_id,
        accessToken,
        to: phone,
        bodyText:
          input.bodyText,
        buttonLabel:
          input.buttonLabel,
        sections:
          input.sections,
        headerText:
          input.headerText,
        footerText:
          input.footerText,
      })

    return r.messageId
  }

  // ----------------------------------------------------------
  // Phone variants
  // ----------------------------------------------------------

  const variants =
    phoneVariants(sanitized)

  let workingPhone =
    sanitized

  let waMessageId = ''

  let lastError: unknown =
    null

  for (
    const v of variants
  ) {
    try {
      waMessageId =
        await attempt(v)

      workingPhone =
        v

      lastError =
        null

      break
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : String(err)

      if (
        !isRecipientNotAllowedError(
          msg,
        )
      ) {
        throw err
      }

      lastError =
        err
    }
  }

  if (lastError) {
    throw lastError
  }

  if (
    workingPhone !==
    sanitized
  ) {
    await db
      .from('contacts')
      .update({
        phone:
          workingPhone,
      })
      .eq(
        'id',
        contact.id,
      )
      .eq(
        'account_id',
        input.accountId,
      )
  }

  // ----------------------------------------------------------
  // Persist interactive message
  // ----------------------------------------------------------

  const interactivePayload:
    InteractiveMessagePayload =
    input.kind === 'buttons'
      ? {
          kind:
            'buttons',
          body:
            input.bodyText,
          header:
            input.headerText,
          footer:
            input.footerText,
          buttons:
            input.buttons,
        }
      : {
          kind:
            'list',
          body:
            input.bodyText,
          header:
            input.headerText,
          footer:
            input.footerText,
          button_label:
            input.buttonLabel,
          sections:
            input.sections,
        }

  const {
    error: msgErr,
  } = await db
    .from('messages')
    .insert({
      conversation_id:
        input.conversationId,
      sender_type:
        'bot',
      content_type:
        'interactive',
      content_text:
        input.bodyText,
      interactive_payload:
        interactivePayload,
      message_id:
        waMessageId,
      status:
        'sent',
    })

  if (msgErr) {
    throw new Error(
      `sent to Meta but DB insert failed: ${msgErr.message}`,
    )
  }

  await db
    .from('conversations')
    .update({
      last_message_text:
        input.bodyText,
      last_message_at:
        new Date().toISOString(),
      updated_at:
        new Date().toISOString(),
    })
    .eq(
      'id',
      input.conversationId,
    )
    .eq(
      'account_id',
      input.accountId,
    )
    .eq(
      'whatsapp_config_id',
      whatsappConfigId,
    )

  return {
    whatsapp_message_id:
      waMessageId,
  }
}