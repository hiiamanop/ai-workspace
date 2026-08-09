export async function complete(
  model: string,
  prompt: string,
  baseUrl: string = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
  });

  if (response.status !== 200) {
    throw new Error(`Ollama API returned ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as { choices: { message: { content: string } }[] };
  return body.choices[0].message.content;
}
