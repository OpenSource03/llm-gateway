export type ResponsesInputContent =
  | { type: "input_text" | "output_text"; text: string }
  | {
      type: "input_image";
      image_url: string;
      detail?: "auto" | "low" | "high";
    };

export type ResponsesInputItem =
  | {
      type: "message";
      role: "user" | "assistant" | "developer";
      content: ResponsesInputContent[];
    }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export interface ResponsesRequest {
  model: string;
  input: ResponsesInputItem[];
  stream: boolean;
  instructions?: string;
  tools?: Array<{
    type: "function";
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  }>;
  tool_choice?: string | { type: "function"; name: string };
  reasoning?: { effort?: string; summary?: "auto" | "concise" | "detailed" };
  include?: string[];
  max_output_tokens?: number;
  prompt_cache_key?: string;
  [key: string]: unknown;
}

export interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  output_tokens_details?: { reasoning_tokens?: number };
}
