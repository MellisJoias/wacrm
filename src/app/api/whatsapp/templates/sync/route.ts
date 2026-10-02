import { NextResponse } from 'next/server'
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { normalizeStatus } from '@/lib/whatsapp/template-status-normalize'
import type {
  TemplateButton,
  TemplateSampleValues,
} from '@/types'

/**
 * Sync message templates from Meta → local message_templates table.
 *
 * Templates are now scoped to a specific whatsapp_config_id.
 *
 * Query:
 *
 *   ?whatsapp_config_id=<uuid>
 *
 * When the account has exactly one WhatsApp configuration, the query
 * parameter remains optional for backwards compatibility.
 *
 * When the account has multiple configurations, whatsapp_config_id
 * is required so templates from different WhatsApp numbers never get
 * mixed together.
 */

const META_API_VERSION = 'v21.0'
const META_API_BASE =
  `https://graph.facebook.com/${META_API_VERSION}`

interface MetaButton {
  type: string
  text: string
  url?: string
  phone_number?: string
  example?: string[] | string
}

interface MetaTemplateComponent {
  type: string
  text?: string
  format?: string
  buttons?: MetaButton[]
  example?: {
    header_text?: string[]
    header_handle?: string[]
    body_text?: string[][]
  }
}

interface MetaTemplate {
  id: string
  name: string
  language: string
  status: string
  category: string
  components?: MetaTemplateComponent[]
  quality_score?:
    | {
        score?: string
      }
    | string
}

function normalizeCategory(
  meta: string,
): 'Marketing' | 'Utility' | 'Authentication' {
  const upper = meta.toUpperCase()

  if (upper === 'UTILITY') {
    return 'Utility'
  }

  if (upper === 'AUTHENTICATION') {
    return 'Authentication'
  }

  return 'Marketing'
}

function normalizeQualityScore(
  raw: MetaTemplate['quality_score'],
): 'GREEN' | 'YELLOW' | 'RED' | null {
  const score =
    typeof raw === 'string'
      ? raw
      : raw?.score
        ? String(raw.score)
        : null

  if (!score) {
    return null
  }

  const upper = score.toUpperCase()

  return upper === 'GREEN' ||
    upper === 'YELLOW' ||
    upper === 'RED'
    ? (upper as 'GREEN' | 'YELLOW' | 'RED')
    : null
}

function parseButtons(
  metaButtons: MetaButton[] | undefined,
): TemplateButton[] {
  if (!metaButtons?.length) {
    return []
  }

  const out: TemplateButton[] = []

  for (const b of metaButtons) {
    switch (b.type?.toUpperCase()) {
      case 'QUICK_REPLY':
        out.push({
          type: 'QUICK_REPLY',
          text: b.text,
        })
        break

      case 'URL':
        out.push({
          type: 'URL',
          text: b.text,
          url: b.url ?? '',
          example: Array.isArray(b.example)
            ? b.example[0]
            : b.example,
        })
        break

      case 'PHONE_NUMBER':
        out.push({
          type: 'PHONE_NUMBER',
          text: b.text,
          phone_number:
            b.phone_number ?? '',
        })
        break

      case 'COPY_CODE':
        out.push({
          type: 'COPY_CODE',
          text: b.text,
          example: Array.isArray(b.example)
            ? b.example[0] ?? ''
            : b.example ?? '',
        })
        break

      // OTP, FLOW, etc. — out of scope for v1.
    }
  }

  return out
}

function extractSampleValues(
  body: MetaTemplateComponent | undefined,
  header: MetaTemplateComponent | undefined,
): TemplateSampleValues | null {
  const bodySample =
    body?.example?.body_text?.[0]

  const headerSample =
    header?.example?.header_text

  if (
    !bodySample?.length &&
    !headerSample?.length
  ) {
    return null
  }

  const sv: TemplateSampleValues = {}

  if (bodySample?.length) {
    sv.body = bodySample
  }

  if (headerSample?.length) {
    sv.header = headerSample
  }

  return sv
}

