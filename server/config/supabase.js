const path = require('path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  console.warn('[Supabase] Warning: SUPABASE_URL is not defined in the environment.');
}

const clientOptions = {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  },
  realtime: {
    transport: WebSocket
  }
};

// Client with anon key (subject to RLS policies)
const supabase = (supabaseUrl && supabaseAnonKey)
  ? createClient(supabaseUrl, supabaseAnonKey, clientOptions)
  : null;

// Admin client with service_role key (bypasses RLS - STRICTLY BACKEND ONLY)
const supabaseAdmin = (supabaseUrl && supabaseServiceRoleKey)
  ? createClient(supabaseUrl, supabaseServiceRoleKey, clientOptions)
  : null;

// Fresh, isolated anon-key client for one auth operation. Auth calls must not share a client
// because supabase-js keeps the last signed-in session in memory on the instance.
// Pass { flowType: 'pkce', storage } for the OAuth code flow.
const createAuthClient = (authOptions = {}) => {
  if (!supabaseUrl || !supabaseAnonKey) return null;
  return createClient(supabaseUrl, supabaseAnonKey, {
    ...clientOptions,
    auth: { ...clientOptions.auth, detectSessionInUrl: false, ...authOptions }
  });
};

module.exports = {
  supabase,
  supabaseAdmin,
  createAuthClient,
  // Email verification, password reset and Google OAuth all require both keys.
  isAuthConfigured: () => Boolean(supabaseUrl && supabaseAnonKey && supabaseServiceRoleKey),
  isConfigured: () => Boolean(supabaseUrl && (supabaseAnonKey || supabaseServiceRoleKey))
};
