import { NextRequest, NextResponse } from 'next/server';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

import { supabase } from '@/app/lib/supabase';

// 1. Initialize Redis for Rate Limiting
const redis = Redis.fromEnv();

// 2. Define our Rate Limiters based on Tiers
const limiters = {
  free: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(9, '24 h'), // 3 uses * 3 APIs
    prefix: '@upstash/ratelimit/free'
  }),
  pro: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(45, '24 h'), // 15 uses * 3 APIs
    prefix: '@upstash/ratelimit/pro'
  }),
  premium: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(150, '24 h'), // 50 uses * 3 APIs
    prefix: '@upstash/ratelimit/premium'
  })
};

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
    // Check if it's an object or array
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
    // Try fixing common issues: trailing commas, unescaped newlines in strings
    let fixed = cleaned
      .replace(/,\s*}/g, '}')      // trailing comma before }
      .replace(/,\s*]/g, ']')       // trailing comma before ]
      .replace(/[\x00-\x1F\x7F]/g, (ch) => {
        // Escape control characters inside strings
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

  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  if (realIp) {
    return realIp;
  }
  return 'unknown';
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
    const { action, jdText, cvText, licenseKey } = body;
    let userTier: 'free' | 'pro' | 'premium' = 'free';
    let rateLimitIdentifier = getClientIp(req);

    // 3. Verify License Key if provided
    if (licenseKey) {
      const { data: license, error } = await supabase
        .from('licenses')
        .select('tier, plan_status')
        .eq('key_text', licenseKey)
        .single();

      if (license && license.plan_status === 'active') {
        userTier = license.tier as 'free' | 'pro' | 'premium';
        rateLimitIdentifier = licenseKey; // Use key instead of IP for paid users
      }
    }

    // 4. Check Rate Limits
    const limiter = limiters[userTier];
    const { success, limit, remaining, reset } = await limiter.limit(rateLimitIdentifier);

    if (!success) {
      return NextResponse.json({
        error: `Daily quota exceeded for ${userTier} tier. Please upgrade or try again tomorrow.`,
        quota: { limit, remaining, reset: new Date(reset).toISOString() }
      }, { status: 429, headers: corsHeaders });
    }

    // 5. Pre-action check for Premium features
    if (action === 'canva_integration' && userTier !== 'premium') {
      return NextResponse.json({ error: 'This feature requires a Premium subscription.' }, { status: 403, headers: corsHeaders });
    }

    if (!action || !jdText) {
      return NextResponse.json(
        { error: 'Missing required fields: action, jdText' },
        { status: 400, headers: corsHeaders }
      );
    }

    // 4. Get API Key from environment
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      console.error('OPENROUTER_API_KEY not configured');
      return NextResponse.json(
        { error: 'Server configuration error' },
        { status: 500, headers: corsHeaders }
      );
    }

    let result;

    switch (action) {
      case 'optimize':
        if (!cvText) {
          return NextResponse.json(
            { error: 'Missing cvText for optimization' },
            { status: 400, headers: corsHeaders }
          );
        }
        result = await optimizeCV(apiKey, jdText, cvText);
        break;

      case 'interview':
        result = await generateInterviewQuestions(apiKey, jdText);
        break;

      case 'ats-swot':
        if (!cvText) {
          return NextResponse.json(
            { error: 'Missing cvText for ATS analysis' },
            { status: 400, headers: corsHeaders }
          );
        }
        result = await analyzeAtsSwot(apiKey, jdText, cvText);
        break;

      default:
        return NextResponse.json(
          { error: 'Invalid action. Must be: optimize, interview, or ats-swot' },
          { status: 400, headers: corsHeaders }
        );
    }

    // 6. Return result
    return NextResponse.json({
      success: true,
      data: result
    }, { headers: corsHeaders });

  } catch (error: any) {
    console.error('Gateway error:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500, headers: corsHeaders }
    );
  }
}

