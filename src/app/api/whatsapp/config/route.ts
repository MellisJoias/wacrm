import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  createClient as createAdminClient,
  type SupabaseClient,
} from '@supabase/supabase-js'
import {
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'
import {
  encrypt,
  decrypt,
} from '@/lib/whatsapp/encryption'

type WhatsAppConfig = {
  id: string
  business_portfolio_id: string | null
  display_name: string | null
  phone_number_id: string
  waba_id: string | null
  access_token: string
  status: string | null
}

type ExistingConfig = {
  id: string
  registered_at: string | null
  phone_number_id: string
  waba_id: string | null
}

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
let _adminClient: SupabaseClient | null = null

function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }

  return _adminClient
}

/**
 * GET /api/whatsapp/config
 *
 * Query:
 *
 *   ?whatsapp_config_id=<uuid>
 *
 * When no config id is supplied:
 *   - returns the only config when the account has one
 *   - returns all configs when the account has multiple
 *   - returns no_config when there are none
 *
 * When a config id is supplied, only that configuration is returned.
 */
export async function GET(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        {
          error: 'Unauthorized',
        },
        {
          status: 401,
        },
      )
    }

    const accountId = await resolveAccountId(
      supabase,
      user.id,
    )

    if (!accountId) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_account',
          message:
            'Your profile is not linked to an account.',
        },
        {
          status: 200,
        },
      )
    }

    const url = new URL(request.url)

    const requestedConfigId =
      url.searchParams.get(
        'whatsapp_config_id',
      )

    /*
     * Specific WhatsApp configuration
     */
    if (requestedConfigId) {
      const {
        data: config,
        error: configError,
      } = await supabase
        .from('whatsapp_config')
        .select(
          'id, business_portfolio_id, display_name, phone_number_id, waba_id, access_token, status',
        )
        .eq(
          'id',
          requestedConfigId,
        )
        .eq(
          'account_id',
          accountId,
        )
        .maybeSingle()

      if (configError) {
        console.error(
          'Error fetching whatsapp_config:',
          configError,
        )

        return NextResponse.json(
          {
            connected: false,
            reason: 'db_error',
            message:
              'Failed to fetch configuration',
          },
          {
            status: 200,
          },
        )
      }

      if (!config) {
        return NextResponse.json(
          {
            connected: false,
            reason: 'no_config',
            message:
              'WhatsApp configuration not found.',
          },
          {
            status: 200,
          },
        )
      }

      return verifyConfig(
        config as WhatsAppConfig,
      )
    }

    /*
     * All WhatsApp configurations
     */
    const {
      data: configs,
      error: configsError,
    } = await supabase
      .from('whatsapp_config')
      .select(
        'id, business_portfolio_id, display_name, phone_number_id, waba_id, access_token, status',
      )
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
        'Error fetching whatsapp_config:',
        configsError,
      )

      return NextResponse.json(
        {
          connected: false,
          reason: 'db_error',
          message:
            'Failed to fetch configuration',
        },
        {
          status: 200,
        },
      )
    }

    if (!configs || configs.length === 0) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_config',
          message:
            'No WhatsApp configuration saved yet. Fill in the form and click Save Configuration.',
          configs: [],
        },
        {
          status: 200,
        },
      )
    }

    /*
     * Preserve the old single-config response.
     */
    if (configs.length === 1) {
      return verifyConfig(
        configs[0] as WhatsAppConfig,
      )
    }

    /*
     * Multiple WhatsApp numbers.
     */
    return NextResponse.json({
      connected: true,
      multiple_configs: true,
      configs: configs.map(
        (config) => ({
          id: config.id,
          business_portfolio_id:
            config.business_portfolio_id,
          display_name:
            config.display_name,
          phone_number_id:
            config.phone_number_id,
          waba_id:
            config.waba_id,
          status:
            config.status,
        }),
      ),
    })
  } catch (error) {
    console.error(
      'Error in WhatsApp config GET:',
      error,
    )

    return NextResponse.json(
      {
        connected: false,
        reason: 'unknown',
        message:
          'Internal server error',
      },
      {
        status: 500,
      },
    )
  }
}

/**
 * Verify one stored WhatsApp configuration against Meta.
 */