export async function POST(
  request: Request,
) {
  try {
    // Syncing templates is settings-class data and therefore requires
    // admin access.
    const {
      supabase,
      accountId,
      userId,
    } = await requireRole('admin')

    // ----------------------------------------------------------
    // Resolve WhatsApp configuration
    // ----------------------------------------------------------

    const url =
      new URL(request.url)

    let whatsappConfigId =
      url.searchParams.get(
        'whatsapp_config_id',
      )

    if (!whatsappConfigId) {
      const {
        data: configs,
        error: configsError,
      } = await supabase
        .from('whatsapp_config')
        .select('id')
        .eq(
          'account_id',
          accountId,
        )
        .order(
          'created_at',
          {
            ascending: true,
          },
        )

      if (configsError) {
        console.error(
          'Error loading WhatsApp configurations:',
          configsError,
        )

        return NextResponse.json(
          {
            error:
              'Failed to load WhatsApp configurations.',
          },
          {
            status: 500,
          },
        )
      }

      if (
        !configs ||
        configs.length === 0
      ) {
        return NextResponse.json(
          {
            error:
              'WhatsApp not configured. Connect your WhatsApp Business account in Settings first.',
          },
          {
            status: 400,
          },
        )
      }

      if (
        configs.length > 1
      ) {
        return NextResponse.json(
          {
            error:
              'whatsapp_config_id is required when this account has multiple WhatsApp configurations.',
          },
          {
            status: 400,
          },
        )
      }

      whatsappConfigId =
        configs[0].id
    }

    // ----------------------------------------------------------
    // Load the selected WhatsApp configuration
    // ----------------------------------------------------------

    const {
      data: config,
      error: configError,
    } = await supabase
      .from('whatsapp_config')
      .select(
        'id, account_id, user_id, waba_id, access_token, phone_number_id, display_name',
      )
      .eq(
        'id',
        whatsappConfigId,
      )
      .eq(
        'account_id',
        accountId,
      )
      .maybeSingle()

    if (configError) {
      console.error(
        'Error loading WhatsApp configuration:',
        configError,
      )

      return NextResponse.json(
        {
          error:
            'Failed to load WhatsApp configuration.',
        },
        {
          status: 500,
        },
      )
    }

    if (!config) {
      return NextResponse.json(
        {
          error:
            'WhatsApp configuration not found for this account.',
        },
        {
          status: 404,
        },
      )
    }

    if (!config.waba_id) {
      return NextResponse.json(
        {
          error:
            'WABA (WhatsApp Business Account) ID missing. Re-connect this WhatsApp account in Settings.',
        },
        {
          status: 400,
        },
      )
    }

    const accessToken =
      decrypt(
        config.access_token,
      )

    // ----------------------------------------------------------
    // Fetch templates from Meta
    // ----------------------------------------------------------

    const metaTemplates: MetaTemplate[] =
      []

    let nextUrl:
      | string
      | null =
      `${META_API_BASE}/${config.waba_id}/message_templates?limit=100&fields=id,name,language,status,category,components,quality_score`

    const PAGE_CAP = 20
    let pageCount = 0

    while (
      nextUrl &&
      pageCount < PAGE_CAP
    ) {
      pageCount++

      const metaRes: Response =
        await fetch(
          nextUrl,
          {
            headers: {
              Authorization:
                `Bearer ${accessToken}`,
            },
          },
        )

      if (!metaRes.ok) {
        let metaErr =
          `Meta API error: ${metaRes.status}`

        try {
          const body =
            await metaRes.json()

          if (
            body?.error?.message
          ) {
            metaErr =
              body.error.message
          }
        } catch {
          // Response wasn't JSON.
        }

        return NextResponse.json(
          {
            error: metaErr,
          },
          {
            status: 502,
          },
        )
      }

      const metaBody: {
        data?: MetaTemplate[]
        paging?: {
          next?: string
        }
      } =
        await metaRes.json()

      if (metaBody.data) {
        metaTemplates.push(
          ...metaBody.data,
        )
      }

      nextUrl =
        metaBody.paging?.next ??
        null
    }

    // ----------------------------------------------------------
    // Sync into local message_templates
    // ----------------------------------------------------------

    let inserted = 0
    let updated = 0

    const errors: {
      name: string
      language: string
      message: string
    }[] = []

    for (
      const t of metaTemplates
    ) {
      const body =
        (
          t.components ?? []
        ).find(
          (c) =>
            c.type === 'BODY',
        )

      const header =
        (
          t.components ?? []
        ).find(
          (c) =>
            c.type === 'HEADER',
        )

      const footer =
        (
          t.components ?? []
        ).find(
          (c) =>
            c.type === 'FOOTER',
        )

      const buttons =
        (
          t.components ?? []
        ).find(
          (c) =>
            c.type === 'BUTTONS',
        )

      const parsedButtons =
        parseButtons(
          buttons?.buttons,
        )

      const sampleValues =
        extractSampleValues(
          body,
          header,
        )

      const headerFormat =
        header?.format?.toUpperCase()

      const headerType =
        headerFormat === 'TEXT' ||
        headerFormat === 'IMAGE' ||
        headerFormat === 'VIDEO' ||
        headerFormat === 'DOCUMENT'
          ? headerFormat.toLowerCase()
          : null

      const row = {
        // Account tenancy
        account_id:
          accountId,

        // The critical multi-number field.
        whatsapp_config_id:
          whatsappConfigId,

        // User audit
        user_id:
          userId,

        name:
          t.name,

        category:
          normalizeCategory(
            t.category,
          ),

        language:
          t.language,

        header_type:
          headerType,

        header_content:
          header?.text ??
          null,

        header_handle:
          header?.example
            ?.header_handle?.[0] ??
          null,

        body_text:
          body?.text ??
          '',

        footer_text:
          footer?.text ??
          null,

        buttons:
          parsedButtons.length
            ? parsedButtons
            : null,

        sample_values:
          sampleValues,

        status:
          normalizeStatus(
            t.status,
          ),

        meta_template_id:
          t.id,

        quality_score:
          normalizeQualityScore(
            t.quality_score,
          ),

        updated_at:
          new Date().toISOString(),
      }

      // IMPORTANT:
      //
      // Template identity is now:
      //
      //   whatsapp_config_id + name + language
      //
      // The same template name/language may legitimately exist
      // on two different WhatsApp numbers.
      const {
        data: existing,
        error: lookupErr,
      } = await supabase
        .from('message_templates')
        .select('id')
        .eq(
          'account_id',
          accountId,
        )
        .eq(
          'whatsapp_config_id',
          whatsappConfigId,
        )
        .eq(
          'name',
          t.name,
        )
        .eq(
          'language',
          t.language,
        )
        .maybeSingle()

      if (lookupErr) {
        errors.push({
          name:
            t.name,
          language:
            t.language,
          message:
            lookupErr.message,
        })

        continue
      }

      if (existing?.id) {
        const {
          error: updErr,
        } = await supabase
          .from('message_templates')
          .update(row)
          .eq(
            'id',
            existing.id,
          )
          .eq(
            'account_id',
            accountId,
          )
          .eq(
            'whatsapp_config_id',
            whatsappConfigId,
          )

        if (updErr) {
          errors.push({
            name:
              t.name,
            language:
              t.language,
            message:
              updErr.message,
          })
        } else {
          updated++
        }
      } else {
        const {
          error: insErr,
        } = await supabase
          .from('message_templates')
          .insert(row)

        if (insErr) {
          errors.push({
            name:
              t.name,
            language:
              t.language,
            message:
              insErr.message,
          })
        } else {
          inserted++
        }
      }
    }

    return NextResponse.json({
      success:
        errors.length === 0,

      whatsapp_config_id:
        whatsappConfigId,

      display_name:
        config.display_name ??
        null,

      phone_number_id:
        config.phone_number_id,

      waba_id:
        config.waba_id,

      total:
        metaTemplates.length,

      inserted,

      updated,

      errors,

      truncated:
        pageCount >= PAGE_CAP &&
        nextUrl !== null,
    })
  } catch (error) {
    if (
      error instanceof
        UnauthorizedError ||
      error instanceof
        ForbiddenError
    ) {
      return toErrorResponse(
        error,
      )
    }

    console.error(
      'Error syncing WhatsApp templates:',
      error,
    )

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to sync templates',
      },
      {
        status: 500,
      },
    )
  }
}