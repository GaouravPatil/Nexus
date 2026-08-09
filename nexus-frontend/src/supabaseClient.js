import { createClient } from '@supabase/supabase-js'

// Set these in nexus-frontend/.env (prefix with VITE_ so Vite exposes them)
//   VITE_SUPABASE_URL=https://xxxx.supabase.co
//   VITE_SUPABASE_ANON_KEY=eyJ...
const supabaseUrl  = import.meta.env.VITE_SUPABASE_URL  ?? ''
const supabaseAnon = import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''

export const supabase = createClient(supabaseUrl, supabaseAnon)
