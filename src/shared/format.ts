export function formatSuccess(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data) }]
  };
}

export function formatError(error: any) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: error?.message || String(error) }]
  };
}
