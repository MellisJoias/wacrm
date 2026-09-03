/**
 * Meta WhatsApp Cloud API helpers.
 *
 * Every function takes a single options object (named parameters) instead
 * of positional arguments. This was a deliberate choice after the same
 * swapped-args bug was found four times in a row with the positional form
 * (e.g. `(accessToken, phoneNumberId)` vs `(phoneNumberId, accessToken)`).
 * With named params, a typo surfaces immediately as a TypeScript error
 * instead of a runtime rejection from Meta.
 */

const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

export interface MetaSendResult {
  messageId: string
}

export interface MetaPhoneInfo {
  id: string
  display_phone_number: string
  verified_name?: string
  quality_rating?: string
}

interface MetaErrorResponse {
  error?: { message?: string; code?: number; type?: string }
}

async function throwMetaError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as MetaErrorResponse
    if (data.error?.message) message = data.error.message
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message)
}

// ============================================================
// Phone number / account
// ============================================================

export interface VerifyPhoneNumberArgs {
  phoneNumberId: string
  accessToken: string
}

/**
 * Verify a Meta phone number ID by fetching its public metadata
 * (display_phone_number, verified_name, quality_rating).
 */
export async function verifyPhoneNumber(
  args: VerifyPhoneNumberArgs
): Promise<MetaPhoneInfo> {
  const { phoneNumberId, accessToken } = args
  const url = `${META_API_BASE}/${phoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  return response.json()
}

// ============================================================
// Cloud API registration (subscription for inbound webhooks)
// ============================================================

export interface RegisterPhoneNumberArgs {
  phoneNumberId: string
  accessToken: string
  pin: string
}

export interface RegisterPhoneNumberResult {
  success: boolean
  alreadyRegistered: boolean
}

export async function registerPhoneNumber(
  args: RegisterPhoneNumberArgs
): Promise<RegisterPhoneNumberResult> {
  const { phoneNumberId, accessToken, pin } = args
  const url = `${META_API_BASE}/${phoneNumberId}/register`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
  })

  if (response.ok) {
    return { success: true, alreadyRegistered: false }
  }

  let data: {
    error?: {
      message?: string
      code?: number
      error_subcode?: number
    }
  } = {}

  try {
    data = await response.json()
  } catch {
    /* keep empty */
  }

  const message =
    data.error?.message ??
    `Meta API error: ${response.status}`

  if (/already.*registered/i.test(message)) {
    return { success: true, alreadyRegistered: true }
  }

  throw new Error(message)
}

export interface SubscribeWabaToAppArgs {
  wabaId: string
  accessToken: string
}

export async function subscribeWabaToApp(
  args: SubscribeWabaToAppArgs
): Promise<void> {
  const { wabaId, accessToken } = args
  const url = `${META_API_BASE}/${wabaId}/subscribed_apps`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })

  if (!response.ok) {
    await throwMetaError(
      response,
      `Meta API error: ${response.status}`
    )
  }
}

export interface GetSubscribedAppsArgs {
  wabaId: string
  accessToken: string
}

export interface SubscribedApp {
  whatsapp_business_api_data?: {
    id?: string
    name?: string
    link?: string
  }
}

export async function getSubscribedApps(
  args: GetSubscribedAppsArgs
): Promise<SubscribedApp[]> {
  const { wabaId, accessToken } = args
  const url = `${META_API_BASE}/${wabaId}/subscribed_apps`

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })

  if (!response.ok) {
    await throwMetaError(
      response,
      `Meta API error: ${response.status}`
    )
  }

  const data =
    (await response.json()) as {
      data?: SubscribedApp[]
    }

  return data.data ?? []
}

// ============================================================
// Sending
// ============================================================

export interface SendTextMessageArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  text: string
  contextMessageId?: string
}

export async function sendTextMessage(
  args: SendTextMessageArgs
): Promise<MetaSendResult> {
  const {
    phoneNumberId,
    accessToken,
    to,
    text,
    contextMessageId,
  } = args

  const url =
    `${META_API_BASE}/${phoneNumberId}/messages`

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body: text },
  }

  if (contextMessageId) {
    body.context = {
      message_id: contextMessageId,
    }
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    await throwMetaError(
      response,
      `Meta API error: ${response.status}`
    )
  }

  const data = await response.json()

  return {
    messageId: data.messages[0].id,
  }
}

export type MediaKind =
  | 'image'
  | 'video'
  | 'document'
  | 'audio'

export interface SendMediaMessageArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  kind: MediaKind
  link: string
  caption?: string
  filename?: string
  contextMessageId?: string
}

export async function sendMediaMessage(
  args: SendMediaMessageArgs,
): Promise<MetaSendResult> {
  const {
    phoneNumberId,
    accessToken,
    to,
    kind,
    link,
    caption,
    filename,
    contextMessageId,
  } = args

  if (!link) {
    throw new Error(
      'sendMediaMessage requires a link.'
    )
  }

  const url =
    `${META_API_BASE}/${phoneNumberId}/messages`

  const media: Record<string, unknown> = {
    link,
  }

  if (
    caption &&
    kind !== 'audio'
  ) {
    media.caption = caption
  }

  if (
    kind === 'document' &&
    filename
  ) {
    media.filename = filename
  }

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: kind,
    [kind]: media,
  }

  if (contextMessageId) {
    body.context = {
      message_id: contextMessageId,
    }
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    await throwMetaError(
      response,
      `Meta API error: ${response.status}`
    )
  }

  const data = await response.json()

  return {
    messageId: data.messages[0].id,
  }
}

import type { MessageTemplate } from '@/types'

import {
  buildSendComponents,
  type SendTimeParams,
} from './template-send-builder'

export interface SendTemplateMessageArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  templateName: string
  language?: string
  params?: string[]
  template?: MessageTemplate
  messageParams?: SendTimeParams
  contextMessageId?: string
}

/**
 * Send a pre-approved WhatsApp message template.
 *
 * The request has a 30 second timeout so one stalled Meta request
 * cannot block the entire broadcast indefinitely.
 */
export async function sendTemplateMessage(
  args: SendTemplateMessageArgs
): Promise<MetaSendResult> {
  const {
    phoneNumberId,
    accessToken,
    to,
    templateName,
    language = 'en_US',
    params,
    template,
    messageParams,
    contextMessageId,
  } = args

  const url =
    `${META_API_BASE}/${phoneNumberId}/messages`

  const templatePayload: Record<string, unknown> = {
    name: templateName,
    language: {
      code: language,
    },
  }

  if (template) {
    const components =
      buildSendComponents(
        template,
        {
          body:
            messageParams?.body ??
            params,

          headerText:
            messageParams?.headerText,

          headerMediaUrl:
            messageParams?.headerMediaUrl,

          headerMediaId:
            messageParams?.headerMediaId,

          buttonParams:
            messageParams?.buttonParams,
        }
      )

    if (components.length > 0) {
      templatePayload.components =
        components
    }
  } else if (
    params &&
    params.length > 0
  ) {
    templatePayload.components = [
      {
        type: 'body',
        parameters:
          params.map(
            (p) => ({
              type: 'text',
              text: String(p),
            })
          ),
      },
    ]
  }

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: templatePayload,
  }

  if (contextMessageId) {
    body.context = {
      message_id: contextMessageId,
    }
  }

  // ============================================================
  // Meta API request with timeout
  // ============================================================

  const controller =
    new AbortController()

  const timeout =
    setTimeout(
      () => {
        controller.abort()
      },
      30_000
    )

  let response: Response

  try {
    response =
      await fetch(
        url,
        {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/json',

            Authorization:
              `Bearer ${accessToken}`,
          },

          body:
            JSON.stringify(body),

          signal:
            controller.signal,
        }
      )
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === 'AbortError'
    ) {
      throw new Error(
        'Meta API timeout after 30 seconds'
      )
    }

    throw error
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    await throwMetaError(
      response,
      `Meta API error: ${response.status}`
    )
  }

  const data =
    await response.json()

  return {
    messageId:
      data.messages[0].id,
  }
}

// ============================================================
// Resumable Upload
// ============================================================

export interface UploadResumableMediaArgs {
  appId: string
  accessToken: string
  fileName: string
  mimeType: string
  bytes: Uint8Array
}

export async function uploadResumableMedia(
  args: UploadResumableMediaArgs,
): Promise<{ handle: string }> {
  const {
    appId,
    accessToken,
    fileName,
    mimeType,
    bytes,
  } = args

  const startParams =
    new URLSearchParams({
      file_name: fileName,
      file_length:
        String(bytes.byteLength),
      file_type: mimeType,
      access_token: accessToken,
    })

  const startRes =
    await fetch(
      `${META_API_BASE}/${appId}/uploads?${startParams.toString()}`,
      {
        method: 'POST',
      }
    )

  if (!startRes.ok) {
    await throwMetaError(
      startRes,
      `Resumable upload start failed: ${startRes.status}`
    )
  }

  const startData =
    (await startRes.json()) as {
      id?: string
    }

  if (!startData.id) {
    throw new Error(
      'Resumable upload did not return a session id.'
    )
  }

  const uploadRes =
    await fetch(
      `${META_API_BASE}/${startData.id}`,
      {
        method: 'POST',

        headers: {
          Authorization:
            `OAuth ${accessToken}`,

          file_offset:
            '0',
        },

        body:
          bytes as unknown as BodyInit,
      }
    )

  if (!uploadRes.ok) {
    await throwMetaError(
      uploadRes,
      `Resumable upload failed: ${uploadRes.status}`
    )
  }

  const uploadData =
    (await uploadRes.json()) as {
      h?: string
    }

  if (!uploadData.h) {
    throw new Error(
      'Resumable upload did not return a file handle.'
    )
  }

  return {
    handle: uploadData.h,
  }
}

// ============================================================
// Template submission
// ============================================================

import type {
  MetaTemplateSubmitPayload
} from './template-components'

export interface SubmitMessageTemplateArgs {
  wabaId: string
  accessToken: string
  payload: MetaTemplateSubmitPayload
}

export interface SubmitMessageTemplateResult {
  id: string
  status: string
  category?: string
}

export async function submitMessageTemplate(
  args: SubmitMessageTemplateArgs
): Promise<SubmitMessageTemplateResult> {
  const {
    wabaId,
    accessToken,
    payload,
  } = args

  const url =
    `${META_API_BASE}/${wabaId}/message_templates`

  const response =
    await fetch(
      url,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json',

          Authorization:
            `Bearer ${accessToken}`,
        },

        body:
          JSON.stringify(payload),
      }
    )

  if (!response.ok) {
    await throwMetaError(
      response,
      `Meta API error: ${response.status}`
    )
  }

  const data =
    await response.json()

  if (!data?.id) {
    throw new Error(
      'Meta accepted the template but returned no id.'
    )
  }

  return {
    id:
      String(data.id),

    status:
      typeof data.status === 'string'
        ? data.status
        : 'PENDING',

    category:
      typeof data.category === 'string'
        ? data.category
        : undefined,
  }
}

export interface EditMessageTemplateArgs {
  metaTemplateId: string
  accessToken: string
  components: MetaTemplateSubmitPayload['components']
  category?: MetaTemplateSubmitPayload['category']
}

export interface EditMessageTemplateResult {
  success: boolean
}

export async function editMessageTemplate(
  args: EditMessageTemplateArgs
): Promise<EditMessageTemplateResult> {
  const {
    metaTemplateId,
    accessToken,
    components,
    category,
  } = args

  const body: Record<string, unknown> = {
    components,
  }

  if (category) {
    body.category = category
  }

  const response =
    await fetch(
      `${META_API_BASE}/${metaTemplateId}`,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json',

          Authorization:
            `Bearer ${accessToken}`,
        },

        body:
          JSON.stringify(body),
      }
    )

  if (!response.ok) {
    await throwMetaError(
      response,
      `Meta API error: ${response.status}`
    )
  }

  const data =
    await response.json().catch(
      () => ({})
    )

  return {
    success:
      data?.success !== false,
  }
}

export interface DeleteMessageTemplateArgs {
  wabaId: string
  accessToken: string
  name: string
  metaTemplateId?: string
}

export async function deleteMessageTemplate(
  args: DeleteMessageTemplateArgs
): Promise<void> {
  const {
    wabaId,
    accessToken,
    name,
    metaTemplateId,
  } = args

  const params =
    new URLSearchParams({
      name,
    })

  if (metaTemplateId) {
    params.set(
      'hsm_id',
      metaTemplateId
    )
  }

  const url =
    `${META_API_BASE}/${wabaId}/message_templates?${params.toString()}`

  const response =
    await fetch(
      url,
      {
        method: 'DELETE',

        headers: {
          Authorization:
            `Bearer ${accessToken}`,
        },
      }
    )

  if (response.status === 404) {
    return
  }

  if (!response.ok) {
    await throwMetaError(
      response,
      `Meta API error: ${response.status}`
    )
  }
}

// ============================================================
// Reactions
// ============================================================

export interface SendReactionMessageArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  targetMessageId: string
  emoji: string
}

export async function sendReactionMessage(
  args: SendReactionMessageArgs
): Promise<MetaSendResult> {
  const {
    phoneNumberId,
    accessToken,
    to,
    targetMessageId,
    emoji,
  } = args

  const url =
    `${META_API_BASE}/${phoneNumberId}/messages`

  const response =
    await fetch(
      url,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json',

          Authorization:
            `Bearer ${accessToken}`,
        },

        body:
          JSON.stringify({
            messaging_product:
              'whatsapp',

            recipient_type:
              'individual',

            to,

            type:
              'reaction',

            reaction: {
              message_id:
                targetMessageId,

              emoji,
            },
          }),
      }
    )

  if (!response.ok) {
    await throwMetaError(
      response,
      `Meta API error: ${response.status}`
    )
  }

  const data =
    await response.json()

  return {
    messageId:
      data.messages[0].id,
  }
}

// ============================================================
// Interactive
// ============================================================

export const INTERACTIVE_LIMITS = {
  maxButtons: 3,
  buttonTitleMaxLength: 20,
  maxListSections: 10,
  maxListRowsTotal: 10,
  listRowTitleMaxLength: 24,
  listRowDescriptionMaxLength: 72,
  bodyMaxLength: 1024,
  footerMaxLength: 60,
  headerTextMaxLength: 60,
} as const

export interface InteractiveButton {
  id: string
  title: string
}

export interface SendInteractiveButtonsArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  bodyText: string
  headerText?: string
  footerText?: string
  buttons: InteractiveButton[]
  contextMessageId?: string
}

export async function sendInteractiveButtons(
  args: SendInteractiveButtonsArgs
): Promise<MetaSendResult> {
  const {
    phoneNumberId,
    accessToken,
    to,
    bodyText,
    headerText,
    footerText,
    buttons,
    contextMessageId,
  } = args

  validateInteractiveBody(bodyText)
  validateInteractiveHeaderFooter(
    headerText,
    footerText
  )

  if (
    buttons.length < 1 ||
    buttons.length >
      INTERACTIVE_LIMITS.maxButtons
  ) {
    throw new Error(
      `Interactive button message requires 1-${INTERACTIVE_LIMITS.maxButtons} buttons (got ${buttons.length}).`
    )
  }

  const seenButtonIds =
    new Set<string>()

  for (
    const btn of buttons
  ) {
    if (!btn.id) {
      throw new Error(
        'Interactive button missing id.'
      )
    }

    if (
      seenButtonIds.has(btn.id)
    ) {
      throw new Error(
        `Interactive message has duplicate button id "${btn.id}".`
      )
    }

    seenButtonIds.add(btn.id)

    if (!btn.title) {
      throw new Error(
        `Interactive button "${btn.id}" missing title.`
      )
    }

    if (
      btn.title.length >
      INTERACTIVE_LIMITS.buttonTitleMaxLength
    ) {
      throw new Error(
        `Interactive button title "${btn.title}" exceeds ${INTERACTIVE_LIMITS.buttonTitleMaxLength} chars.`
      )
    }
  }

  const interactive: Record<string, unknown> = {
    type: 'button',

    body: {
      text: bodyText,
    },

    action: {
      buttons:
        buttons.map(
          (b) => ({
            type: 'reply',

            reply: {
              id: b.id,
              title: b.title,
            },
          })
        ),
    },
  }

  if (headerText) {
    interactive.header = {
      type: 'text',
      text: headerText,
    }
  }

  if (footerText) {
    interactive.footer = {
      text: footerText,
    }
  }

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive,
  }

  if (contextMessageId) {
    body.context = {
      message_id: contextMessageId,
    }
  }

  const url =
    `${META_API_BASE}/${phoneNumberId}/messages`

  const response =
    await fetch(
      url,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json',

          Authorization:
            `Bearer ${accessToken}`,
        },

        body:
          JSON.stringify(body),
      }
    )

  if (!response.ok) {
    await throwMetaError(
      response,
      `Meta API error: ${response.status}`
    )
  }

  const data =
    await response.json()

  return {
    messageId:
      data.messages[0].id,
  }
}

export interface InteractiveListRow {
  id: string
  title: string
  description?: string
}

export interface InteractiveListSection {
  title?: string
  rows: InteractiveListRow[]
}

export interface SendInteractiveListArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  bodyText: string
  buttonLabel: string
  headerText?: string
  footerText?: string
  sections: InteractiveListSection[]
  contextMessageId?: string
}

export async function sendInteractiveList(
  args: SendInteractiveListArgs
): Promise<MetaSendResult> {
  const {
    phoneNumberId,
    accessToken,
    to,
    bodyText,
    buttonLabel,
    headerText,
    footerText,
    sections,
    contextMessageId,
  } = args

  validateInteractiveBody(bodyText)
  validateInteractiveHeaderFooter(
    headerText,
    footerText
  )

  if (!buttonLabel) {
    throw new Error(
      'Interactive list requires a buttonLabel.'
    )
  }

  if (
    buttonLabel.length >
    INTERACTIVE_LIMITS.buttonTitleMaxLength
  ) {
    throw new Error(
      `Interactive list buttonLabel "${buttonLabel}" exceeds ${INTERACTIVE_LIMITS.buttonTitleMaxLength} chars.`
    )
  }

  if (
    sections.length < 1 ||
    sections.length >
      INTERACTIVE_LIMITS.maxListSections
  ) {
    throw new Error(
      `Interactive list requires 1-${INTERACTIVE_LIMITS.maxListSections} sections (got ${sections.length}).`
    )
  }

  const totalRows =
    sections.reduce(
      (sum, s) =>
        sum + s.rows.length,
      0
    )

  if (
    totalRows < 1 ||
    totalRows >
      INTERACTIVE_LIMITS.maxListRowsTotal
  ) {
    throw new Error(
      `Interactive list requires 1-${INTERACTIVE_LIMITS.maxListRowsTotal} rows total across all sections (got ${totalRows}).`
    )
  }

  const seenIds =
    new Set<string>()

  for (
    const section of sections
  ) {
    for (
      const row of section.rows
    ) {
      if (!row.id) {
        throw new Error(
          'Interactive list row missing id.'
        )
      }

      if (
        seenIds.has(row.id)
      ) {
        throw new Error(
          `Interactive list has duplicate row id "${row.id}".`
        )
      }

      seenIds.add(row.id)

      if (!row.title) {
        throw new Error(
          `Interactive list row "${row.id}" missing title.`
        )
      }

      if (
        row.title.length >
        INTERACTIVE_LIMITS.listRowTitleMaxLength
      ) {
        throw new Error(
          `Interactive list row title "${row.id}" exceeds ${INTERACTIVE_LIMITS.listRowTitleMaxLength} chars.`
        )
      }

      if (
        row.description &&
        row.description.length >
          INTERACTIVE_LIMITS.listRowDescriptionMaxLength
      ) {
        throw new Error(
          `Interactive list row description for "${row.id}" exceeds ${INTERACTIVE_LIMITS.listRowDescriptionMaxLength} chars.`
        )
      }
    }
  }

  const interactive: Record<string, unknown> = {
    type: 'list',

    body: {
      text: bodyText,
    },

    action: {
      button: buttonLabel,

      sections:
        sections.map(
          (s) => ({
            ...(s.title
              ? {
                  title:
                    s.title,
                }
              : {}),

            rows:
              s.rows.map(
                (r) => ({
                  id: r.id,
                  title: r.title,

                  ...(r.description
                    ? {
                        description:
                          r.description,
                      }
                    : {}),
                })
              ),
          })
        ),
    },
  }

  if (headerText) {
    interactive.header = {
      type: 'text',
      text: headerText,
    }
  }

  if (footerText) {
    interactive.footer = {
      text: footerText,
    }
  }

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive,
  }

  if (contextMessageId) {
    body.context = {
      message_id: contextMessageId,
    }
  }

  const url =
    `${META_API_BASE}/${phoneNumberId}/messages`

  const response =
    await fetch(
      url,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json',

          Authorization:
            `Bearer ${accessToken}`,
        },

        body:
          JSON.stringify(body),
      }
    )

  if (!response.ok) {
    await throwMetaError(
      response,
      `Meta API error: ${response.status}`
    )
  }

  const data =
    await response.json()

  return {
    messageId:
      data.messages[0].id,
  }
}

function validateInteractiveBody(
  bodyText: string
): void {
  if (!bodyText) {
    throw new Error(
      'Interactive message requires bodyText.'
    )
  }

  if (
    bodyText.length >
    INTERACTIVE_LIMITS.bodyMaxLength
  ) {
    throw new Error(
      `Interactive bodyText exceeds ${INTERACTIVE_LIMITS.bodyMaxLength} chars.`
    )
  }
}

function validateInteractiveHeaderFooter(
  headerText: string | undefined,
  footerText: string | undefined,
): void {
  if (
    headerText &&
    headerText.length >
      INTERACTIVE_LIMITS.headerTextMaxLength
  ) {
    throw new Error(
      `Interactive headerText exceeds ${INTERACTIVE_LIMITS.headerTextMaxLength} chars.`
    )
  }

  if (
    footerText &&
    footerText.length >
      INTERACTIVE_LIMITS.footerMaxLength
  ) {
    throw new Error(
      `Interactive footerText exceeds ${INTERACTIVE_LIMITS.footerMaxLength} chars.`
    )
  }
}

// ============================================================
// Media
// ============================================================

export interface GetMediaUrlArgs {
  mediaId: string
  accessToken: string
}

export async function getMediaUrl(
  args: GetMediaUrlArgs
): Promise<{
  url: string
  mimeType: string
  fileSize: number | null
}> {
  const {
    mediaId,
    accessToken,
  } = args

  const response =
    await fetch(
      `${META_API_BASE}/${mediaId}`,
      {
        headers: {
          Authorization:
            `Bearer ${accessToken}`,
        },
      }
    )

  if (!response.ok) {
    await throwMetaError(
      response,
      `Media fetch failed: ${response.status}`
    )
  }

  const data =
    await response.json()

  if (!data.url) {
    throw new Error(
      'Media URL not found in Meta response'
    )
  }

  const size =
    Number(data.file_size)

  return {
    url: data.url,

    mimeType:
      data.mime_type ||
      'application/octet-stream',

    fileSize:
      Number.isFinite(size) &&
      size >= 0
        ? size
        : null,
  }
}

export interface DownloadMediaArgs {
  downloadUrl: string
  accessToken: string
}

export async function downloadMedia(
  args: DownloadMediaArgs
): Promise<{
  buffer: Buffer
  contentType: string
}> {
  const {
    downloadUrl,
    accessToken,
  } = args

  const response =
    await fetch(
      downloadUrl,
      {
        headers: {
          Authorization:
            `Bearer ${accessToken}`,
        },
      }
    )

  if (!response.ok) {
    throw new Error(
      `Media download failed: ${response.status}`
    )
  }

  const contentType =
    response.headers.get(
      'content-type'
    ) ||
    'application/octet-stream'

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    )

  return {
    buffer,
    contentType,
  }
}