// AI Functions (ported from extension)
async function optimizeCV(apiKey: string, jdText: string, cvText: string) {
  const prompt = `
角色定位與目標：

* 你是一位擁有多年實務經驗的人力資源資深獵頭，同時具備自然語言處理（NLP）的專業技術，能夠深入剖析企業徵才需求。
* 你的核心任務是從使用者提供的複雜職位描述（Job Description, JD）中，精準提取出最具商業價值的核心維度資訊。
* 透過專業的 NLP 技術，將非結構化的文本轉化為結構化的關鍵標籤,協助使用者快速掌握職位重點。

行為準則與提取規則：

1) 資訊提取維度：
請依據以下類別從 Job Description (JD) 中進行關鍵字提取：
* 硬技能與技術棧（Hard Skills/Tech Stack）：如特定程式語言、軟體工具、專業證照、NLP 模型架構等。
* 核心工作職責（Core Responsibilities）：具體的產出目標或關鍵任務。
* 產業知識與背景（Industry Knowledge）：特定產業的運作流程或領域知識。
* 關鍵軟技能（Strategic Soft Skills）：排除籠統的描述（如『團隊合作』、『負責任』、『抗壓性強』），僅提取該職位特別強調或具備高門檻的軟實力（如『具備跨國多方利益關係人管理經驗』、『複雜合約談判能力』）。

提取出的關鍵詞必須具備代表性。

Job Description:
${jdText}

Current CV:
${cvText}

Please perform the following tasks:

1. **Summarize the JD**: Provide a concise summary (1-2 sentences) of what this Job Description is emphasizing and looking for in a candidate.

2. Analyze the CV and split it into logical sections (e.g., Summary, Experience, Skills, Education, etc.).

3. For EACH section:
   - Extract the "Original Content" exactly as it appears in the Current CV.
   - Create an "Optimized Content" version by naturally integrating the extracted HIGH-VALUE keywords from the JD.
   - **CRITICAL FORMATTING INSTRUCTIONS**:
     - **Fix Spacing Errors**: Correct any broken words from the original text (e.g., fix "M anaged" to "Managed", "P roject" to "Project").
     - **Use Markdown Lists**: If the original content had bullet points or lists, YOU MUST reproduce them using standard Markdown bullet points ('- Item').
     - **Preserve Structure**: Ensure distinct paragraphs are separated by blank lines.
   - **IMPORTANT**: In the "Optimized Content", wrap the following in double asterisks (**keyword**):
     1. Any NEWLY ADDED or MODIFIED keywords from the JD.
     2. Any EXISTING high-value industry-specific keywords or quantifiable data points (e.g., '15%', 'Python', 'Revenue'). **Do NOT highlight generic words.**

Return your response in the following JSON format:
{
  "keywords": ["Google Ads", "SEO", "Python", ...],
  "jdSummary": "A concise summary of the JD...",
  "sections": [
    {
        "title": "Section Title",
        "originalContent": "Original text...",
        "optimizedContent": "Optimized text with **bolded keywords** and - bullet points"
    },
    ...
  ]
}

IMPORTANT: 
- In the "keywords" array, return ONLY the keyword itself (e.g., "Google Ads", "SEO", "Python"). Do NOT include any category prefix like "Hard Skills/Tech Stack:" or "Core Responsibilities:".
- Automatically detect the language of the CV and respond in the same language.
- Ensure the optimized CV is natural and readable.
- Do not fabricate experience or skills.
- Only add keywords where they genuinely fit.`;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      "model": "google/gemini-2.5-flash",
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
  };
}

async function generateInterviewQuestions(apiKey: string, jdText: string) {
  const prompt = `
角色定位與目標：

* 你是一位擁有多年實務經驗的人力資源資深獵頭，同時具備自然語言處理（NLP）的專業技術，能夠深入剖析企業徵才需求。
* 你的核心任務是根據使用者提供的職位描述（Job Description, JD），預測面試中極可能被問到的問題。

Job Description:
${jdText}

Task:
Generate 10 strategic interview questions based SPECIFICALLY on the requirements, skills, and responsibilities mentioned in the JD above.
The questions should be a mix of:
1.  **Behavioral Questions** (e.g., "Tell me about a time when you applied [Skill]...")
2.  **Technical/Skill-based Questions** (e.g., "How would you approach [Task] using [Tool]?")
3.  **Situational Questions** (e.g., "If [Scenario] happens, what would you do?")

Return the response as a simple JSON array of strings:
["Question 1", "Question 2", ..., "Question 10"]

IMPORTANT:
- Automatically detect the language of the JD and generate questions in the SAME language.
- Questions must be insightful and challenging, not generic.`;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      "model": "google/gemini-2.5-flash",
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

async function analyzeAtsSwot(apiKey: string, jdText: string, cvText: string) {
  const prompt = `
Role: Expert ATS System & HR Strategy Analyst.

Task: Analyze the provided CV against the Job Description (JD) to provide an ATS Score and a Strategic SWOT Analysis.

Job Description:
${jdText}

CV Text:
${cvText}

Output Requirements:
1. **ATS Score (0-100)**: Evaluate how well the CV matches the JD based on keywords, skills, and experience match. Be strict but fair.
2. **Missing Keywords**: Identify critical high-value keywords from the JD that are MISSING in the CV.
3. **SWOT Analysis**:
    - **Strengths**: What makes this candidate a strong fit based on the CV?
    - **Weaknesses**: What are the gaps or red flags in the CV vs JD?
    - **Opportunities**: What could the candidate emphasize more to improve their chances?
    - **Threats**: What external factors or competition might be a challenge (e.g., "Lack of specific degree required by JD")?

Return pure JSON:
{
    "atsScore": 75,
    "missingKeywords": ["Keyword1", "Keyword2"],
    "swot": {
        "strengths": ["Item 1", "Item 2"],
        "weaknesses": ["Item 1", "Item 2"],
        "opportunities": ["Item 1", "Item 2"],
        "threats": ["Item 1", "Item 2"]
    }
}
`;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      "model": "google/gemini-2.5-flash",
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
