import { NextRequest, NextResponse } from 'next/server';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

import { supabase } from '@/app/lib/supabase';

// 1. Initialize Redis for Rate Limiting
const redis = Redis.fromEnv();

// 2. Define our Rate Limiters based on Tiers
// Each "use" = 1 button press that triggers ALL actions simultaneously.
// So these numbers represent actual button presses per day.
const limiters = {
  free: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(3, '24 h'), // 3 uses per day
    prefix: '@upstash/ratelimit/free'
  }),
  pro: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(10, '24 h'), // 10 uses per day
    prefix: '@upstash/ratelimit/pro'
  }),
  premium: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(9999, '24 h'), // Essentially unlimited
    prefix: '@upstash/ratelimit/premium'
  })
};

// Model selection based on tier
function getModel(userTier: string): string {
  if (userTier === 'premium') {
    return 'google/gemini-2.5-pro'; // Better reasoning + writing for Premium
  }
  return 'google/gemini-2.5-flash'; // Fast + cost-efficient for Free & Pro
}

// Helper function to clean JSON responses from AI
function cleanJsonResponse(text: string): string {
  let cleaned = text.trim();
  // Remove markdown code fences
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/i, '').replace(/```\s*$/, '').trim();
  }
  // Remove any leading/trailing non-JSON characters
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  const firstBracket = cleaned.indexOf('[');
  const lastBracket = cleaned.lastIndexOf(']');

  if (firstBrace !== -1 && lastBrace !== -1) {
    if (firstBracket !== -1 && firstBracket < firstBrace) {
      cleaned = cleaned.substring(firstBracket, lastBracket + 1);
    } else {
      cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    }
  }
  return cleaned;
}

// Safely parse JSON with error recovery
function safeJsonParse(text: string): any {
  const cleaned = cleanJsonResponse(text);
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    let fixed = cleaned
      .replace(/,\s*}/g, '}')
      .replace(/,\s*]/g, ']')
      .replace(/[\x00-\x1F\x7F]/g, (ch) => {
        if (ch === '\n') return '\\n';
        if (ch === '\r') return '\\r';
        if (ch === '\t') return '\\t';
        return '';
      });
    try {
      return JSON.parse(fixed);
    } catch (e2) {
      console.error('JSON parse failed even after cleanup. Raw text:', text.substring(0, 500));
      throw new Error('AI returned invalid JSON. Please try again.');
    }
  }
}

// Helper function to get client IP
function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const realIp = request.headers.get('x-real-ip');
  if (forwarded) return forwarded.split(',')[0].trim();
  if (realIp) return realIp;
  return 'unknown';
}

// Language instruction builder
function langInstruction(language: string): string {
  switch (language) {
    case 'zh-TW':
      return 'You MUST respond and generate ALL content entirely in Traditional Chinese (繁體中文). Every single word of your output must be in Traditional Chinese.';
    case 'zh-CN':
      return 'You MUST respond and generate ALL content entirely in Simplified Chinese (简体中文). Every single word of your output must be in Simplified Chinese.';
    default:
      return 'You MUST respond and generate ALL content entirely in English.';
  }
}

// CORS Headers Helper
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

export async function POST(req: NextRequest) {
  try {
    // 1. Kill Switch Check
    const enableApi = process.env.ENABLE_API;
    if (enableApi === 'false' || enableApi === '0') {
      return NextResponse.json(
        { error: 'Service is currently under maintenance. Please try again later.' },
        { status: 503, headers: corsHeaders }
      );
    }

    const body = await req.json();
    const { action, jdText, cvText, userEmail, language } = body;
    const outputLanguage = language || 'en';

    let userTier: 'free' | 'pro' | 'premium' = 'free';
    let rateLimitIdentifier = getClientIp(req);

    // 2. Verify user tier if email is provided
    if (userEmail) {
      const { data: user, error } = await supabase
        .from('users')
        .select('tier, plan_status')
        .eq('email', userEmail)
        .single();

      if (user && user.plan_status === 'active') {
        userTier = user.tier as 'free' | 'pro' | 'premium';
        rateLimitIdentifier = userEmail;
      }
    }

    // 3. Check Rate Limits (only deduct once per "run")
    //    The frontend sends action="run-all" which triggers all generations.
    //    Individual actions like "optimize", "interview", "ats-swot", "cover-letter"
    //    are also accepted but each one deducts 1 from the quota.
    const limiter = limiters[userTier];
    const { success, limit, remaining, reset } = await limiter.limit(rateLimitIdentifier);

    if (!success) {
      return NextResponse.json({
        error: `Daily quota exceeded for ${userTier} tier. Please upgrade or try again tomorrow.`,
        quota: { limit, remaining, reset: new Date(reset).toISOString() }
      }, { status: 429, headers: corsHeaders });
    }

    // 4. Pre-action check for Premium features
    if (action === 'canva_integration' && userTier !== 'premium') {
      return NextResponse.json({ error: 'This feature requires a Premium subscription.' }, { status: 403, headers: corsHeaders });
    }

    if (!action || !jdText) {
      return NextResponse.json(
        { error: 'Missing required fields: action, jdText' },
        { status: 400, headers: corsHeaders }
      );
    }

    // 5. Get API Key from environment
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      console.error('OPENROUTER_API_KEY not configured');
      return NextResponse.json(
        { error: 'Server configuration error' },
        { status: 500, headers: corsHeaders }
      );
    }

    const model = getModel(userTier);
    let result;

    switch (action) {
      case 'optimize':
        if (!cvText) {
          return NextResponse.json({ error: 'Missing cvText for optimization' }, { status: 400, headers: corsHeaders });
        }
        result = await optimizeCV(apiKey, jdText, cvText, outputLanguage, model);
        break;

      case 'interview':
        result = await generateInterviewQuestions(apiKey, jdText, outputLanguage, model);
        break;

      case 'ats-swot':
        if (!cvText) {
          return NextResponse.json({ error: 'Missing cvText for ATS analysis' }, { status: 400, headers: corsHeaders });
        }
        result = await analyzeAtsSwot(apiKey, jdText, cvText, outputLanguage, model);
        break;

      case 'cover-letter':
        if (!cvText) {
          return NextResponse.json({ error: 'Missing cvText for cover letter' }, { status: 400, headers: corsHeaders });
        }
        result = await generateCoverLetter(apiKey, jdText, cvText, outputLanguage, model);
        break;

      default:
        return NextResponse.json(
          { error: 'Invalid action. Must be: optimize, interview, ats-swot, or cover-letter' },
          { status: 400, headers: corsHeaders }
        );
    }

    // 6. Return result
    return NextResponse.json({
      success: true,
      data: result,
      quota: { limit, remaining: remaining - 1, reset: new Date(reset).toISOString() }
    }, { headers: corsHeaders });

  } catch (error: any) {
    console.error('Gateway error:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500, headers: corsHeaders }
    );
  }
}

// ============================================================
// AI Function: Optimize CV
// Core Philosophy: Weave naturally, never invent, explain gaps
// ============================================================
async function optimizeCV(apiKey: string, jdText: string, cvText: string, language: string, model: string) {
  const lang = langInstruction(language);

  const prompt = `
${lang}

## Your Role
You are a world-class career strategist who has placed 500+ candidates into top companies. You combine deep HR expertise with ATS (Applicant Tracking System) engineering knowledge.

## Your Mission
Rewrite the user's CV to maximize ATS keyword match against the provided Job Description. You must follow STRICT rules below.

## STRICT RULES — Read carefully

### Rule 1: NEVER INVENT EXPERIENCE
You MUST ONLY work with the experiences, skills, and background the user has provided. You are STRICTLY FORBIDDEN from inventing, fabricating, or adding any experience, project, skill, certification, or achievement that does not already exist in the original CV. If the user never mentioned "Python", you CANNOT add "Python" to their CV.

### Rule 2: WEAVE KEYWORDS NATURALLY INTO EXISTING EXPERIENCE
Compare the JD keywords against the user's existing CV content. For each experience entry where there is a GENUINE CONNECTION to a JD keyword, rewrite the bullet point to naturally incorporate that keyword. Use professional, fluent language — the keyword must feel like it belongs. Apply the STAR principle (Situation, Task, Action, Result) where possible to strengthen each bullet point.

Example:
- Original: "Managed social media accounts"
- JD requires: "content strategy", "cross-functional collaboration"
- Rewrite: "Developed and executed **content strategy** across social media channels, **collaborating cross-functionally** with design and product teams to align messaging with quarterly business objectives"

### Rule 3: PRESERVE REAL DATA, NEVER FABRICATE METRICS
If the original CV contains quantifiable data (e.g., "increased sales by 15%"), keep it and highlight it. If the original CV does NOT contain metrics for a bullet point, DO NOT invent numbers. Instead, flag it in the "metricsAdvice" section.

### Rule 4: CHANGELOG — Tell the user EXACTLY what you changed
For each section you modified, provide a brief summary of what was changed and why (which JD keyword was woven in).

### Rule 5: MISSED KEYWORDS RATIONALE
After optimization, list all JD keywords you could NOT incorporate because the user's CV has no related experience. For each missed keyword, explain WHY you didn't add it (e.g., "No related experience found in CV") and give a brief suggestion for how the user could address this in an interview.

### Rule 6: METRICS ADVICE
Identify bullet points where the user describes responsibilities but provides no quantifiable results. For each one, suggest what kind of metric they should add (e.g., "How much traffic did you increase? By what percentage did you improve efficiency?"). DO NOT add the numbers yourself.

### Rule 7: BULLET POINT FORMATTING FOR WORK EXPERIENCE
For Professional Experience / Work Experience sections, you MUST format the optimized content as follows:
- The **job title, company name, location, and dates** line stays as a single plain text line (NO bullet point).
- Every individual achievement, responsibility, or description underneath MUST be its own separate bullet point using "- " prefix.
- Do NOT merge multiple achievements into one long paragraph. Each distinct point gets its own "- " bullet.
- Example format:
  "Marketing Manager | Acme Corp | London, UK\n- Developed and executed **content strategy** across social media channels\n- Led **conversion optimization** for 2,140+ product listings\n- Collaborated with 15 internal **cross-functional** teams"
- For Summary/Skills/Education sections, use whatever format is most natural (paragraph or bullets).

## Input

**Job Description:**
${jdText}

**Current CV:**
${cvText}

## Required JSON Output Format
{
  "keywords": ["keyword1", "keyword2", ...],
  "jdSummary": "A concise 1-2 sentence summary of what the JD is looking for",
  "sections": [
    {
      "title": "Section Title (e.g., Professional Summary, Work Experience, Skills)",
      "originalContent": "The exact original text from the CV for this section",
      "optimizedContent": "The rewritten version with **bolded keywords** woven in naturally. Use Markdown bullet points (- item) for each achievement in work experience sections.",
      "changelog": "Brief explanation of what was changed in this section and which JD keywords were integrated"
    }
  ],
  "missedKeywords": [
    {
      "keyword": "The JD keyword that was NOT added",
      "reason": "Why it couldn't be added (no related experience in CV)",
      "interviewTip": "How to address this gap if asked in an interview"
    }
  ],
  "metricsAdvice": [
    {
      "section": "Which section/bullet this applies to",
      "currentText": "The bullet point that lacks data",
      "suggestion": "What specific metric or data point the user should add"
    }
  ]
}

IMPORTANT:
- In the "keywords" array, return ONLY the keyword itself (e.g., "Google Ads", "SEO"). Do NOT include category prefixes.
- Fix any spacing errors from PDF extraction (e.g., "M anaged" → "Managed").
- In work experience sections, EVERY achievement must be a separate bullet point using "- " prefix. Do NOT write paragraphs.
- The job title / company / date line should NOT have a bullet point prefix.
- Ensure the optimized CV reads naturally and professionally.`;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      "model": model,
      "response_format": { "type": "json_object" },
      "messages": [
        { "role": "user", "content": prompt }
      ]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  const text = data.choices[0].message.content;
  const parsedResult = safeJsonParse(text);

  return {
    keywords: parsedResult.keywords || [],
    jdSummary: parsedResult.jdSummary || "Summary not available.",
    sections: parsedResult.sections || [],
    missedKeywords: parsedResult.missedKeywords || [],
    metricsAdvice: parsedResult.metricsAdvice || []
  };
}

// ============================================================
// AI Function: Generate Interview Questions
// ============================================================
async function generateInterviewQuestions(apiKey: string, jdText: string, language: string, model: string) {
  const lang = langInstruction(language);

  const prompt = `
${lang}

## Your Role
You are a senior hiring manager with 15+ years of experience conducting interviews at top-tier companies. You know exactly what separates average candidates from exceptional ones.

## Your Mission
Based on the Job Description below, generate 10 highly strategic interview questions that are SPECIFIC to this role. These should NOT be generic questions — they must directly reference the skills, tools, responsibilities, and challenges mentioned in the JD.

## Job Description:
${jdText}

## Question Categories (mix all three):
1. **Behavioral Questions** (e.g., "Tell me about a time when you applied [specific skill from JD]...")
2. **Technical/Skill-based Questions** (e.g., "How would you approach [specific task from JD] using [specific tool from JD]?")
3. **Situational Questions** (e.g., "If [realistic scenario based on JD responsibilities], what would you do?")

Return the response as a JSON object:
{
  "questions": ["Question 1", "Question 2", ..., "Question 10"]
}

IMPORTANT:
- Questions must directly reference specific keywords, tools, or responsibilities from the JD.
- Questions must be insightful and challenging, not generic.
- Each question should test a DIFFERENT aspect of the candidate's fitness for this specific role.`;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      "model": model,
      "response_format": { "type": "json_object" },
      "messages": [
        { "role": "user", "content": prompt }
      ]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  const text = data.choices[0].message.content;
  const parsedResult = safeJsonParse(text);

  if (Array.isArray(parsedResult)) return parsedResult;
  if (parsedResult.questions && Array.isArray(parsedResult.questions)) return parsedResult.questions;
  return [];
}

