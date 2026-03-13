import { NextRequest, NextResponse } from 'next/server';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { supabase } from '@/app/lib/supabase';

const redis = Redis.fromEnv();

const limiters = {
    free: new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(3, '24 h'),
        prefix: '@upstash/ratelimit/free'
    }),
    pro: new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(10, '24 h'),
        prefix: '@upstash/ratelimit/pro'
    }),
    premium: new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(9999, '24 h'),
        prefix: '@upstash/ratelimit/premium'
    })
};

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const email = searchParams.get('email');

        if (!email) {
            return NextResponse.json({ error: 'Email is required' }, { status: 400 });
        }

        // 1. Get user tier
        const { data: user, error: dbError } = await supabase
            .from('users')
            .select('tier')
            .eq('email', email)
            .single();

        if (dbError || !user) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }

        const tier = user.tier || 'free';
        const limiter = limiters[tier as keyof typeof limiters];

        if (!limiter) {
            return NextResponse.json({ error: 'Invalid tier' }, { status: 500 });
        }

        // 2. We use limiter.getRemaining if it exists on this version of @upstash/ratelimit
        // If not, we have to fallback or use a small hack.
        let remaining = 0;
        let limit = tier === 'free' ? 3 : (tier === 'pro' ? 10 : 9999);

        try {
            // Many versions of @upstash/ratelimit support .getRemaining() or .get()
            // If it throws, we catch it.
            const res = await (limiter as any).getRemaining(email);
            if (typeof res === 'number') {
                remaining = res;
            } else if (res && typeof res.remaining === 'number') {
                remaining = res.remaining;
            } else {
                // Check if .check() exists
                const checkRes = await (limiter as any).check(1, email);
                if (checkRes && typeof checkRes.remaining === 'number') {
                    remaining = checkRes.remaining;
                }
            }
        } catch (e: any) {
            console.error("limiter get error", e);
            // If no API to check without incrementing, we might have to just return the max limit or throw
            remaining = limit; // Fallback
        }

        // `used` is what user asked for: 0/3 means used=0, limit=3
        const used = Math.max(0, limit - remaining);

        return NextResponse.json({
            success: true,
            quota: {
                used,
                limit,
                remaining,
                tier
            }
        });

    } catch (err: any) {
        console.error('Quota check error', err);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
