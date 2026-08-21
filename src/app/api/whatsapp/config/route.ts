import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  subscribeWabaToApp,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'

/**
 * Resolve the caller's account_id from their profile.
 */
async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()

  if (error || !data?.account_id) {
    return null
  }

  return data.account_id as string
}

// Lazy-initialised service-role client.
// Used only to detect whether another account already owns
// the same WhatsApp phone_number_id.
let _adminClient: any = null

function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }

  return _adminClient
}

/**
 * GET /api/whatsapp/config
 *
 * Checks whether the saved WhatsApp credentials are valid.
 */
export async function GET() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const accountId = await resolveAccountId(
      supabase,
      user.id
    )

    if (!accountId) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_account',
          message:
            'Your profile is not linked to an account.',
        },
        { status: 200 }
      )
    }

    const { data: config, error: configError } =
      await supabase
        .from('whatsapp_config')
        .select(
          'phone_number_id, access_token, status, waba_id, subscribed_apps_at'
        )
        .eq('account_id', accountId)
        .maybeSingle()

    if (configError) {
      console.error(
        'Error fetching whatsapp_config:',
        configError
      )

      return NextResponse.json(
        {
          connected: false,
          reason: 'db_error',
          message:
            'Failed to fetch WhatsApp configuration.',
        },
        { status: 200 }
      )
    }

    if (!config) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_config',
          message:
            'No WhatsApp configuration saved yet.',
        },
        { status: 200 }
      )
    }

    // Decrypt stored access token.
    let accessToken: string

    try {
      accessToken = decrypt(config.access_token)
    } catch (err) {
      console.error(
        '[whatsapp/config GET] Token decryption failed:',
        err
      )

      return NextResponse.json(
        {
          connected: false,
          reason: 'token_corrupted',
          needs_reset: true,
          message:
            'The stored access token cannot be decrypted with the current ENCRYPTION_KEY. Reset the configuration and save it again.',
        },
        { status: 200 }
      )
    }

    // Validate credentials directly against Meta.
    try {
      const phoneInfo = await verifyPhoneNumber({
        phoneNumberId: config.phone_number_id,
        accessToken,
      })

      return NextResponse.json({
        connected: true,
        phone_info: phoneInfo,
        status: config.status,
        waba_id: config.waba_id,
        subscribed_apps_at:
          config.subscribed_apps_at,
      })
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Unknown Meta API error'

      console.error(
        '[whatsapp/config GET] Meta API verification failed:',
        message
      )

      return NextResponse.json(
        {
          connected: false,
          reason: 'meta_api_error',
          message:
            `Meta API rejected the credentials: ${message}`,
        },
        { status: 200 }
      )
    }
  } catch (error) {
    console.error(
      'Error in WhatsApp config GET:',
      error
    )

    return NextResponse.json(
      {
        connected: false,
        reason: 'unknown',
        message: 'Internal server error',
      },
      { status: 500 }
    )
  }
}

