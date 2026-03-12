import { NextResponse } from 'next/server';
import { supabase } from '@/app/lib/supabase';

export async function POST(req: Request) {
    try {
        const { email, name, avatar } = await req.json();

        if (!email) {
            return NextResponse.json({ error: 'Email is required' }, { status: 400 });
        }

        // 1. Check if user already exists
        const { data: existingUser, error: fetchError } = await supabase
            .from('users')
            .select('tier, plan_status')
            .eq('email', email)
            .single();

        if (existingUser) {
            // User exists — return their current tier
            return NextResponse.json({
                tier: existingUser.plan_status === 'active' ? existingUser.tier : 'free',
                isNewUser: false
            });
        }

        // 2. New user — create with free tier
        const { error: insertError } = await supabase
            .from('users')
            .insert({
                email,
                google_name: name || '',
                google_avatar: avatar || '',
                tier: 'free',
                plan_status: 'active'
            });

        if (insertError) {
            console.error('Insert error:', insertError);
            return NextResponse.json({ error: 'Failed to create user' }, { status: 500 });
        }

        return NextResponse.json({
            tier: 'free',
            isNewUser: true
        });

    } catch (err: any) {
        console.error('Google auth error:', err);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
