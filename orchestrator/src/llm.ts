import OpenAI from "openai";

import { parseActions, type Action, type ActionType } from "./perception.js";

export interface ActionToolSchema {
  name: ActionType;
  description: string;
}

export const ACTION_TOOLS: readonly ActionToolSchema[] = [
  { name: "move_to", description: "Move to a village location. Fields: location." },
  { name: "speak", description: "Say a short line aloud. Fields: text." },
  {
    name: "produce",
    description: "Run one recipe at the current location. Fields: item, quantity.",
  },
  { name: "eat", description: "Eat one unit of food from inventory. Fields: item, quantity." },
  {
    name: "post_order",
    description: "Offer items for sale. Fields: item, quantity, price, side=sell.",
  },
  {
    name: "buy_item",
    description: "Buy from a sell order. Fields: order_id, item, quantity, max_price.",
  },
  { name: "cancel_order", description: "Cancel your order. Fields: order_id." },
];

export async function decideWithLlm(
  perception: string,
  toolsSchema: readonly ActionToolSchema[],
): Promise<Action[]> {
  const apiKey = process.env.NEAR_AI_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(
      "NEAR_AI_API_KEY is not set; run with --policy policy for the deterministic demo",
    );
  }

  const baseURL = process.env.NEAR_AI_BASE_URL ?? "https://cloud-api.near.ai/v1";
  const model = process.env.NEAR_AI_MODEL ?? "z-ai/glm-5.3-flash";
  const tools = toolsSchema.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");
  const system = [
    "You are one villager in a deterministic medieval economy.",
    "Reply with JSON only, shaped as {\"actions\": Action[]}.",
    "Each Action has action_type and only the fields that action needs.",
    "Quantities and prices are decimal integer strings.",
    "Available actions:",
    tools,
  ].join("\n");

  const client = new OpenAI({ apiKey, baseURL });
  const completion = await client.chat.completions.create({
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: perception },
    ],
  });

  const content = completion.choices[0]?.message.content;
  if (content === undefined || content === null || content.length === 0) {
    throw new Error("NEAR AI returned an empty completion");
  }

  const decoded: unknown = JSON.parse(content);
  let candidate: unknown;
  if (Array.isArray(decoded)) {
    candidate = decoded;
  } else if (typeof decoded === "object" && decoded !== null && "actions" in decoded) {
    candidate = decoded.actions;
  } else {
    throw new TypeError("NEAR AI completion must be an action array or {\"actions\": []}");
  }

  return parseActions(candidate);
}
