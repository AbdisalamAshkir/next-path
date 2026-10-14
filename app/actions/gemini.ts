"use server";

import Groq from "groq-sdk";

interface QuestionResponse {
  type: "question";
  question: string;
  answers: string[];
}

interface RecommendationResponse {
  type: "recommendation";
  title: string;
  recommendations: {
    title: string;
    description: string;
    matchScore: "High" | "Medium" | "Low";
    requiredSkills: string[];
    careerProspects: string;
  }[];
  analysis: {
    strengths: string[];
    interests: string[];
    whyThesePaths: string;
  };
  nextSteps: string[];
}

type CareerResponse = QuestionResponse | RecommendationResponse;

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const historyStore = new Map<string, ChatMessage[]>();

const systemPrompt = `
You are an AI career guidance counselor helping high school graduates
choose a suitable college major and career path.

GOALS:
1. Understand students' interests, strengths, preferences, and goals.
2. Ask one clear question at a time.
3. Use previous answers to choose meaningful follow-up questions.
4. Recommend suitable college majors based on collected answers.
5. Explain why each recommendation fits the student's answers.

HIGH SCHOOL SUBJECTS:
Mathematics, Physics, Chemistry, Biology, Somali, Arabic,
Islamic Studies, English, Geography, History.

QUESTION RULES:
1. Begin by asking which high school subject the student enjoyed most.
2. Include all ten subjects as options in the first question.
3. Ask only one question per response.
4. Use simple, concise English.
5. Prefer multiple-choice answers.
6. Explore interests beyond school subjects: problem-solving,
   creativity, helping people, business, technology, leadership,
   communication, and practical work.
7. Avoid repeating questions already answered.
8. Consider all previous answers.
9. Track the student's answers in order.
10. Approximate preference scores:
    Hate it = -2, Dislike it = -1, Neutral = 0,
    Like it = 1, Love it = 2.
11. Do not recommend a major based only on one answer.
12. Ask further questions when more information is needed.
13. Recommend majors when sufficient information is available.

OUTPUT RULES:
- Return valid JSON only.
- Never return Markdown fences or text outside the JSON object.
- Use double quotes for all JSON keys and strings.
- Do not include comments or trailing commas.
- Return either a question or a recommendation.

QUESTION FORMAT:
{
  "type": "question",
  "question": "Which subject did you enjoy most in high school?",
  "answers": [
    "Mathematics", "Physics", "Chemistry", "Biology", "Somali",
    "Arabic", "Islamic Studies", "English", "Geography", "History"
  ]
}

RECOMMENDATION FORMAT:
{
  "type": "recommendation",
  "title": "Your Career Path",
  "recommendations": [
    {
      "title": "Computer Science",
      "description": "Description of the major and its focus areas.",
      "matchScore": "High",
      "requiredSkills": [
        "Problem-solving",
        "Logical thinking",
        "Programming"
      ],
      "careerProspects": "Career opportunities and growth."
    }
  ],
  "analysis": {
    "strengths": ["Strengths supported by answers"],
    "interests": ["Interests supported by answers"],
    "whyThesePaths": "Explain how the student's answers support the recommendations."
  },
  "nextSteps": [
    "Research the recommended college programs.",
    "Check admission requirements.",
    "Try an introductory course or practical activity."
  ]
}

RECOMMENDATION GUIDELINES:
- Base recommendations on actual student answers.
- Explain the evidence supporting each recommended major.
- Consider disliked activities and subjects.
- Use High, Medium, or Low for matchScore.
- Do not invent skills or strengths.
- Prefer a few well-supported recommendations.
- Ask another question if more information is needed.

Always return valid JSON only.
`;

function getGroqClient(): Groq {
  const apiKey = process.env.GROQ_API_KEY;

  if (typeof apiKey !== "string" || !apiKey.trim()) {
    console.error(
      "[Groq] GROQ_API_KEY is unavailable to the Next.js server process.",
      {
        nodeEnv: process.env.NODE_ENV,
        workingDirectory: process.cwd(),
      }
    );

    throw new Error(
      "GROQ_API_KEY is missing from the Next.js server environment. " +
        "Check the project-root .env.local file and restart the server."
    );
  }

  return new Groq({ apiKey: apiKey.trim() });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: number }).status;

    if (
      status === 429 ||
      status === 500 ||
      status === 502 ||
      status === 503 ||
      status === 504
    ) {
      return true;
    }
  }

  const message = error instanceof Error ? error.message : String(error);

  return /\b(429|500|502|503|504)\b/.test(message);
}

