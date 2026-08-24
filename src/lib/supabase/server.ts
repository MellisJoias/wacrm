import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'

/**
 * Cliente Supabase vinculado à sessão do usuário.
 *
 * Deve ser usado para operações que precisam respeitar:
 * - autenticação
 * - sessão
 * - RLS
 */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },

        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(
              ({ name, value, options }) =>
                cookieStore.set(
                  name,
                  value,
                  options
                )
            )
          } catch {
            // setAll pode ser chamado a partir de um
            // Server Component. Nesse caso, o middleware
            // pode ser responsável pela atualização da sessão.
          }
        },
      },
    }
  )
}

/**
 * Cliente Supabase privilegiado para processamento interno
 * exclusivamente no servidor.
 *
 * IMPORTANTE:
 * - Nunca expor este cliente ao navegador.
 * - Nunca usar a SERVICE_ROLE_KEY em código client-side.
 * - Operações feitas com este cliente bypassam RLS.
 *
 * É utilizado por processos internos confiáveis, como:
 * - fan-out de Broadcast
 * - persistência de mensagens enviadas pela Meta
 * - atualização de conversations
 * - processamento de webhooks
 */
export function createServiceRoleClient() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL

  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL is not configured'
    )
  }

  if (!serviceRoleKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not configured'
    )
  }

  return createSupabaseClient(
    supabaseUrl,
    serviceRoleKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  )
}