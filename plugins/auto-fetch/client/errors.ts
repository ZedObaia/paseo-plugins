/** An RPC error's message without the request details Paseo appends to it. */
export const errorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error))
    .replace(/ requestType=.*$/, "")
    .replace(/^Request failed: /, "");
