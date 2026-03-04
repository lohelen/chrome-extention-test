# CV Optimizer API

Backend API for CV Optimizer Chrome Extension.

## Features

- **Rate Limiting**: 10 requests per 24 hours per IP
- **Kill Switch**: Enable/disable API via environment variable
- **Three AI Actions**:
  - `optimize`: CV optimization with JD keyword integration
  - `interview`: Generate interview questions
  - `ats-swot`: ATS score and SWOT analysis

## Environment Variables

```bash
OPENROUTER_API_KEY=your_openrouter_api_key
KV_REST_API_URL=your_redis_url
KV_REST_API_TOKEN=your_redis_token
ENABLE_API=true
```

## Deploy to Vercel

1. Push to GitHub
2. Import project in Vercel
3. Set environment variables
4. Deploy

## API Endpoint

`POST /`

Request body:
```json
{
  "action": "optimize" | "interview" | "ats-swot",
  "jdText": "Job description...",
  "cvText": "CV content..." // Required for optimize and ats-swot
}
```

Response:
```json
{
  "success": true,
  "data": { ... },
  "quota": {
    "limit": 10,
    "remaining": 9,
    "reset": "2024-..."
  }
}
```
