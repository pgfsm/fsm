import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode, StatusCode } from "hono/utils/http-status";

import { INTERNAL_SERVER_ERROR, OK } from "../http-status-codes.ts";

const onError: ErrorHandler = (err, c) => {
  const currentStatus = "status" in err
    ? err.status
    : c.newResponse(null).status;
  const statusCode = currentStatus !== OK
    ? (currentStatus as StatusCode)
    : INTERNAL_SERVER_ERROR;
  // eslint-disable-next-line node/prefer-global/process
  const env = c.env?.NODE_ENV || process.env?.NODE_ENV;
  return c.json(
    {
      message: err.message,

      stack: env === "production" ? undefined : err.stack,
    },
    // c.json requires a contentful (body-bearing) status; statusCode is a
    // broader StatusCode union in this vendored middleware.
    statusCode as ContentfulStatusCode,
  );
};

export default onError;