// ============================================================
// AI Function: ATS SWOT Analysis
// Core: Actionable metrics, specific "how to reach 95%" guide
// ============================================================
async function analyzeAtsSwot(apiKey: string, jdText: string, cvText: string, language: string, model: string) {
  const lang = langInstruction(language);

  const prompt = `
${lang}

## Your Role
You are an expert ATS (Applicant Tracking System) engineer combined with a senior HR strategist. You understand exactly how ATS algorithms score CVs and what hiring managers look for.

## Your Mission
Analyze the CV against the JD. Provide a precise ATS score and an actionable improvement roadmap that tells the user EXACTLY how to reach 95%+.

## STRICT RULES

### Rule 1: BE SPECIFIC, NOT VAGUE
Do NOT say "Lacks project experience." Instead, say "Your CV does not mention experience with 'cross-functional stakeholder management' which the JD specifically requires in bullet 3 under Core Responsibilities."

### Rule 2: REFERENCE THE OPTIMIZED CV
When giving improvement advice, tell the user: "In the optimized version of your CV, I have already woven [keyword] into your [specific experience section]. This change alone should improve your score by approximately X points." Reference what has ALREADY been changed.

### Rule 3: METRICS GAP WARNING
If the user's CV bullet points lack quantifiable results, list each one and urge them to add real data. Say: "Your bullet 'Managed social media accounts' has no metrics. Adding a result like 'growing followers by X%' would significantly boost your ATS score."

### Rule 4: ACTIONABLE SCORE IMPROVEMENT PLAN
After giving the current score, provide a concrete breakdown:
"Your current score is 72. To reach 95:
 - (+8 pts) Add the missing keyword 'data-driven' to your marketing experience section
 - (+5 pts) Add quantifiable metrics to at least 3 bullet points
 - (+10 pts) These keywords cannot be added because you lack the experience — consider upskilling or addressing in your cover letter: [list]"

## Input

**Job Description:**
${jdText}

**CV Text:**
${cvText}

## Required JSON Output Format
{
  "atsScore": 75,
  "missingKeywords": ["Keyword1", "Keyword2"],
  "swot": {
    "strengths": ["Specific strength referencing CV content"],
    "weaknesses": ["Specific weakness referencing JD requirement"],
    "opportunities": ["Specific actionable opportunity"],
    "threats": ["Specific external threat or competition factor"]
  },
  "scoreImprovementPlan": [
    {
      "action": "What to do (e.g., 'Add keyword X to your Y experience section')",
      "estimatedPointsGain": 8,
      "alreadyDone": true or false,
      "details": "If alreadyDone is true, explain where in the optimized CV this was already applied. If false, explain what the user needs to do manually."
    }
  ]
}

IMPORTANT:
- Be strict but fair with the ATS score.
- Every SWOT item must reference specific content from the CV or JD, not generic advice.
- The scoreImprovementPlan must add up to show a clear path from the current score to 95+.
`;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      "model": model,
      "response_format": { "type": "json_object" },
      "messages": [
        { "role": "user", "content": prompt }
      ]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  const text = data.choices[0].message.content;
  return safeJsonParse(text);
}

