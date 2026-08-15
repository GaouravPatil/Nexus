import { createClient } from '@supabase/supabase-js'

// Set these in nexus-frontend/.env (prefix with VITE_ so Vite exposes them)
//   VITE_SUPABASE_URL=https://xxxx.supabase.co
//   VITE_SUPABASE_ANON_KEY=eyJ...
const rawUrl  = import.meta.env.VITE_SUPABASE_URL  ?? ''
const rawAnon = import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''

export const isSupabaseConfigured = Boolean(rawUrl && rawAnon && rawUrl.startsWith('http'))

// Provide safe fallback values so createClient does not throw on app boot when env vars are missing
const supabaseUrl  = isSupabaseConfigured ? rawUrl  : 'https://placeholder.supabase.co'
const supabaseAnon = isSupabaseConfigured ? rawAnon : 'placeholder-anon-key'

export const supabase = createClient(supabaseUrl, supabaseAnon)
