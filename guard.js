export function onRequest(body, ctx) {
  if (ctx?.options?.enabled === false) return body;
  ctx.reject(503, 'KupaDesk：私有核心尚未就绪，核心注入已停用。请使用安装器激活，或等待授权更新完成。');
  return body;
}
