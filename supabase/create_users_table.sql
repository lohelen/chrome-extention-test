-- Create the 'users' table for Google Sign-In based authentication
-- This replaces the old 'licenses' table approach

CREATE TABLE public.users (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    google_name TEXT,
    google_avatar TEXT,
    tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'premium')),
    plan_status TEXT NOT NULL DEFAULT 'active',

    -- Usage Tracking
    daily_usage_count INTEGER DEFAULT 0,
    last_usage_reset TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_DATE,

    -- Gumroad Payment Info
    gumroad_sale_id TEXT,
    purchased_at TIMESTAMP WITH TIME ZONE,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for faster lookups by email
CREATE INDEX idx_users_email ON public.users(email);

-- Enable Row Level Security
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- Policy: Allow service role full access
CREATE POLICY "Service role full access"
    ON public.users
    FOR ALL
    USING (true)
    WITH CHECK (true);
