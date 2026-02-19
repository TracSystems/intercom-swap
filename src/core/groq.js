import { request } from "undici";
import dotenv from "dotenv";

dotenv.config();

export async function groqParse(prompt) {
  if (!process.env.GROQ_API_KEY) return null;

  try {
    const res = await request("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL,
        messages: [
          {
            role: "system",
            content: "Return ONLY JSON swap params"
          },
          { role: "user", content: prompt }
        ]
      })
    });

    const data = await res.body.json();
    return JSON.parse(data.choices[0].message.content);
  } catch {
    return null;
  }
}
