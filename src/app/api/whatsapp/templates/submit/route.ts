import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { submitMessageTemplate } from '@/lib/whatsapp/meta-api'
import {
  validateTemplatePayload,
  type TemplatePayload,
} from '@/lib/whatsapp/template-validators'
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components'
import { ensureImageHeaderHandle } from '@/lib/whatsapp/template-header-handle'
import { normalizeStatus } from '@/lib/whatsapp/template-status-normalize'

/**
 * Shared upsert payload builder — both the Meta-failure path and the
 * Meta-success path write nearly identical rows.
 */
function buildUpsertRow(
  accountId: string,
  userId: string,
  whatsappConfigId: string,
  payload: TemplatePayload,
  extras: {
    status: 'DRAFT' | string
    metaTemplateId: string | null
    submissionError: string | null
  },
) {
  return {
    account_id: accountId,
    user_id: userId,
    whatsapp_config_id: whatsappConfigId,
    name: payload.name,
    category: payload.category,
    language: payload.language,
    header_type: payload.header_type ?? null,
    header_content: payload.header_content ?? null,
    header_media_url: payload.header_media_url ?? null,
    header_handle: payload.header_handle ?? null,
    body_text: payload.body_text,
    footer_text: payload.footer_text ?? null,
    buttons: payload.buttons ?? null,
    sample_values: payload.sample_values ?? null,
    status: extras.status,
    meta_template_id: extras.metaTemplateId,
    submission_error: extras.submissionError,
    rejection_reason: null,
    last_submitted_at: new Date().toISOString(),
  }
}

async function upsertTemplateRow(
  supabase: SupabaseClient,
  row: ReturnType<typeof buildUpsertRow>,
) {
  return supabase
    .from('message_templates')
    .upsert(row, {
      onConflict: 'whatsapp_config_id,name,language',
    })
    .select()
    .single()
}

/**
 * Submit a template to Meta for approval AND persist it locally.
 *
 * whatsapp_config_id identifies which WhatsApp number/WABA receives
 * the template. This is required now that an account can have multiple
 * WhatsApp configurations.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    let body: (TemplatePayload & {
      whatsapp_config_id?: string
    })

    try {
      body = (await request.json()) as TemplatePayload & {
        whatsapp_config_id?: string
      }
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body.' },
        { status: 400 },
      )
    }

    const whatsappConfigId =
      typeof body.whatsapp_config_id === 'string'
        ? body.whatsapp_config_id.trim()
        : ''

    if (!whatsappConfigId) {
      return NextResponse.json(
        {
          error:
            'whatsapp_config_id is required. Select which WhatsApp number should receive this template.',
        },
        { status: 400 },
      )
    }

    const payload: TemplatePayload = {
      ...body,
    }

    delete (payload as TemplatePayload & {
      whatsapp_config_id?: string
    }).whatsapp_config_id

    if (payload.category === 'Authentication') {
      return NextResponse.json(
        {
          error:
            'AUTHENTICATION templates are not yet supported here — create them in Meta WhatsApp Manager and use "Sync from Meta".',
        },
        { status: 400 },
      )
    }

    try {
      validateTemplatePayload(payload)
    } catch (e) {
      return NextResponse.json(
        {
          error:
            e instanceof Error ? e.message : 'Validation failed.',
        },
        { status: 400 },
      )
    }

    // Resolve the selected WhatsApp configuration and make sure it
    // belongs to the current account. Never fall back to another config.
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('id', whatsappConfigId)
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError) {
      console.error(
        'Error loading WhatsApp config for template submission:',
        configError,
      )

      return NextResponse.json(
        { error: 'Failed to load the selected WhatsApp configuration.' },
        { status: 500 },
      )
    }

    if (!config) {
      return NextResponse.json(
        {
          error:
            'The selected WhatsApp configuration was not found or does not belong to this account.',
        },
        { status: 400 },
      )
    }

    if (!config.waba_id) {
      return NextResponse.json(
        {
          error:
            'WABA (WhatsApp Business Account) ID missing. Re-connect this WhatsApp account in Settings.',
        },
        { status: 400 },
      )
    }

    const dryRun =
      process.env.WHATSAPP_TEMPLATES_DRY_RUN === 'true' ||
      process.env.WHATSAPP_TEMPLATES_DRY_RUN === '1'

    let metaTemplateId: string
    let metaStatus: string

    if (dryRun) {
      metaTemplateId = `dry-run-${crypto.randomUUID()}`
      metaStatus = 'PENDING'
    } else {
      const accessToken = decrypt(config.access_token)

      // Image headers need a Resumable-Upload handle. Derive it from
      // header_media_url before building the Meta payload.
      try {
        await ensureImageHeaderHandle(payload, accessToken)
      } catch (e) {
        return NextResponse.json(
          {
            error:
              e instanceof Error
                ? e.message
                : 'Header image upload failed.',
          },
          { status: 400 },
        )
      }

      const metaPayload = buildMetaTemplatePayload(payload)

      try {
        const meta = await submitMessageTemplate({
          wabaId: config.waba_id,
          accessToken,
          payload: metaPayload,
        })

        metaTemplateId = meta.id
        metaStatus = meta.status
      } catch (e) {
        const message =
          e instanceof Error ? e.message : 'Meta submit failed.'

        // Persist the failure so the user can retry. The template remains
        // DRAFT until it is successfully submitted.
        await upsertTemplateRow(
          supabase,
          buildUpsertRow(
            accountId,
            userId,
            whatsappConfigId,
            payload,
            {
              status: 'DRAFT',
              metaTemplateId: null,
              submissionError: message,
            },
          ),
        )

        const isRateLimit = /\b429\b/.test(message)

        return NextResponse.json(
          {
            error: isRateLimit
              ? 'Meta rate limit hit (100 template creates per hour). Try again later.'
              : message,
          },
          { status: isRateLimit ? 429 : 502 },
        )
      }
    }

    const { data: row, error: upsertErr } = await upsertTemplateRow(
      supabase,
      buildUpsertRow(
        accountId,
        userId,
        whatsappConfigId,
        payload,
        {
          status: normalizeStatus(metaStatus),
          metaTemplateId,
          submissionError: null,
        },
      ),
    )

    if (upsertErr) {
      // The submit succeeded on Meta's side but the local persistence
      // failed. Surface the Meta ID so Sync from Meta can recover it.
      return NextResponse.json(
        {
          error: `Submitted to Meta but failed to save locally: ${upsertErr.message}. Run "Sync from Meta" to recover.`,
          meta_template_id: metaTemplateId,
        },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      template: row,
      dry_run: dryRun,
      whatsapp_config_id: whatsappConfigId,
    })
  } catch (error) {
    if (
      error instanceof UnauthorizedError ||
      error instanceof ForbiddenError
    ) {
      return toErrorResponse(error)
    }

    console.error('Error submitting template:', error)

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to submit template.',
      },
      { status: 500 },
    )
  }
}