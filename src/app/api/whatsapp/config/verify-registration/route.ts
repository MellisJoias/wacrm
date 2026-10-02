import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  getSubscribedApps,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'

/**
 * GET /api/whatsapp/config/verify-registration
 *
 * Query:
 *
 *   ?whatsapp_config_id=<uuid>
 *
 * Verifies the registration state of one specific WhatsApp
 * configuration belonging to the authenticated account.
 *
 * Three checks run independently:
 *
 *   1. phone_metadata_ok
 *   2. waba_subscribed_to_app
 *   3. locally_marked_registered
 *
 * Returns 200 in every diagnostic case so the UI can render
 * the individual checks instead of showing a generic error.
 */
export async function GET(request: Request) {
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

  // Resolve the caller's account.
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()

  const accountId =
    profile?.account_id as string | undefined

  if (!accountId) {
    return NextResponse.json({
      live: false,
      checks: {
        config_exists: false,
      },
      message:
        'Your profile is not linked to an account.',
    })
  }

  // The configuration must be explicitly selected when the
  // account has multiple WhatsApp numbers.
  const url = new URL(request.url)

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
      .eq('account_id', accountId)
      .order('created_at', {
        ascending: true,
      })

    if (configsError) {
      console.error(
        '[verify-registration] Error loading configs:',
        configsError,
      )

      return NextResponse.json({
        live: false,
        checks: {
          config_exists: false,
        },
        message:
          'Failed to load WhatsApp configurations.',
      })
    }

    if (!configs || configs.length === 0) {
      return NextResponse.json({
        live: false,
        checks: {
          config_exists: false,
        },
        message:
          'No WhatsApp configuration saved yet.',
      })
    }

    // Backwards compatibility for the old single-number UI.
    if (configs.length === 1) {
      whatsappConfigId =
        configs[0].id
    } else {
      return NextResponse.json({
        live: false,
        checks: {
          config_exists: true,
        },
        requires_config_selection: true,
        message:
          'whatsapp_config_id is required when this account has multiple WhatsApp configurations.',
      })
    }
  }

  // Never allow a configuration belonging to another account.
  const {
    data: config,
    error: configError,
  } = await supabase
    .from('whatsapp_config')
    .select('*')
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
      '[verify-registration] Error loading config:',
      configError,
    )

    return NextResponse.json({
      live: false,
      checks: {
        config_exists: false,
      },
      message:
        'Failed to load WhatsApp configuration.',
    })
  }

  if (!config) {
    return NextResponse.json({
      live: false,
      checks: {
        config_exists: false,
      },
      whatsapp_config_id:
        whatsappConfigId,
      message:
        'WhatsApp configuration not found for this account.',
    })
  }

  let accessToken: string

  try {
    accessToken =
      decrypt(
        config.access_token,
      )
  } catch {
    return NextResponse.json({
      live: false,
      whatsapp_config_id:
        config.id,
      display_name:
        config.display_name ?? null,
      checks: {
        config_exists: true,
        token_decryptable: false,
      },
      message:
        'Stored access token can\'t be decrypted — likely ENCRYPTION_KEY changed. Re-enter the token to repair.',
    })
  }

  const checks: {
    config_exists: boolean
    token_decryptable: boolean
    phone_metadata_ok: boolean
    waba_subscribed_to_app: boolean | null
    locally_marked_registered: boolean
  } = {
    config_exists: true,
    token_decryptable: true,
    phone_metadata_ok: false,
    waba_subscribed_to_app: null,
    locally_marked_registered:
      config.registered_at != null,
  }

  const errors: string[] = []

  // ----------------------------------------------------------
  // 1. Phone metadata
  // ----------------------------------------------------------

  try {
    await verifyPhoneNumber({
      phoneNumberId:
        config.phone_number_id,
      accessToken,
    })

    checks.phone_metadata_ok =
      true
  } catch (err) {
    errors.push(
      `Phone metadata check failed: ${
        err instanceof Error
          ? err.message
          : String(err)
      }`,
    )
  }

  // ----------------------------------------------------------
  // 2. WABA subscription
  // ----------------------------------------------------------

  if (config.waba_id) {
    try {
      const subs =
        await getSubscribedApps({
          wabaId:
            config.waba_id,
          accessToken,
        })

      checks.waba_subscribed_to_app =
        subs.length > 0

      if (
        !checks.waba_subscribed_to_app
      ) {
        errors.push(
          'WABA has no subscribed apps. Re-save the configuration to subscribe.',
        )
      }
    } catch (err) {
      errors.push(
        `WABA subscription check failed: ${
          err instanceof Error
            ? err.message
            : String(err)
        }`,
      )
    }
  } else {
    errors.push(
      'No WABA ID on file — webhooks can\'t be wired without it. Add it in the form and re-save.',
    )
  }

  // ----------------------------------------------------------
  // 3. Overall status
  // ----------------------------------------------------------

  const live =
    checks.phone_metadata_ok &&
    (
      checks.waba_subscribed_to_app ??
      false
    ) &&
    checks.locally_marked_registered

  return NextResponse.json({
    live,

    whatsapp_config_id:
      config.id,

    display_name:
      config.display_name ??
      null,

    business_portfolio_id:
      config.business_portfolio_id ??
      null,

    phone_number_id:
      config.phone_number_id,

    waba_id:
      config.waba_id ??
      null,

    checks,

    errors,

    last_registration_error:
      config.last_registration_error ??
      null,

    registered_at:
      config.registered_at ??
      null,

    subscribed_apps_at:
      config.subscribed_apps_at ??
      null,
  })
}