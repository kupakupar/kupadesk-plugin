export function onRequest(body, ctx) {
  if (ctx?.options?.enabled === false) return body;
  // Bootstrap has no injection implementation. Preserve the original request
  // while activation is pending; licensing is enforced by the private core.
  return body;
}