async function verifyConfig(
  config: WhatsAppConfig,
) {
  let accessToken: string

  try {
    accessToken = decrypt(
      config.access_token,
    )
  } catch (err) {
    console.error(
      '[whatsapp/config GET] Token decryption failed:',
      err,
    )

    return NextResponse.json(
      {
        connected: false,
        reason: 'token_corrupted',
        needs_reset: true,
        whatsapp_config_id:
          config.id,
        message:
          'The stored access token cannot be decrypted with the current ENCRYPTION_KEY. This usually means the key changed, or it differs between environments. Reset and re-save this WhatsApp configuration.',
      },
      {
        status: 200,
      },
    )
  }

  try {
    const phoneInfo =
      await verifyPhoneNumber({
        phoneNumberId:
          config.phone_number_id,
        accessToken,
      })

    return NextResponse.json({
      connected: true,
      whatsapp_config_id:
        config.id,
      display_name:
        config.display_name,
      business_portfolio_id:
        config.business_portfolio_id,
      phone_info:
        phoneInfo,
    })
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Unknown Meta API error'

    console.error(
      '[whatsapp/config GET] Meta API verification failed:',
      message,
    )

    return NextResponse.json(
      {
        connected: false,
        reason: 'meta_api_error',
        whatsapp_config_id:
          config.id,
        message:
          `Meta API rejected the credentials: ${message}`,
      },
      {
        status: 200,
      },
    )
  }
}

/**
 * POST /api/whatsapp/config
 *
 * Creates or updates a WhatsApp configuration.
 *
 * create_new === true
 *   -> always creates a new configuration.
 *
 * whatsapp_config_id
 *   -> updates that specific configuration.
 *
 * No id
 *   -> updates the only configuration when exactly one exists.
 *   -> creates when none exists.
 *   -> refuses when multiple configurations already exist.
 */
