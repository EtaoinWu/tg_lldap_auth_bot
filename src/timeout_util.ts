export const timeout = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const timeout_error = (ms: number) => new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), ms));