/**
 * POST /api/whatsapp/config
 *
 * Saves or updates the WhatsApp Cloud API configuration.
 *
 * IMPORTANT:
 * This flow DOES NOT use the 2-step verification PIN.
 *
 * The WACRM:
 * 1. validates the Phone Number ID + access token with Meta;
 * 2. encrypts the credentials;
 * 3. subscribes the WABA to the application when waba_id exists;
 * 4. saves the configuration in Supabase.
 *
 * There is NO /register call here.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const accountId = await resolveAccountId(
      supabase,
      user.id
    )

    if (!accountId) {
      return NextResponse.json(
        {
          error:
            'Your profile is not linked to an account.',
        },
        { status: 403 }
      )
    }

    const body = await request.json()

    const {
      phone_number_id,
      waba_id,
      access_token,
      verify_token,
    } = body

    // PIN deliberately does not exist in this flow.
    //
    // Even if the frontend sends "pin", it is ignored.
    //
    // This prevents the WACRM from requiring the 2-step
    // verification PIN to save the WhatsApp configuration.

    if (!access_token || !phone_number_id) {
      return NextResponse.json(
        {
          error:
            'access_token and phone_number_id are required',
        },
        { status: 400 }
      )
    }

    // ============================================================
    // Check whether this phone number belongs to another account.
    // ============================================================

    const { data: claimed, error: claimedError } =
      await supabaseAdmin()
        .from('whatsapp_config')
        .select('account_id')
        .eq('phone_number_id', phone_number_id)
        .neq('account_id', accountId)
        .maybeSingle()

    if (claimedError) {
      console.error(
        'Error checking phone_number_id ownership:',
        claimedError
      )

      return NextResponse.json(
        {
          error:
            'Failed to validate WhatsApp configuration',
        },
        { status: 500 }
      )
    }

    if (claimed) {
      return NextResponse.json(
        {
          error:
            'This WhatsApp phone number is already linked to another account on this instance.',
        },
        { status: 409 }
      )
    }

    // ============================================================
    // Verify credentials with Meta.
    // ============================================================

    let phoneInfo

    try {
      phoneInfo = await verifyPhoneNumber({
        phoneNumberId: phone_number_id,
        accessToken: access_token,
      })
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Unknown Meta API error'

      console.error(
        'Meta API verification failed during save:',
        message
      )

      return NextResponse.json(
        {
          error:
            `Meta API error: ${message}`,
        },
        { status: 400 }
      )
    }

    // ============================================================
    // Encrypt sensitive tokens.
    // ============================================================

    let encryptedAccessToken: string
    let encryptedVerifyToken: string | null

    try {
      encryptedAccessToken = encrypt(access_token)

      encryptedVerifyToken = verify_token
        ? encrypt(verify_token)
        : null
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Unknown encryption error'

      console.error(
        'Encryption failed:',
        message
      )

      return NextResponse.json(
        {
          error:
            'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
        },
        { status: 500 }
      )
    }

    // ============================================================
    // Find existing configuration.
    // ============================================================

    const { data: existing, error: existingError } =
      await supabase
        .from('whatsapp_config')
        .select(
          'id, registered_at, phone_number_id'
        )
        .eq('account_id', accountId)
        .maybeSingle()

    if (existingError) {
      console.error(
        'Error fetching existing WhatsApp configuration:',
        existingError
      )

      return NextResponse.json(
        {
          error:
            'Failed to fetch existing WhatsApp configuration',
        },
        { status: 500 }
      )
    }

    // ============================================================
    // IMPORTANT:
    //
    // NO /register
    // NO PIN
    // NO 2-step verification requirement
    //
    // The number is already an official WhatsApp Cloud API
    // number managed by Meta.
    // ============================================================

    let subscribedAppsAt: string | null = null

    // ============================================================
    // Subscribe the WABA to this application.
    //
    // This is idempotent on Meta's side.
    // ============================================================

    if (waba_id) {
      try {
        await subscribeWabaToApp({
          wabaId: waba_id,
          accessToken: access_token,
        })

        subscribedAppsAt =
          new Date().toISOString()

      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : String(err)

        console.warn(
          'WABA subscribed_apps failed:',
          message
        )

        // We do not block saving the credentials if the
        // WABA subscription fails. The credentials themselves
        // were already successfully validated by Meta.
      }
    }

    // ============================================================
    // Prepare database row.
    // ============================================================

    const baseRow = {
      phone_number_id,

      waba_id:
        waba_id || null,

      access_token:
        encryptedAccessToken,

      verify_token:
        encryptedVerifyToken,

      // Credentials were successfully verified by Meta.
      status: 'connected',

      connected_at:
        new Date().toISOString(),

      // We intentionally do NOT call /register.
      //
      // Therefore we do not falsely claim that the WACRM
      // performed a phone registration.
      registered_at:
        existing?.registered_at ?? null,

      subscribed_apps_at:
        subscribedAppsAt ??
        null,

      last_registration_error:
        null,

      updated_at:
        new Date().toISOString(),
    }

    // ============================================================
    // Update existing configuration.
    // ============================================================

    if (existing) {
      const { error: updateError } =
        await supabase
          .from('whatsapp_config')
          .update(baseRow)
          .eq('account_id', accountId)

      if (updateError) {
        console.error(
          'Error updating whatsapp_config:',
          updateError
        )

        return NextResponse.json(
          {
            error:
              'Failed to update WhatsApp configuration',
          },
          { status: 500 }
        )
      }
    } else {
      // ==========================================================
      // Insert new configuration.
      // ==========================================================

      const { error: insertError } =
        await supabase
          .from('whatsapp_config')
          .insert({
            account_id: accountId,
            user_id: user.id,
            ...baseRow,
          })

      if (insertError) {
        console.error(
          'Error inserting whatsapp_config:',
          insertError
        )

        return NextResponse.json(
          {
            error:
              'Failed to save WhatsApp configuration',
          },
          { status: 500 }
        )
      }
    }

    // ============================================================
    // Success.
    //
    // There is intentionally no PIN/registration error here.
    // ============================================================

    return NextResponse.json({
      success: true,
      saved: true,

      // Credentials successfully verified with Meta.
      connected: true,

      // The WACRM deliberately does not perform /register.
      registration_skipped: true,

      // Kept for compatibility with the existing frontend.
      registered:
        existing?.registered_at != null,

      phone_info: phoneInfo,

      waba_subscribed:
        subscribedAppsAt != null,

      subscribed_apps_at:
        subscribedAppsAt,
    })
  } catch (error) {
    console.error(
      'Error in WhatsApp config POST:',
      error
    )

    return NextResponse.json(
      {
        error: 'Internal server error',
      },
      { status: 500 }
    )
  }
}

/**
 * DELETE /api/whatsapp/config
 *
 * Removes the WhatsApp configuration for the current account.
 */
export async function DELETE() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const accountId = await resolveAccountId(
      supabase,
      user.id
    )

    if (!accountId) {
      return NextResponse.json(
        {
          error:
            'Your profile is not linked to an account.',
        },
        { status: 403 }
      )
    }

    const { error: deleteError } =
      await supabase
        .from('whatsapp_config')
        .delete()
        .eq('account_id', accountId)

    if (deleteError) {
      console.error(
        'Error deleting whatsapp_config:',
        deleteError
      )

      return NextResponse.json(
        {
          error:
            'Failed to delete configuration',
        },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
    })
  } catch (error) {
    console.error(
      'Error in WhatsApp config DELETE:',
      error
    )

    return NextResponse.json(
      {
        error: 'Internal server error',
      },
      { status: 500 }
    )
  }
}