// ============================================================
// AI Function: Generate Cover Letter (NEW)
// ============================================================
async function generateCoverLetter(apiKey: string, jdText: string, cvText: string, language: string, model: string) {
  const lang = langInstruction(language);

  const prompt = `
${lang}

## Your Role
You are an elite career coach who has helped 1000+ job seekers land offers at top companies. You write compelling, personalized cover letters that hiring managers actually want to read.

## Your Mission
Write a highly customized cover letter based on the user's CV and the target Job Description. The cover letter must feel personal, confident, and directly connect the user's real experience to the job requirements.

## STRICT RULES

### Rule 1: ONLY USE REAL EXPERIENCE
Every claim in the cover letter MUST be backed by something that exists in the user's CV. Do NOT invent achievements, projects, skills, or numbers that are not in the CV.

### Rule 2: CONNECT CV TO JD
For each key requirement in the JD, find the most relevant experience from the CV and weave it into a compelling narrative. If there is no matching experience for a JD requirement, DO NOT mention it — simply focus on the areas where the user IS strong.

### Rule 3: PROFESSIONAL TONE
The cover letter should be confident but not arrogant, specific but not verbose. Aim for 3-4 paragraphs, approximately 250-350 words.

### Rule 4: STRUCTURE
- **Opening paragraph**: Hook the reader. Mention the specific role and briefly state why the user is an excellent fit.
- **Body paragraphs (1-2)**: Connect 2-3 of the strongest CV experiences to the top JD requirements, using specific (real) examples.
- **Closing paragraph**: Express enthusiasm, suggest next steps (interview), and thank the reader.

## Input

**Job Description:**
${jdText}

**User's CV:**
${cvText}

## Required JSON Output Format
{
  "coverLetter": "The full cover letter text. Use proper paragraph breaks with \\n\\n between paragraphs.",
  "highlightedConnections": [
    {
      "jdRequirement": "The JD requirement this addresses",
      "cvExperience": "Which CV experience was used to address it"
    }
  ]
}

IMPORTANT:
- The cover letter must feel genuinely personalized, not templated.
- Do NOT use cliché phrases like "I am writing to express my interest" or "I am a highly motivated individual".
- Start with something specific and engaging about the role or company.
`;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      "model": model,
      "response_format": { "type": "json_object" },
      "messages": [
        { "role": "user", "content": prompt }
      ]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  const text = data.choices[0].message.content;
  return safeJsonParse(text);
}