async function createCompletion(
  client: Groq,
  messages: ChatMessage[]
): Promise<string> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const completion = await client.chat.completions.create({
       model: "openai/gpt-oss-120b",
        messages,
        temperature: 0.7,
        top_p: 0.95,
        max_completion_tokens: 4096,
        response_format: { type: "json_object" },
      });

      const content = completion.choices[0]?.message?.content;

      if (typeof content !== "string" || !content.trim()) {
        throw new Error("Groq returned an empty response.");
      }

      return content;
    } catch (error: unknown) {
      if (!isRetryableError(error) || attempt === maxAttempts) {
        throw error;
      }

      // Exponential backoff for temporary server errors and rate limits.
      await delay(1500 * Math.pow(2, attempt - 1));
    }
  }

  throw new Error("Groq did not respond after multiple attempts.");
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === "string")
  );
}

function validateCareerResponse(data: unknown): CareerResponse {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Groq returned an invalid JSON object.");
  }

  const result = data as Record<string, unknown>;

  if (result.type === "question") {
    if (
      typeof result.question !== "string" ||
      !isStringArray(result.answers) ||
      result.answers.length === 0
    ) {
      throw new Error("Groq returned an invalid question structure.");
    }

    return result as unknown as QuestionResponse;
  }

  if (result.type === "recommendation") {
    const analysis = result.analysis;

    if (
      typeof result.title !== "string" ||
      !Array.isArray(result.recommendations) ||
      result.recommendations.length === 0 ||
      !analysis ||
      typeof analysis !== "object" ||
      Array.isArray(analysis) ||
      !isStringArray((analysis as Record<string, unknown>).strengths) ||
      !isStringArray((analysis as Record<string, unknown>).interests) ||
      typeof (analysis as Record<string, unknown>).whyThesePaths !== "string" ||
      !isStringArray(result.nextSteps)
    ) {
      throw new Error("Groq returned an invalid recommendation structure.");
    }

    for (const item of result.recommendations) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("Groq returned an invalid major recommendation.");
      }

      const recommendation = item as Record<string, unknown>;

      if (
        typeof recommendation.title !== "string" ||
        typeof recommendation.description !== "string" ||
        !["High", "Medium", "Low"].includes(
          recommendation.matchScore as string
        ) ||
        !isStringArray(recommendation.requiredSkills) ||
        typeof recommendation.careerProspects !== "string"
      ) {
        throw new Error("Groq returned an invalid major recommendation.");
      }
    }

    return result as unknown as RecommendationResponse;
  }

  throw new Error(
    'Groq returned an unexpected response type. Expected "question" or "recommendation".'
  );
}

export async function gemeni(
  rollnumber: string,
  examResult?: unknown,
  usersAnswer?: unknown
): Promise<string> {
  if (!rollnumber || !rollnumber.trim()) {
    throw new Error("A valid student roll number is required.");
  }

  try {
    const client = getGroqClient();

    let history = historyStore.get(rollnumber);

    if (!history) {
      const initialPrompt =
        systemPrompt +
        (examResult !== undefined
          ? "\n\nSTUDENT HIGH SCHOOL EXAM RESULTS:\n" +
            JSON.stringify(examResult)
          : "");

      history = [
        {
          role: "system",
          content: initialPrompt,
        },
        {
          role: "user",
          content:
            "Ask the first career guidance question. Include all ten high school subjects as answer options. Return valid JSON only.",
        },
      ];

      historyStore.set(rollnumber, history);
    } else if (usersAnswer !== undefined && usersAnswer !== null) {
      const answer =
        typeof usersAnswer === "string"
          ? usersAnswer
          : JSON.stringify(usersAnswer);

      history.push({
        role: "user",
        content:
          "Student's latest answer: " +
          answer +
          "\nConsider all previous answers. Ask one new question, or return recommendations if enough information has been collected. Do not repeat a question already answered. Return valid JSON only.",
      });
    } else {
      // Return the previous response if this is a repeated initial request.
      const previousAssistantMessage = [...history]
        .reverse()
        .find((message) => message.role === "assistant");

      if (previousAssistantMessage) {
        return previousAssistantMessage.content;
      }
    }

    const responseText = await createCompletion(client, history);

    let parsedResponse: unknown;

    try {
      parsedResponse = JSON.parse(responseText);
    } catch {
      throw new Error("Groq returned invalid JSON. Please try again.");
    }

    const validatedResponse = validateCareerResponse(parsedResponse);
    const validatedJson = JSON.stringify(validatedResponse);

    // Save the assistant's response for the next student answer.
    history.push({
      role: "assistant",
      content: validatedJson,
    });

    // Keep history bounded to prevent excessively large requests.
    // Preserve the system prompt and the most recent conversation messages.
    const systemMessage = history[0];

    if (history.length > 41 && systemMessage?.role === "system") {
      history.splice(1, history.length - 41);
    }

    historyStore.set(rollnumber, history);

    return validatedJson;
  } catch (error: unknown) {
    console.error(
      "Groq API Error:",
      error instanceof Error ? error.message : "Unknown error"
    );

    const message =
      error instanceof Error ? error.message : "Unknown Groq API error";

    throw new Error(`Failed to get AI response: ${message}`);
  }
}

export async function clearMemory(): Promise<void> {
  historyStore.clear();
  console.log("Career guidance memory cleared.");
}