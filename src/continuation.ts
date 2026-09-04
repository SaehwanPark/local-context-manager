import { randomUUID } from "node:crypto";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  convertToLlm,
  serializeConversation,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";

export const DEFAULT_CONTINUATION_CONTEXT_CHARS = 24_000;

export type ContinuationModelContext = Pick<ExtensionCommandContext, "model" | "modelRegistry">;

export function getActiveConversationText(ctx: ExtensionCommandContext): string {
  const messages = ctx.sessionManager
    .buildContextEntries()
    .flatMap((entry) => sessionEntryToContextMessages(entry));
  if (messages.length === 0) {
    return "";
  }
  return serializeConversation(convertToLlm(messages));
}

export function limitText(text: string, maxChars: number, omissionLabel: string): string {
  const boundedMaxChars = Math.max(1, Math.floor(maxChars));
  if (text.length <= boundedMaxChars) {
    return text;
  }
  const headLength = Math.floor(boundedMaxChars * 0.65);
  const tailLength = boundedMaxChars - headLength;
  return `${text.slice(0, headLength)}\n\n[${omissionLabel} omitted ${text.length - boundedMaxChars} characters.]\n\n${text.slice(-tailLength)}`;
}

export function cleanReason(value: string | undefined): string | undefined {
  const reason = value
    ?.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return reason ? reason.slice(0, 240) : undefined;
}

export async function callContinuationModel(
  ctx: ContinuationModelContext,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal,
  maxTokens: number,
): Promise<string> {
  const model = ctx.model;
  if (!model) {
    throw new Error("No model selected");
  }

  const response = await ctx.modelRegistry.complete(
    model,
    {
      systemPrompt,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: userPrompt }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      signal,
      maxTokens: model.maxTokens > 0 ? Math.min(maxTokens, model.maxTokens) : maxTokens,
      cacheRetention: "none",
      sessionId: randomUUID(),
    },
  );

  if (response.stopReason === "aborted") {
    throw new Error("Generation cancelled");
  }
  if (response.stopReason === "error" || response.stopReason === "length") {
    throw new Error(response.errorMessage ?? "Generation did not complete");
  }

  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (!text) {
    throw new Error("Generation returned an empty result");
  }
  return text;
}

export function validateStructuredOutput(
  text: string,
  requiredHeadings: readonly string[],
  label: string,
): string {
  const normalized = text.trim();
  if (!normalized) {
    throw new Error(`${label} generation returned an empty result`);
  }
  const lines = normalized.split(/\r?\n/);
  let nextHeadingLine = 0;
  for (let index = 0; index < requiredHeadings.length; index += 1) {
    const heading = requiredHeadings[index];
    const headingLine = lines.findIndex(
      (line, lineIndex) => lineIndex >= nextHeadingLine && line.trim() === heading,
    );
    if (headingLine < 0) {
      if (index === 0) {
        throw new Error(`${label} generation returned an unexpected preamble`);
      }
      throw new Error(`${label} generation returned incomplete structured output`);
    }
    if (index === 0 && headingLine !== 0) {
      throw new Error(`${label} generation returned an unexpected preamble`);
    }
    nextHeadingLine = headingLine + 1;
  }
  return normalized;
}
