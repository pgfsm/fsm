export const toJsonbParam = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch (err) {
    console.error("Failed to stringify JSON param:", err);
    return null;
  }
};
