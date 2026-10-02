import { sendTextMessage, sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from '@/lib/flows/meta-send'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import {
  resolveTemplateRow,
  templateContentText,
} from '@/lib/whatsapp/template-body'
import { supabaseAdmin } from './admin-client'

// ------------------------------------------------------------
// Automation-side Meta sender.
//
// Mirrors the logic in src/app/api/whatsapp/send/route.ts but uses
// the service-role client (engine has no cookies) and accepts the
// user / conversation / contact identifiers the engine already has
// on hand.
//
// The WhatsApp configuration is resolved from the conversation's
// whatsapp_config_id so an automation always sends through the
// same WhatsApp number that owns that conversation.
// ------------------------------------------------------------

interface SendTextArgs {
  /** Account-level tenancy key. */
  accountId: string

  /** Original author of the automation/flow. */
  userId: string

  conversationId: string
  contactId: string
  text: string
}

interface SendTemplateArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  templateName: string
  language?: string
  params?: string[]
}

export async function engineSendText(
  args: SendTextArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'text' })
}

export async function engineSendTemplate(
  args: SendTemplateArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'template' })
}

interface SendInteractiveArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  payload: InteractiveMessagePayload
}

/**
 * Send an interactive (reply-buttons or list) message from the
 * automation engine.
 *
 * Delegates to the Flows interactive senders
 * (`engineSendInteractiveButtons` / `engineSendInteractiveList`), which
 * already own the account-scoped lookup, phone-variant retry, and the
 * `messages` insert with `interactive_payload` + `sender_type='bot'`.
 */
export async function engineSendInteractive(
  args: SendInteractiveArgs,
): Promise<{ whatsapp_message_id: string }> {
  const {
    payload,
    accountId,
    userId,
    conversationId,
    contactId,
  } = args

  const common = {
    accountId,
    userId,
    conversationId,
    contactId,
  }

  if (payload.kind === 'buttons') {
    return engineSendInteractiveButtons({
      ...common,
      bodyText: payload.body,
      headerText: payload.header,
      footerText: payload.footer,
      buttons: payload.buttons,
    })
  }

  return engineSendInteractiveList({
    ...common,
    bodyText: payload.body,
    buttonLabel: payload.button_label,
    headerText: payload.header,
    footerText: payload.footer,
    sections: payload.sections,
  })
}

type SendInput =
  | (SendTextArgs & { kind: 'text' })
  | (SendTemplateArgs & { kind: 'template' })

async function sendViaMeta(
  input: SendInput,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  // ----------------------------------------------------------
  // Conversation
  // ----------------------------------------------------------
  //
  // The conversation is the source of truth for which WhatsApp
  // number must be used.
  //
  // This prevents an automation from accidentally sending through
  // another WhatsApp configuration belonging to the same account.
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
  //
  // IMPORTANT:
  // Never resolve this only by account_id.
  //
  // An account can now have multiple WhatsApp configurations.
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
    decrypt(
      config.access_token,
    )

  // ----------------------------------------------------------
  // Local template row
  // ----------------------------------------------------------

  const templateRow =
    input.kind === 'template'
      ? (
          await resolveTemplateRow(
            db,
            input.accountId,
            whatsappConfigId,
            input.templateName,
            input.language,
          )
        ).row
      : null

  // ----------------------------------------------------------
  // Meta send
  // ----------------------------------------------------------

  const attempt = async (
    phone: string,
  ): Promise<string> => {
    if (
      input.kind === 'template'
    ) {
      const r =
        await sendTemplateMessage({
          phoneNumberId:
            config.phone_number_id,
          accessToken,
          to: phone,
          templateName:
            input.templateName,
          language:
            input.language,
          params:
            input.params,
        })

      return r.messageId
    }

    const r =
      await sendTextMessage({
        phoneNumberId:
          config.phone_number_id,
        accessToken,
        to: phone,
        text: input.text,
      })

    return r.messageId
  }

  // ----------------------------------------------------------
  // Phone variants
  // ----------------------------------------------------------

  const variants =
    phoneVariants(
      sanitized,
    )

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
  // Persist sent message
  // ----------------------------------------------------------

  const content_type =
    input.kind === 'template'
      ? 'template'
      : 'text'

  const content_text =
    input.kind === 'text'
      ? input.text
      : templateContentText(
          templateRow,
          input.params ?? [],
        )

  const template_name =
    input.kind === 'template'
      ? input.templateName
      : null

  const {
    error: msgErr,
  } = await db
    .from('messages')
    .insert({
      conversation_id:
        input.conversationId,

      sender_type:
        'bot',

      content_type,

      content_text,

      template_name,

      message_id:
        waMessageId,

      status:
        'sent',
    })

  if (msgErr) {
    // Meta already has the message; record the DB error but don't
    // pretend the send failed.
    throw new Error(
      `sent to Meta but DB insert failed: ${msgErr.message}`,
    )
  }

  // ----------------------------------------------------------
  // Update conversation
  // ----------------------------------------------------------

  await db
    .from('conversations')
    .update({
      last_message_text:
        input.kind === 'template'
          ? (
              content_text ??
              `[template:${input.templateName}]`
            )
          : input.text,

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