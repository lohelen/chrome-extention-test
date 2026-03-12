import { NextResponse } from 'next/server';
import { supabase } from '@/app/lib/supabase';

// Gumroad Webhook: called when a purchase is made
// Gumroad sends the buyer's email + product info
export async function POST(req: Request) {
    try {
        const body = await req.json();

        // Gumroad sends these fields
        const email = body.email || body.purchaser_email;
        const productName = body.product_name || '';
        const saleId = body.sale_id || '';

        if (!email) {
            return NextResponse.json({ error: 'No email provided' }, { status: 400 });
        }

        // Determine the tier based on the Gumroad product name
        let tier: 'pro' | 'premium' = 'pro';
        if (productName.toLowerCase().includes('premium')) {
            tier = 'premium';
        }

        // Check if user exists
        const { data: existingUser } = await supabase
            .from('users')
            .select('id')
            .eq('email', email)
            .single();

        if (existingUser) {
            // Upgrade existing user
            await supabase
                .from('users')
                .update({
                    tier,
                    plan_status: 'active',
                    gumroad_sale_id: saleId,
                    purchased_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
                .eq('email', email);
        } else {
            // Create new user with the purchased tier
            await supabase
                .from('users')
                .insert({
                    email,
                    tier,
                    plan_status: 'active',
                    gumroad_sale_id: saleId,
                    purchased_at: new Date().toISOString()
                });
        }

        return NextResponse.json({ success: true, tier });

    } catch (err: any) {
        console.error('Gumroad webhook error:', err);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
