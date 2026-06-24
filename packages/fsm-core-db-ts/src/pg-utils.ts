import { getLogger } from "@logtape/logtape";

const logger = getLogger(["@pgfsm/db"]);

export const toJsonbParam = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch (err) {
    logger.error("Failed to stringify JSON param: {error}", { error: err });
    return null;
  }
};
