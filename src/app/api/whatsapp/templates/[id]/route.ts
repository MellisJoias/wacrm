import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  deleteMessageTemplate,
  editMessageTemplate,
} from '@/lib/whatsapp/meta-api'
import {
  validateTemplatePayload,
  type TemplatePayload,
} from '@/lib/whatsapp/template-validators'
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components'
import { ensureImageHeaderHandle } from '@/lib/whatsapp/template-header-handle'

/**
 * Per-template lifecycle endpoint.
 *
 * PATCH  — edit an existing Meta-side template (and re-submit).
 *
 * DELETE — remove the template on Meta and drop the local row.
 *
 * Initial submission (DRAFT → PENDING) lives at the sibling
 * /submit endpoint.
 */

const EDITABLE_STATUSES = new Set(['APPROVED', 'REJECTED', 'PAUSED'])

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isDryRun(): boolean {
  return (
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === 'true' ||
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === '1'
  )
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params

    if (!UUID_RE.test(id)) {
      return NextResponse.json(
        { error: 'Invalid template id.' },
        { status: 400 },
      )
    }

    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()

    const accountId = profile?.account_id as string | undefined

    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    let payload: TemplatePayload

    try {
      payload = (await request.json()) as TemplatePayload
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body.' },
        { status: 400 },
      )
    }

    // The template itself determines which WhatsApp configuration
    // must be used. This prevents an edit from accidentally being
    // sent through another phone number belonging to the account.
    const { data: existing, error: lookupErr } = await supabase
      .from('message_templates')
      .select(
        'id, name, status, meta_template_id, language, whatsapp_config_id',
      )
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()

    if (lookupErr || !existing) {
      return NextResponse.json(
        { error: 'Template not found.' },
        { status: 404 },
      )
    }

    if (!existing.whatsapp_config_id) {
      return NextResponse.json(
        {
          error:
            'This template is not linked to a WhatsApp configuration. Sync or recreate the template before editing it.',
        },
        { status: 400 },
      )
    }

    if (!existing.meta_template_id) {
      return NextResponse.json(
        {
          error:
            'This template was never submitted to Meta — use New Template to submit it instead.',
        },
        { status: 400 },
      )
    }

    if (!EDITABLE_STATUSES.has(existing.status)) {
      return NextResponse.json(
        {
          error: `Templates in status ${existing.status} cannot be edited. Allowed: APPROVED, REJECTED, PAUSED.`,
        },
        { status: 400 },
      )
    }

    if (payload.category === 'Authentication') {
      return NextResponse.json(
        {
          error:
            'AUTHENTICATION templates are not editable here — manage them in Meta WhatsApp Manager.',
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

    const whatsappConfigId = existing.whatsapp_config_id

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('id', whatsappConfigId)
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError || !config) {
      return NextResponse.json(
        {
          error:
            'The WhatsApp configuration linked to this template was not found.',
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

    if (!isDryRun()) {
      const accessToken = decrypt(config.access_token)

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
        await editMessageTemplate({
          metaTemplateId: existing.meta_template_id,
          accessToken,
          components: metaPayload.components,
        })
      } catch (e) {
        const message =
          e instanceof Error ? e.message : 'Meta edit failed.'

        await supabase
          .from('message_templates')
          .update({
            submission_error: message,
            last_submitted_at: new Date().toISOString(),
          })
          .eq('id', id)
          .eq('account_id', accountId)
          .eq('whatsapp_config_id', whatsappConfigId)

        return NextResponse.json(
          { error: message },
          { status: 502 },
        )
      }
    }

    const { data: row, error: updErr } = await supabase
      .from('message_templates')
      .update({
        category: payload.category,
        header_type: payload.header_type ?? null,
        header_content: payload.header_content ?? null,
        header_media_url: payload.header_media_url ?? null,
        header_handle: payload.header_handle ?? null,
        body_text: payload.body_text,
        footer_text: payload.footer_text ?? null,
        buttons: payload.buttons ?? null,
        sample_values: payload.sample_values ?? null,
        status: 'PENDING',
        submission_error: null,
        rejection_reason: null,
        last_submitted_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('account_id', accountId)
      .eq('whatsapp_config_id', whatsappConfigId)
      .select()
      .single()

    if (updErr) {
      return NextResponse.json(
        {
          error: `Edited on Meta but failed to save locally: ${updErr.message}. Run "Sync from Meta" to recover.`,
        },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      template: row,
      dry_run: isDryRun(),
      whatsapp_config_id: whatsappConfigId,
    })
  } catch (error) {
    console.error('Error editing template:', error)

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to edit template.',
      },
      { status: 500 },
    )
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params

    if (!UUID_RE.test(id)) {
      return NextResponse.json(
        { error: 'Invalid template id.' },
        { status: 400 },
      )
    }

    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 },
      )
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()

    const accountId = profile?.account_id as string | undefined

    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const { data: existing, error: lookupErr } = await supabase
      .from('message_templates')
      .select('id, name, meta_template_id, whatsapp_config_id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()

    if (lookupErr || !existing) {
      return NextResponse.json(
        { error: 'Template not found.' },
        { status: 404 },
      )
    }

    if (!existing.whatsapp_config_id) {
      return NextResponse.json(
        {
          error:
            'This template is not linked to a WhatsApp configuration and cannot be safely deleted from Meta.',
        },
        { status: 400 },
      )
    }

    const whatsappConfigId = existing.whatsapp_config_id

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('id', whatsappConfigId)
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError || !config) {
      return NextResponse.json(
        {
          error:
            'The WhatsApp configuration linked to this template was not found.',
        },
        { status: 400 },
      )
    }

    if (existing.meta_template_id && !isDryRun()) {
      if (!config.waba_id) {
        return NextResponse.json(
          {
            error:
              'WABA (WhatsApp Business Account) ID missing — cannot delete this template on Meta.',
          },
          { status: 400 },
        )
      }

      const accessToken = decrypt(config.access_token)

      try {
        await deleteMessageTemplate({
          wabaId: config.waba_id,
          accessToken,
          name: existing.name,
          metaTemplateId: existing.meta_template_id,
        })
      } catch (e) {
        const message =
          e instanceof Error ? e.message : 'Meta delete failed.'

        return NextResponse.json(
          { error: message },
          { status: 502 },
        )
      }
    }

    const { error: delErr } = await supabase
      .from('message_templates')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)
      .eq('whatsapp_config_id', whatsappConfigId)

    if (delErr) {
      return NextResponse.json(
        {
          error: `Deleted on Meta but failed to delete locally: ${delErr.message}.`,
        },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      dry_run: isDryRun(),
      whatsapp_config_id: whatsappConfigId,
    })
  } catch (error) {
    console.error('Error deleting template:', error)

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to delete template.',
      },
      { status: 500 },
    )
  }
}