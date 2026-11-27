import {initialize} from './boot.mjs';
export default async function KupaDesk(input,options={}) {
  // Magpie registers plugins on a deadline. Request readiness is checked
  // separately by boot.mjs and the synchronous guard.
  void initialize(input,options).catch(()=>{
    try {void input?.client?.app?.log?.({body:{service:'kupadesk-loader',level:'warn',message:'private_core_unavailable'}})?.catch?.(()=>{});}catch {}
  });
  return {};
}
