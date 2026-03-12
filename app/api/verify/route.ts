import { NextResponse } from 'next/server';
import { supabase } from '@/app/lib/supabase';

export async function POST(req: Request) {
    try {
        const { licenseKey } = await req.json();

        if (!licenseKey) {
            return NextResponse.json(
                { error: 'License key is required', isValid: false, tier: 'free' },
                { status: 400 }
            );
        }

        // 1. Check if the license key exists in our Supabase 'licenses' table
        const { data: license, error } = await supabase
            .from('licenses')
            .select('tier, plan_status, expires_at')
            .eq('key_text', licenseKey)
            .single();

        // 2. If it doesn't exist, it's invalid
        if (error || !license) {
            return NextResponse.json(
                { error: 'Invalid license key', isValid: false, tier: 'free' },
                { status: 401 }
            );
        }

        // 3. Check if the subscription is still active
        if (license.plan_status !== 'active') {
            return NextResponse.json(
                { error: `License is ${license.plan_status}`, isValid: false, tier: 'free' },
                { status: 403 }
            );
        }

        // 4. (Optional) Check expiration date if applicable
        if (license.expires_at) {
            const now = new Date();
            const expiresAt = new Date(license.expires_at);
            if (now > expiresAt) {
                return NextResponse.json(
                    { error: 'License has expired', isValid: false, tier: 'free' },
                    { status: 403 }
                );
            }
        }

        // 5. Success! Return the user's tier
        return NextResponse.json({
            isValid: true,
            tier: license.tier
        });

    } catch (err: any) {
        console.error('License verification error:', err);
        return NextResponse.json(
            { error: 'Internal server error', isValid: false, tier: 'free' },
            { status: 500 }
        );
    }
}
