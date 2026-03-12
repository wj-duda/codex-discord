export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: TParams;
}

export interface JsonRpcSuccess<TResult = unknown> {
  jsonrpc: "2.0";
  id: number;
  result: TResult;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number | null;
  error: JsonRpcErrorObject;
}

export interface JsonRpcNotification<TParams = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: TParams;
}

export type JsonRpcIncomingMessage<TResult = unknown, TParams = unknown> =
  | JsonRpcSuccess<TResult>
  | JsonRpcFailure
  | JsonRpcNotification<TParams>
  | JsonRpcRequest<TParams>;

export function isJsonRpcSuccess(message: JsonRpcIncomingMessage): message is JsonRpcSuccess {
  return "id" in message && "result" in message;
}

export function isJsonRpcFailure(message: JsonRpcIncomingMessage): message is JsonRpcFailure {
  return "error" in message;
}

export function isJsonRpcRequest(message: JsonRpcIncomingMessage): message is JsonRpcRequest {
  return "id" in message && "method" in message && !("result" in message) && !("error" in message);
}

export function isJsonRpcNotification(
  message: JsonRpcIncomingMessage,
): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}
