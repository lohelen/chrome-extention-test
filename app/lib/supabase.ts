import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || 'dummy_key';

// We use the service role key here because this is a server-side environment
// and we need full access to the licenses table to verify and update usage logs.
export const supabase = createClient(supabaseUrl, supabaseServiceKey);
