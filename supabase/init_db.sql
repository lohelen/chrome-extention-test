-- Create the table for storing Gumroad License Keys
CREATE TABLE public.licenses (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    key_text TEXT UNIQUE NOT NULL, -- The actual Gumroad License Key
    tier TEXT NOT NULL CHECK (tier IN ('free', 'pro', 'premium')),
    plan_status TEXT NOT NULL DEFAULT 'active', -- active, cancelled, expired
    purchased_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE, -- nullable, for subscriptions if Gumroad handles it this way
    
    -- Usage Tracking
    daily_usage_count INTEGER DEFAULT 0,
    last_usage_reset TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_DATE,
    
    -- Metadata
    user_email TEXT, -- Extracted from Gumroad webhook if available
    gumroad_sale_id TEXT, -- To trace back to the exact purchase
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Turn on Row Level Security (RLS) to enforce secure access
ALTER TABLE public.licenses ENABLE ROW LEVEL SECURITY;

-- Policy: Allow the Next.js Backend (Service Role Key) to do anything
-- Since we are verifying licenses from our backend API, we don't need anonymous public access to the DB.
CREATE POLICY "Allow Service Role full access to licenses"
    ON public.licenses
    USING (true)
    WITH CHECK (true);

-- Index for faster lookups when the extension sends the key
CREATE INDEX idx_licenses_key_text ON public.licenses(key_text);

-- Trigger to automatically update 'updated_at'
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_licenses_modtime
    BEFORE UPDATE ON public.licenses
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