export async function POST(
  request: Request,
) {
  try {
    const supabase =
      await createClient()

    const {
      data: { user },
      error: authError,
    } =
      await supabase.auth.getUser()

    if (
      authError ||
      !user
    ) {
      return NextResponse.json(
        {
          error:
            'Unauthorized',
        },
        {
          status: 401,
        },
      )
    }

    const accountId =
      await resolveAccountId(
        supabase,
        user.id,
      )

    if (!accountId) {
      return NextResponse.json(
        {
          error:
            'Your profile is not linked to an account.',
        },
        {
          status: 403,
        },
      )
    }

    const body =
      await request.json()

    const {
      whatsapp_config_id,
      create_new,
      business_portfolio_id,
      display_name,
      phone_number_id,
      waba_id,
      access_token,
      verify_token,
      pin,
    } = body

    if (
      !access_token ||
      !phone_number_id
    ) {
      return NextResponse.json(
        {
          error:
            'access_token and phone_number_id are required',
        },
        {
          status: 400,
        },
      )
    }

    if (
      pin !== undefined &&
      pin !== null &&
      pin !== ''
    ) {
      if (
        typeof pin !== 'string' ||
        !/^\d{6}$/.test(pin)
      ) {
        return NextResponse.json(
          {
            error:
              'PIN must be exactly 6 digits.',
          },
          {
            status: 400,
          },
        )
      }
    }

    /*
     * Resolve target configuration.
     */
    let existing:
      ExistingConfig | null =
      null

    /*
     * Explicitly creating a new configuration.
     *
     * This is the important part for multiple WhatsApp numbers:
     * existing remains null, so the code below performs INSERT.
     */
    if (create_new === true) {
      existing = null
    } else if (
      typeof whatsapp_config_id ===
        'string' &&
      whatsapp_config_id.trim()
    ) {
      const {
        data,
        error,
      } = await supabase
        .from('whatsapp_config')
        .select(
          'id, registered_at, phone_number_id, waba_id',
        )
        .eq(
          'id',
          whatsapp_config_id.trim(),
        )
        .eq(
          'account_id',
          accountId,
        )
        .maybeSingle()

      if (error) {
        console.error(
          'Error loading WhatsApp configuration:',
          error,
        )

        return NextResponse.json(
          {
            error:
              'Failed to load configuration',
          },
          {
            status: 500,
          },
        )
      }

      if (!data) {
        return NextResponse.json(
          {
            error:
              'WhatsApp configuration not found for this account',
          },
          {
            status: 404,
          },
        )
      }

      existing =
        data as ExistingConfig
    } else {
      const {
        data: configs,
        error,
      } = await supabase
        .from('whatsapp_config')
        .select(
          'id, registered_at, phone_number_id, waba_id',
        )
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

      if (error) {
        console.error(
          'Error loading WhatsApp configurations:',
          error,
        )

        return NextResponse.json(
          {
            error:
              'Failed to load configuration',
          },
          {
            status: 500,
          },
        )
      }

      if (
        configs &&
        configs.length === 1
      ) {
        existing =
          configs[0] as ExistingConfig
      } else if (
        configs &&
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
    }

    /*
     * Prevent the same phone number from belonging
     * to another account.
     */
    const {
      data: claimed,
      error: claimedError,
    } =
      await supabaseAdmin()
        .from('whatsapp_config')
        .select(
          'id, account_id',
        )
        .eq(
          'phone_number_id',
          phone_number_id,
        )
        .neq(
          'account_id',
          accountId,
        )
        .maybeSingle()

    if (claimedError) {
      console.error(
        'Error checking phone_number_id ownership:',
        claimedError,
      )

      return NextResponse.json(
        {
          error:
            'Failed to validate configuration',
        },
        {
          status: 500,
        },
      )
    }

    if (claimed) {
      return NextResponse.json(
        {
          error:
            'This WhatsApp phone number is already linked to another account on this instance.',
        },
        {
          status: 409,
        },
      )
    }

    /*
     * Verify credentials with Meta.
     */
    let phoneInfo

    try {
      phoneInfo =
        await verifyPhoneNumber({
          phoneNumberId:
            phone_number_id,
          accessToken:
            access_token,
        })
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Unknown Meta API error'

      console.error(
        'Meta API verification failed during save:',
        message,
      )

      return NextResponse.json(
        {
          error:
            `Meta API error: ${message}`,
        },
        {
          status: 400,
        },
      )
    }

    /*
     * Encrypt credentials.
     */
    let encryptedAccessToken: string

    let encryptedVerifyToken:
      | string
      | null

    try {
      encryptedAccessToken =
        encrypt(
          access_token,
        )

      encryptedVerifyToken =
        verify_token
          ? encrypt(
              verify_token,
            )
          : null
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Unknown encryption error'

      console.error(
        'Encryption failed:',
        message,
      )

      return NextResponse.json(
        {
          error:
            'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
        },
        {
          status: 500,
        },
      )
    }

    /*
     * Registration.
     */
    const sameNumber =
      existing?.phone_number_id ===
        phone_number_id &&
      existing?.registered_at !=
        null

    let registeredAt:
      | string
      | null =
      existing?.registered_at ??
      null

    let registrationError:
      | string
      | null =
      null

    let registrationSkipped =
      false

    const needsRegistration =
      !sameNumber ||
      (
        typeof pin ===
          'string' &&
        pin.length > 0
      )

    if (
      needsRegistration
    ) {
      if (!pin) {
        registrationSkipped =
          true
      } else {
        try {
          await registerPhoneNumber({
            phoneNumberId:
              phone_number_id,
            accessToken:
              access_token,
            pin,
          })

          registeredAt =
            new Date().toISOString()
        } catch (err) {
          registrationError =
            err instanceof Error
              ? err.message
              : 'Unknown Meta API error'

          console.error(
            'Phone number /register failed:',
            registrationError,
          )
        }
      }
    }

    /*
     * Subscribe WABA to app.
     */
    let subscribedAppsAt:
      | string
      | null =
      null

    if (waba_id) {
      try {
        await subscribeWabaToApp({
          wabaId:
            waba_id,
          accessToken:
            access_token,
        })

        subscribedAppsAt =
          new Date().toISOString()
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : String(err)

        console.warn(
          'WABA subscribed_apps failed (non-fatal):',
          message,
        )
      }
    }

    /*
     * Data persisted in whatsapp_config.
     */
    const baseRow = {
      business_portfolio_id:
        business_portfolio_id ||
        null,

      display_name:
        typeof display_name ===
          'string' &&
        display_name.trim()
          ? display_name.trim()
          : null,

      phone_number_id,

      waba_id:
        waba_id ||
        null,

      access_token:
        encryptedAccessToken,

      verify_token:
        encryptedVerifyToken,

      status:
        registrationError
          ? 'disconnected'
          : 'connected',

      connected_at:
        registrationError
          ? null
          : new Date().toISOString(),

      registered_at:
        registrationError
          ? null
          : registeredAt,

      subscribed_apps_at:
        subscribedAppsAt ??
        null,

      last_registration_error:
        registrationError,

      updated_at:
        new Date().toISOString(),
    }

    let savedConfigId:
      | string
      | null =
      existing?.id ??
      null

    /*
     * Existing configuration -> UPDATE.
     */
    if (existing) {
      const {
        error: updateError,
      } = await supabase
        .from('whatsapp_config')
        .update(
          baseRow,
        )
        .eq(
          'id',
          existing.id,
        )
        .eq(
          'account_id',
          accountId,
        )

      if (updateError) {
        console.error(
          'Error updating whatsapp_config:',
          updateError,
        )

        return NextResponse.json(
          {
            error:
              'Failed to update configuration',
          },
          {
            status: 500,
          },
        )
      }
    } else {
      /*
       * New configuration -> INSERT.
       */
      const {
        data: inserted,
        error: insertError,
      } = await supabase
        .from('whatsapp_config')
        .insert({
          account_id:
            accountId,

          user_id:
            user.id,

          ...baseRow,
        })
        .select('id')
        .single()

      if (insertError) {
        console.error(
          'Error inserting whatsapp_config:',
          insertError,
        )

        return NextResponse.json(
          {
            error:
              'Failed to save configuration',
          },
          {
            status: 500,
          },
        )
      }

      savedConfigId =
        inserted.id
    }

    /*
     * Response.
     */
    if (
      registrationError
    ) {
      return NextResponse.json({
        success: false,
        saved: true,
        registered: false,
        whatsapp_config_id:
          savedConfigId,
        registration_error:
          registrationError,
        phone_info:
          phoneInfo,
      })
    }

    return NextResponse.json({
      success: true,
      saved: true,
      whatsapp_config_id:
        savedConfigId,
      registered:
        registeredAt !=
        null,
      registration_skipped:
        registrationSkipped,
      phone_info:
        phoneInfo,
    })
  } catch (error) {
    console.error(
      'Error in WhatsApp config POST:',
      error,
    )

    return NextResponse.json(
      {
        error:
          'Internal server error',
      },
      {
        status: 500,
      },
    )
  }
}

/**
 * DELETE /api/whatsapp/config
 *
 * Query:
 *
 *   ?whatsapp_config_id=<uuid>
 *
 * When the account has exactly one configuration,
 * the id is optional for backwards compatibility.
 */
export async function DELETE(
  request: Request,
) {
  try {
    const supabase =
      await createClient()

    const {
      data: { user },
      error: authError,
    } =
      await supabase.auth.getUser()

    if (
      authError ||
      !user
    ) {
      return NextResponse.json(
        {
          error:
            'Unauthorized',
        },
        {
          status: 401,
        },
      )
    }

    const accountId =
      await resolveAccountId(
        supabase,
        user.id,
      )

    if (!accountId) {
      return NextResponse.json(
        {
          error:
            'Your profile is not linked to an account.',
        },
        {
          status: 403,
        },
      )
    }

    const url =
      new URL(request.url)

    let configId =
      url.searchParams.get(
        'whatsapp_config_id',
      )

    /*
     * Backwards compatibility when there is exactly one config.
     */
    if (!configId) {
      const {
        data: configs,
        error,
      } = await supabase
        .from('whatsapp_config')
        .select('id')
        .eq(
          'account_id',
          accountId,
        )

      if (error) {
        console.error(
          'Error loading whatsapp configs:',
          error,
        )

        return NextResponse.json(
          {
            error:
              'Failed to load configuration',
          },
          {
            status: 500,
          },
        )
      }

      if (
        configs.length === 0
      ) {
        return NextResponse.json(
          {
            error:
              'No WhatsApp configuration found',
          },
          {
            status: 404,
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

      configId =
        configs[0].id
    }

    const {
      error: deleteError,
    } = await supabase
      .from('whatsapp_config')
      .delete()
      .eq(
        'id',
        configId,
      )
      .eq(
        'account_id',
        accountId,
      )

    if (deleteError) {
      console.error(
        'Error deleting whatsapp_config:',
        deleteError,
      )

      return NextResponse.json(
        {
          error:
            'Failed to delete configuration',
        },
        {
          status: 500,
        },
      )
    }

    return NextResponse.json({
      success: true,
      whatsapp_config_id:
        configId,
    })
  } catch (error) {
    console.error(
      'Error in WhatsApp config DELETE:',
      error,
    )

    return NextResponse.json(
      {
        error:
          'Internal server error',
      },
      {
        status: 500,
      },
    )
  }
}