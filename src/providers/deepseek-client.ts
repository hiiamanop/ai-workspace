export async function complete(
  model: string,
  prompt: string,
  apiKey: string = process.env.DEEPSEEK_API_KEY ?? "",
  baseUrl: string = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY not set");
  }

  const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
  });

  if (response.status !== 200) {
    throw new Error(`DeepSeek API returned ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as { choices: { message: { content: string } }[] };
  return body.choices[0].message.content;
}
