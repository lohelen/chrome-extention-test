import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(3, '24 h'),
    prefix: '@upstash/ratelimit/free'
});

async function run() {
    try {
        const res = await limiter.getRemaining('test@example.com');
        console.log("getRemaining() output", res);
    } catch (e) {
        console.log("no getRemaining");
    }
    try {
        const res2 = await limiter.check(5, 'test@example.com');
        console.log("check() output", res2);
    } catch (e) {
        console.log("no check either", e.message);
    }
}
run();
