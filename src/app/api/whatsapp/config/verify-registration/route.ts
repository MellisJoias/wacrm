import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  getSubscribedApps,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
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

    const { searchParams } = new URL(request.url)

    const whatsappConfigId =
      searchParams.get('whatsapp_config_id') ||
      searchParams.get('id')

    if (!whatsappConfigId) {
      return NextResponse.json(
        { error: 'whatsapp_config_id is required' },
        { status: 400 },
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select(
        [
          'id',
          'user_id',
          'phone_number_id',
          'waba_id',
          'access_token',
          'registered_at',
          'subscribed_apps_at',
          'last_registration_error',
          'status',
          'connected_at',
        ].join(','),
      )
      .eq('id', whatsappConfigId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (configError) {
      console.error(
        'Failed to load WhatsApp config:',
        configError,
      )

      return NextResponse.json(
        {
          error: 'Failed to load WhatsApp configuration',
          details: configError.message,
        },
        { status: 500 },
      )
    }

    if (!config) {
      return NextResponse.json(
        { error: 'WhatsApp configuration not found' },
        { status: 404 },
      )
    }

    if (!config.phone_number_id) {
      return NextResponse.json(
        {
          error: 'WhatsApp configuration has no phone_number_id',
        },
        { status: 400 },
      )
    }

    if (!config.access_token) {
      return NextResponse.json(
        {
          error: 'WhatsApp configuration has no access token',
        },
        { status: 400 },
      )
    }

    let accessToken: string

    try {
      accessToken = decrypt(config.access_token)
    } catch (error) {
      console.error(
        'Failed to decrypt WhatsApp access token:',
        error,
      )

      return NextResponse.json(
        {
          error: 'Failed to decrypt access token',
        },
        { status: 500 },
      )
    }

    const errors: string[] = []

    /*
     * CHECK 1
     *
     * Confirma que o Phone Number ID ainda pode ser consultado
     * pelo token salvo nessa configuração.
     */
    let phoneMetadataOk = false

    try {
      await verifyPhoneNumber({
        phoneNumberId: config.phone_number_id,
        accessToken,
      })

      phoneMetadataOk = true
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown Meta API error'

      console.error(
        'WhatsApp phone metadata verification failed:',
        message,
      )

      errors.push(`phone_metadata_ok: ${message}`)
    }

    /*
     * CHECK 2
     *
     * Verifica se existe aplicativo inscrito no WABA.
     *
     * Esta checagem não será usada como bloqueio do registro
     * local porque o /register do telefone já foi executado
     * manualmente e retornou success: true.
     */
    let wabaSubscribedToApp: boolean | null = null

    if (config.waba_id) {
      try {
        const subscribedApps = await getSubscribedApps({
          wabaId: config.waba_id,
          accessToken,
        })

        wabaSubscribedToApp = subscribedApps.length > 0

        if (!wabaSubscribedToApp) {
          errors.push(
            'waba_subscribed_to_app: no subscribed apps returned by Meta',
          )
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Unknown Meta API error'

        console.error(
          'WhatsApp WABA subscription verification failed:',
          message,
        )

        wabaSubscribedToApp = false
        errors.push(`waba_subscribed_to_app: ${message}`)
      }
    } else {
      wabaSubscribedToApp = null
      errors.push('waba_subscribed_to_app: WABA ID is missing')
    }

    /*
     * REGISTRO LOCAL
     *
     * O número 0981 já foi registrado manualmente pelo Graph API
     * e o Meta retornou:
     *
     * {"success": true}
     *
     * Portanto, se o Phone Number ID continua acessível pelo
     * token, sincronizamos registered_at no WACRM.
     *
     * Não executamos /register novamente.
     * Não exigimos PIN novamente.
     * Não usamos o erro antigo de permission/owner business
     * para bloquear essa sincronização.
     */
    const now = new Date().toISOString()

    let registrationSynced = false
    let registeredAt = config.registered_at

    if (phoneMetadataOk && !config.registered_at) {
      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update({
          registered_at: now,
          last_registration_error: null,
          status: 'connected',
          connected_at: config.connected_at ?? now,
        })
        .eq('id', config.id)
        .eq('user_id', user.id)

      if (updateError) {
        console.error(
          'Failed to synchronize local WhatsApp registration:',
          updateError,
        )

        errors.push(
          `local_registration_sync: ${updateError.message}`,
        )
      } else {
        registeredAt = now
        registrationSynced = true
      }
    }

    /*
     * Se já estava marcado como registrado localmente,
     * mantemos o registro existente.
     */
    const locallyMarkedRegistered =
      registeredAt != null

    /*
     * LIVE significa que:
     *
     * 1. o Phone Number ID é acessível pelo token
     * 2. o WACRM possui registered_at
     *
     * A inscrição do WABA é exibida separadamente e não bloqueia
     * a sincronização local.
     */
    const live =
      phoneMetadataOk &&
      locallyMarkedRegistered

    return NextResponse.json({
      live,

      checks: {
        phone_metadata_ok: phoneMetadataOk,
        waba_subscribed_to_app: wabaSubscribedToApp,
        locally_marked_registered: locallyMarkedRegistered,
      },

      errors,

      last_registration_error:
        registrationSynced
          ? null
          : config.last_registration_error ?? null,

      registered_at: registeredAt,

      subscribed_apps_at:
        config.subscribed_apps_at ?? null,

      registration_synced: registrationSynced,
    })
  } catch (error) {
    console.error(
      'Unexpected WhatsApp registration verification error:',
      error,
    )

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Unexpected error',
      },
      { status: 500 },
    )
  }
}